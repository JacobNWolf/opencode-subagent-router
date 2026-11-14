import type { Catalog, Model as ModelsDevModel } from '@opencode-ai/models';
import { compact as compactArray, minBy, omit, uniqBy } from 'es-toolkit';

import { compact } from '../compact';
import {
  canonicalIdentityOf,
  preservesCapabilities,
  resolveCanonicalID,
  sameGeneration,
  upstreamProviderOf,
} from './identity';
import { cheapestChain, marketCost, priceScheduleOf, scheduleIsStrictlyCheaper } from './pricing';
import type {
  CostEstimate,
  EnabledModel,
  ModelProfile,
  ModelRef,
  PriceSchedule,
  ResolveContext,
  Route,
  RouteTarget,
} from './types';

export type { EnabledModel, ModelRef, ResolveContext, Route } from './types';

const EFFORT = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORT)[number];

const marketCostsByCatalog = new WeakMap<Catalog, Map<string, CostEstimate>>();

function parseModel(id: string): ModelRef | undefined {
  const separator = id.indexOf('/');
  if (separator <= 0 || separator === id.length - 1) return undefined;

  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) };
}

function variantMatches(routeVariant: string | readonly string[] | undefined, parentVariant?: string): boolean {
  if (routeVariant === undefined) return true;

  const actual = parentVariant ?? 'default';
  if (typeof routeVariant === 'string') return routeVariant === actual;
  return routeVariant.includes(actual);
}

function routeRung(target: RouteTarget): ModelRef | undefined {
  const fast = parseModel(target.model);
  if (!fast || target.variant === undefined) return fast;
  return { ...fast, variant: target.variant };
}

/** Last matching route with at least one parseable target wins. Omit `parent.variant` to match every variant. */
export function matchRoute(parent: ModelRef, routes: readonly Route[]): readonly ModelRef[] {
  const parentId = `${parent.providerID}/${parent.modelID}`;
  for (const route of routes.toReversed()) {
    if (route.parent.model !== parentId || !variantMatches(route.parent.variant, parent.variant)) continue;

    const targets = 'model' in route.fast ? [route.fast] : route.fast;
    const rungs = compactArray(targets.map(routeRung));
    if (rungs.length > 0) return rungs;
  }
  return [];
}

function effortRank(value?: string): number {
  const rank = EFFORT.indexOf((value ?? 'medium') as Effort);
  if (rank === -1) return EFFORT.indexOf('medium');
  return rank;
}

function sameSelectableModel(enabled: EnabledModel, ref: ModelRef): boolean {
  return enabled.providerID === ref.providerID && enabled.modelID === ref.modelID;
}

function isValidOverride(parent: ModelRef, override: ModelRef): boolean {
  const sameModel = override.providerID === parent.providerID && override.modelID === parent.modelID;
  return !sameModel || effortRank(override.variant) < effortRank(parent.variant);
}

function targetRef(enabled: EnabledModel): ModelRef {
  return {
    providerID: enabled.providerID,
    modelID: enabled.modelID,
    ...(enabled.variants.has('low') ? { variant: 'low' } : {}),
  };
}

function uniqueSourceModel(enabled: EnabledModel, catalog: Catalog): ModelsDevModel | undefined {
  const provider = catalog.providers[enabled.providerID];
  if (!provider) return undefined;

  const hits = uniqBy(
    compactArray([provider.models[enabled.modelID], enabled.sourceID ? provider.models[enabled.sourceID] : undefined]),
    (model) => model.id,
  );

  if (hits.length !== 1) return undefined;
  return hits[0];
}

/** Harness providers have no Models.dev offering of their own; read the upstream lab's listing instead. */
function upstreamSourceModel(
  enabled: EnabledModel,
  canonicalID: string | undefined,
  catalog: Catalog,
): ModelsDevModel | undefined {
  const upstream = upstreamProviderOf(enabled.providerID);
  if (!upstream || !canonicalID) return undefined;
  return catalog.providers[upstream]?.models[canonicalID.slice(upstream.length + 1)];
}

function listedCostAgrees(openCode: PriceSchedule, listed: PriceSchedule): boolean {
  const openBase = openCode.bands[0]?.price;
  const listedBase = listed.bands[0]?.price;
  return (
    openBase !== undefined &&
    listedBase !== undefined &&
    openBase.input === listedBase.input &&
    openBase.output === listedBase.output
  );
}

/** Prefer Models.dev list prices when OpenCode omits cost or reports subscription/non-list rates. */
function actualCost(enabled: EnabledModel, source: ModelsDevModel | undefined): PriceSchedule | undefined {
  const openCode = enabled.cost;
  const listed = source ? priceScheduleOf(source.cost) : undefined;
  if (openCode && listed && listedCostAgrees(openCode, listed)) return listed;
  return listed ?? openCode;
}

function withActualCost(enabled: EnabledModel, cost: PriceSchedule | undefined): EnabledModel {
  if (cost === enabled.cost) return enabled;
  if (!cost) return omit(enabled, ['cost']);
  return { ...enabled, cost };
}

