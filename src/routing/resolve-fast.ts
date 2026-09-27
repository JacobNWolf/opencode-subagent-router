import type { Catalog, Model as ModelsDevModel } from '@opencode-ai/models/effect';
import { compact, last, minBy, omit, uniqBy } from 'es-toolkit';

import { canonicalIdentityOf, preservesCapabilities, resolveCanonicalID, sameGeneration } from './identity';
import { marketCost, priceScheduleOf, scheduleIsStrictlyCheaper, uniqueCheapest } from './pricing';
import type { CostEstimate, EnabledModel, ModelProfile, ModelRef, PriceSchedule, ResolveContext, Route } from './types';

export type { EnabledModel, ModelRef, ResolveContext, Route } from './types';

const EFFORT = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORT)[number];

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

/** Last matching route wins. Omit `parent.variant` to match every variant of that model. */
export function matchRoute(parent: ModelRef, routes: readonly Route[]): ModelRef | undefined {
  const parentId = `${parent.providerID}/${parent.modelID}`;
  return last(
    compact(
      routes.map((route): ModelRef | undefined => {
        if (route.parent.model !== parentId || !variantMatches(route.parent.variant, parent.variant)) return undefined;

        const fast = parseModel(route.fast.model);
        if (!fast) return undefined;
        if (route.fast.variant === undefined) return fast;
        return { ...fast, variant: route.fast.variant };
      }),
    ),
  );
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
    compact([provider.models[enabled.modelID], enabled.sourceID ? provider.models[enabled.sourceID] : undefined]),
    (model) => model.id,
  );

  if (hits.length !== 1) return undefined;
  return hits[0];
}

function actualCost(enabled: EnabledModel, source: ModelsDevModel | undefined): PriceSchedule | undefined {
  const openCode = enabled.cost;
  if (!openCode) return undefined;
  if (!source) return openCode;

  const matched = priceScheduleOf(source.cost);
  if (!matched) return openCode;

  const openBase = openCode.bands[0]?.price;
  const matchedBase = matched.bands[0]?.price;
  if (!openBase || !matchedBase) return undefined;
  if (openBase.input !== matchedBase.input || openBase.output !== matchedBase.output) return undefined;
  return matched;
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
  const market = indexMarketCosts(catalog);
  return enabledModels.map((enabled) => {
    const canonicalID = resolveCanonicalID(enabled, catalog);
    const source = uniqueSourceModel(enabled, catalog);
    const family = familyOf(enabled, source, canonicalID, catalog);
    const canonical = canonicalID ? canonicalIdentityOf(canonicalID, family) : undefined;
    const cost = actualCost(enabled, source);
    const marketEstimate = canonical ? market.get(canonical.id) : undefined;
    return {
      enabled: withActualCost(enabled, cost),
      ...(source === undefined ? {} : { source }),
      ...(canonical === undefined ? {} : { canonical }),
      ...(marketEstimate === undefined ? {} : { marketCost: marketEstimate }),
    };
  });
}

function generationLabel(identity: { lab: string; lineage: string; generation: number }): string {
  return `${identity.lab}:${identity.lineage}:${identity.generation}`;
}

function costBands(schedule: PriceSchedule) {
  return schedule.bands.map((band) => ({
    fromContext: band.fromContext,
    input: band.price.input,
    output: band.price.output,
  }));
}

function modelDetails(profile: ModelProfile) {
  return {
    selectable: `${profile.enabled.providerID}/${profile.enabled.modelID}`,
    ...(profile.canonical === undefined
      ? {}
      : {
          canonical: profile.canonical.id,
          generation: generationLabel(profile.canonical),
        }),
    ...(profile.enabled.cost === undefined ? {} : { actualCost: costBands(profile.enabled.cost) }),
    ...(profile.marketCost === undefined ? {} : { marketMedianCost: costBands(profile.marketCost.schedule) }),
  };
}

function resolveCrossModel(
  parentRef: ModelRef,
  enabledModels: readonly EnabledModel[],
  catalog: Catalog,
): { readonly target: ModelRef; readonly details: Readonly<Record<string, unknown>> } | undefined {
  const profiles = buildProfiles(enabledModels, catalog);
  const parent = profiles.find((profile) => sameSelectableModel(profile.enabled, parentRef));
  if (!parent?.canonical || !parent.enabled.cost || !parent.enabled.limits || !parent.marketCost) return undefined;
  if (parent.source?.type === 'decision') return undefined;

  const candidates = profiles.filter((candidate) => {
    if (!candidate.canonical || !candidate.enabled.cost || !candidate.marketCost) return false;
    if (candidate.source?.type === 'decision') return false;
    if (sameSelectableModel(candidate.enabled, parentRef)) return false;
    if (candidate.enabled.providerID !== parent.enabled.providerID) return false;
    if (!sameGeneration(candidate.canonical, parent.canonical!)) return false;
    if (!preservesCapabilities(parent.enabled, candidate.enabled)) return false;
    if (!scheduleIsStrictlyCheaper(candidate.enabled.cost, parent.enabled.cost!, parent.enabled.limits!.context)) {
      return false;
    }
    return scheduleIsStrictlyCheaper(
      candidate.marketCost.schedule,
      parent.marketCost!.schedule,
      parent.enabled.limits!.context,
    );
  });

  const target = uniqueCheapest(candidates, parent.enabled.limits.context);
  if (!target) return undefined;

  return {
    target: targetRef(target.enabled),
    details: {
      reason: 'same_generation_cheaper',
      parent: modelDetails(parent),
      target: modelDetails(target),
    },
  };
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
  readonly target?: ModelRef;
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
  const override = matchRoute(parent, context.routes ?? []);
  if (override && isValidOverride(parent, override)) {
    return { target: override, reason: 'explicit_route' };
  }

  if (context.modelsDev) {
    const crossModel = resolveCrossModel(parent, enabledModels, context.modelsDev);
    if (crossModel) {
      return { target: crossModel.target, reason: 'same_generation_cheaper', details: crossModel.details };
    }
  }

  const lowEffort = resolveLowEffort(parent, enabledModels);
  if (lowEffort) return { target: lowEffort, reason: 'same_model_low' };

  const sibling = resolveLegacySibling(parent, enabledModels);
  if (sibling) return { target: sibling, reason: 'exact_family_sibling' };

  return { reason: 'no_fast_target' };
}

export function resolveFast(
  parent: ModelRef,
  enabledModels: readonly EnabledModel[],
  context: ResolveContext = {},
): ModelRef | undefined {
  return resolveFastDecision(parent, enabledModels, context).target;
}