function offeringAsEnabled(providerID: string, modelID: string, source: ModelsDevModel): EnabledModel {
  return {
    providerID,
    modelID,
    sourceID: source.id,
    name: source.name,
    ...(source.family === undefined ? {} : { family: source.family }),
    releaseDate: source.release_date,
    limits: source.limit,
    variants: new Set(),
  };
}

function indexMarketCosts(catalog: Catalog): Map<string, CostEstimate> {
  const grouped = new Map<string, Map<string, PriceSchedule[]>>();

  for (const provider of Object.values(catalog.providers)) {
    for (const [modelID, source] of Object.entries(provider.models)) {
      const canonicalID = resolveCanonicalID(offeringAsEnabled(provider.id, modelID, source), catalog);
      const schedule = priceScheduleOf(source.cost);
      if (!canonicalID || !schedule) continue;

      const providers = grouped.get(canonicalID) ?? new Map<string, PriceSchedule[]>();
      const aliases = providers.get(provider.id) ?? [];
      aliases.push(schedule);
      providers.set(provider.id, aliases);
      grouped.set(canonicalID, providers);
    }
  }

  const estimates = new Map<string, CostEstimate>();
  for (const [canonicalID, providers] of grouped) {
    const estimate = marketCost(providers);
    if (estimate) estimates.set(canonicalID, estimate);
  }
  return estimates;
}

function familyOf(
  enabled: EnabledModel,
  source: ModelsDevModel | undefined,
  canonicalID: string | undefined,
  catalog: Catalog,
): string | undefined {
  if (enabled.family !== undefined) return enabled.family;
  if (source?.family !== undefined) return source.family;
  if (!canonicalID) return undefined;
  return catalog.models[canonicalID]?.family;
}

function buildProfiles(enabledModels: readonly EnabledModel[], catalog: Catalog): ModelProfile[] {
  let market = marketCostsByCatalog.get(catalog);

  if (!market) {
    market = indexMarketCosts(catalog);
    marketCostsByCatalog.set(catalog, market);
  }

  return enabledModels.map((enabled) => {
    const canonicalID = resolveCanonicalID(enabled, catalog);
    const source = uniqueSourceModel(enabled, catalog) ?? upstreamSourceModel(enabled, canonicalID, catalog);
    const family = familyOf(enabled, source, canonicalID, catalog);
    const canonical = canonicalID ? canonicalIdentityOf(canonicalID, family) : undefined;
    const cost = actualCost(enabled, source);
    const marketEstimate = canonical ? market.get(canonical.id) : undefined;

    return compact({
      enabled: withActualCost(enabled, cost),
      source,
      canonical,
      marketCost: marketEstimate,
    });
  });
}

function parentUnresolved(parent: ModelProfile | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!parent) return { crossModel: 'parent_not_in_catalog' };

  if (parent.source?.type === 'decision') return { crossModel: 'parent_decision_model' };

  const missing = compactArray([
    parent.canonical ? undefined : 'canonical',
    parent.enabled.cost ? undefined : 'cost',
    parent.enabled.limits ? undefined : 'limits',
    parent.marketCost ? undefined : 'market_cost',
  ]);
  if (missing.length === 0) return undefined;

  return { crossModel: 'parent_unresolved', missing };
}

function candidateSkip(parent: ModelProfile, candidate: ModelProfile, parentRef: ModelRef): string | undefined {
  if (sameSelectableModel(candidate.enabled, parentRef)) return undefined;
  if (candidate.enabled.providerID !== parent.enabled.providerID) return 'different_provider';

  if (!candidate.canonical) return 'missing_canonical';
  if (!candidate.enabled.cost) return 'missing_cost';
  if (!candidate.marketCost) return 'missing_market_cost';
  if (candidate.source?.type === 'decision') return 'decision_model';

  if (!sameGeneration(candidate.canonical, parent.canonical!)) return 'different_generation';
  if (!preservesCapabilities(parent.enabled, candidate.enabled)) return 'capabilities';

  if (!scheduleIsStrictlyCheaper(candidate.enabled.cost, parent.enabled.cost!, parent.enabled.limits!.context)) {
    return 'actual_cost';
  }
  if (
    !scheduleIsStrictlyCheaper(
      candidate.marketCost.schedule,
      parent.marketCost!.schedule,
      parent.enabled.limits!.context,
    )
  ) {
    return 'market_cost';
  }

  return undefined;
}

function releaseOf(profile: ModelProfile): string {
  return profile.source?.release_date ?? profile.enabled.releaseDate ?? '';
}

function isSuperseded(candidate: ModelProfile, pool: readonly ModelProfile[]): boolean {
  return pool.some(
    (other) => other.canonical!.family === candidate.canonical!.family && releaseOf(other) > releaseOf(candidate),
  );
}

function resolveCrossModel(
  parentRef: ModelRef,
  enabledModels: readonly EnabledModel[],
  catalog: Catalog,
): {
  readonly rungs: readonly ModelRef[];
  readonly legacyModels?: readonly EnabledModel[];
  readonly details?: Readonly<Record<string, unknown>>;
} {
  const profiles = buildProfiles(enabledModels, catalog);
  const parent = profiles.find((profile) => sameSelectableModel(profile.enabled, parentRef));
  const unresolved = parentUnresolved(parent);
  if (unresolved || !parent) return { rungs: [], details: unresolved ?? { crossModel: 'parent_not_in_catalog' } };

  const eligible = profiles.filter(
    (candidate) =>
      candidateSkip(parent, candidate, parentRef) === undefined && !sameSelectableModel(candidate.enabled, parentRef),
  );

  const pool = [parent, ...eligible];
  const candidates = eligible.filter((candidate) => !isSuperseded(candidate, pool));

  const chain = cheapestChain(candidates, parent.enabled.limits!.context);
  if (chain.length === 0) {
    const excluded = profiles.filter(
      (profile) =>
        candidateSkip(parent, profile, parentRef) === 'capabilities' ||
        (eligible.includes(profile) && !candidates.includes(profile)),
    );
    const legacyModels = enabledModels.filter(
      (model) => !excluded.some((profile) => sameSelectableModel(model, profile.enabled)),
    );

    return {
      rungs: [],
      legacyModels,
      details: { crossModel: candidates.length === 0 ? 'no_eligible_candidate' : 'no_unique_cheapest' },
    };
  }

  const superseded = eligible.length - candidates.length;
  const dropped = candidates.length - chain.length;
  const rungs = chain.map((candidate) => targetRef(candidate.enabled));
  if (superseded === 0 && dropped === 0) return { rungs };

  const details: Record<string, unknown> = {};
  if (superseded > 0) details.superseded = superseded;
  if (dropped > 0) {
    details.crossModel = 'incomparable_candidates';
    details.dropped = dropped;
  }

  return { rungs, details };
}

function resolveLowEffort(parent: ModelRef, enabledModels: readonly EnabledModel[]): ModelRef | undefined {
  const self = enabledModels.find((model) => sameSelectableModel(model, parent));
  if (effortRank(parent.variant) < effortRank('high') || !self?.variants.has('low')) return undefined;
  return { ...parent, variant: 'low' };
}

function legacyInputCost(model: EnabledModel): number {
  return model.cost?.bands[0]?.price.input ?? Number.POSITIVE_INFINITY;
}

function resolveLegacySibling(parent: ModelRef, enabledModels: readonly EnabledModel[]): ModelRef | undefined {
  const self = enabledModels.find((model) => sameSelectableModel(model, parent));
  if (!self?.family) return undefined;

  const cheap = minBy(
    enabledModels.filter(
      (model) =>
        model.providerID === parent.providerID &&
        model.family === self.family &&
        model.capabilities?.toolCall === true &&
        model.status !== 'deprecated' &&
        legacyInputCost(model) < legacyInputCost(self),
    ),
    legacyInputCost,
  );
  if (!cheap) return undefined;
  return targetRef(cheap);
}

export type FastResolution = {
  /** Cheapest first; empty when no fast target exists. */
  readonly rungs: readonly ModelRef[];
  readonly reason:
    | 'explicit_route'
    | 'same_generation_cheaper'
    | 'same_model_low'
    | 'exact_family_sibling'
    | 'no_fast_target';
  readonly details?: Readonly<Record<string, unknown>>;
};

export function resolveFastDecision(
  parent: ModelRef,
  enabledModels: readonly EnabledModel[],
  context: ResolveContext = {},
): FastResolution {
  const override = matchRoute(parent, context.routes ?? []).filter((rung) => isValidOverride(parent, rung));
  if (override.length > 0) return { rungs: override, reason: 'explicit_route' };

  const crossModel = context.modelsDev
    ? resolveCrossModel(parent, enabledModels, context.modelsDev)
    : { rungs: [], legacyModels: enabledModels, details: { crossModel: 'models_dev_unavailable' } };
  const details = crossModel.details === undefined ? {} : { details: crossModel.details };
  if (crossModel.rungs.length > 0) {
    return { rungs: crossModel.rungs, reason: 'same_generation_cheaper', ...details };
  }

  const lowEffort = resolveLowEffort(parent, enabledModels);
  if (lowEffort) return { rungs: [lowEffort], reason: 'same_model_low', ...details };

  const sibling = resolveLegacySibling(parent, crossModel.legacyModels ?? enabledModels);
  if (sibling) return { rungs: [sibling], reason: 'exact_family_sibling', ...details };

  return { rungs: [], reason: 'no_fast_target', ...details };
}

export function resolveFast(
  parent: ModelRef,
  enabledModels: readonly EnabledModel[],
  context: ResolveContext = {},
): ModelRef | undefined {
  return resolveFastDecision(parent, enabledModels, context).rungs[0];
}
