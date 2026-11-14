import { describe, expect, test } from 'bun:test';

import type { Catalog, Model, ModelCost, ModelFamily, ModelMetadata } from '@opencode-ai/models';
import { omit } from 'es-toolkit';

import { matchRoute, resolveFast, resolveFastDecision } from '../../src/routing/resolve-fast';
import type { EnabledModel, ModelRef, PriceSchedule, Route } from '../../src/routing/types';

const sol: ModelRef = { providerID: 'openai', modelID: 'gpt-sol', variant: 'high' };

const capabilities = {
  attachment: true,
  reasoning: true,
  toolCall: true,
  structuredOutput: true,
  input: new Set(['text'] as const),
  output: new Set(['text'] as const),
};

function baseSchedule(input: number, output: number): PriceSchedule {
  return { bands: [{ fromContext: 0, price: { input, output } }] };
}

function enabledModel(
  providerID: string,
  modelID: string,
  cost: PriceSchedule,
  overrides: Omit<Partial<EnabledModel>, 'providerID' | 'modelID' | 'cost'> = {},
): EnabledModel {
  return {
    providerID,
    modelID,
    sourceID: modelID,
    name: modelID,
    family: 'nebula-tier',
    releaseDate: '2030-01-01',
    status: 'active',
    cost,
    capabilities,
    limits: { context: 100_000, output: 16_000 },
    variants: new Set(['low', 'high']),
    ...overrides,
  };
}

function legacyModel(
  providerID: string,
  modelID: string,
  overrides: Omit<Partial<EnabledModel>, 'providerID' | 'modelID'> = {},
): EnabledModel {
  return {
    providerID,
    modelID,
    variants: new Set(),
    ...overrides,
  };
}

const self = legacyModel('openai', 'gpt-sol', {
  family: 'gpt',
  capabilities: { ...capabilities, toolCall: true },
  cost: baseSchedule(10, 10),
  variants: new Set(['low', 'high']),
});

function metadata(id: string, family: string): ModelMetadata {
  const name = id.slice(id.indexOf('/') + 1);
  return {
    id,
    name,
    description: id,
    family: family as ModelFamily,
    release_date: '2030-01-01',
    limit: { context: 100_000 },
  };
}

function providerModel(id: string, family: string, cost: ModelCost, overrides: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    description: id,
    family: family as ModelFamily,
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    release_date: '2030-01-01',
    last_updated: '2030-01-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    limit: { context: 100_000, output: 16_000 },
    cost,
    ...overrides,
  };
}

function syntheticCatalog(
  entries: readonly {
    readonly canonicalID: string;
    readonly family: string;
    readonly cost: ModelCost;
    readonly releaseDate?: string;
    readonly providerID?: string;
    readonly modelID?: string;
  }[],
): Catalog {
  const models: Record<string, ModelMetadata> = {};
  const providers: Catalog['providers'] = {};

  for (const entry of entries) {
    const released = entry.releaseDate === undefined ? {} : { release_date: entry.releaseDate };
    models[entry.canonicalID] = { ...metadata(entry.canonicalID, entry.family), ...released };
    const providerID = entry.providerID ?? entry.canonicalID.slice(0, entry.canonicalID.indexOf('/'));
    const modelID = entry.modelID ?? entry.canonicalID.slice(entry.canonicalID.indexOf('/') + 1);
    const provider = providers[providerID] ?? {
      id: providerID,
      env: [],
      npm: 'none',
      name: providerID,
      doc: 'https://example.test',
      models: {},
    };
    provider.models[modelID] = providerModel(modelID, entry.family, entry.cost, released);
    providers[providerID] = provider;
  }

  return { models, providers };
}

describe('matchRoute', () => {
  test('uses the last wildcard or variant match', () => {
    const routes: Route[] = [
      { parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-luna', variant: 'low' } },
      {
        parent: { model: 'openai/gpt-sol', variant: ['high', 'max'] },
        fast: { model: 'openai/gpt-terra' },
      },
    ];
    expect(matchRoute(sol, routes)).toEqual([{ providerID: 'openai', modelID: 'gpt-terra' }]);
    expect(matchRoute({ ...sol, variant: 'medium' }, routes)).toEqual([
      {
        providerID: 'openai',
        modelID: 'gpt-luna',
        variant: 'low',
      },
    ]);
  });

  test('supports string and implicit default variants', () => {
    const route: Route = {
      parent: { model: 'openai/gpt-sol', variant: 'default' },
      fast: { model: 'openai/gpt-luna' },
    };
    expect(matchRoute({ providerID: 'openai', modelID: 'gpt-sol' }, [route])).toEqual([
      {
        providerID: 'openai',
        modelID: 'gpt-luna',
      },
    ]);
    expect(matchRoute(sol, [{ ...route, parent: { ...route.parent, variant: 'low' } }])).toEqual([]);
  });

  test('ignores unrelated and malformed targets', () => {
    const routes: Route[] = [
      { parent: { model: 'other/gpt-sol' }, fast: { model: 'openai/gpt-luna' } },
      { parent: { model: 'openai/gpt-sol' }, fast: { model: '/missing-provider' } },
      { parent: { model: 'openai/gpt-sol' }, fast: { model: 'missing-model/' } },
    ];
    expect(matchRoute(sol, routes)).toEqual([]);
  });

  test('falls back past malformed targets without changing the configured route order', () => {
    const routes: Route[] = [
      { parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-luna' } },
      { parent: { model: 'openai/gpt-sol' }, fast: [{ model: '/missing-provider' }] },
    ];
    const original = routes.slice();
    expect(matchRoute(sol, routes)).toEqual([{ providerID: 'openai', modelID: 'gpt-luna' }]);
    expect(routes).toEqual(original);
  });
});

describe('resolveFast', () => {
  test('prefers a model or provider override', () => {
    expect(
      resolveFast(sol, [self], {
        routes: [{ parent: { model: 'openai/gpt-sol' }, fast: { model: 'other/gpt-luna' } }],
      }),
    ).toEqual({ providerID: 'other', modelID: 'gpt-luna' });
    expect(
      resolveFast(sol, [self], {
        routes: [{ parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-sol', variant: 'low' } }],
      }),
    ).toEqual({ ...sol, variant: 'low' });
  });

  test('rejects a same-or-higher override and lowers a high parent variant', () => {
    expect(
      resolveFast(sol, [self], {
        routes: [{ parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-sol', variant: 'max' } }],
      }),
    ).toEqual({ ...sol, variant: 'low' });
    expect(resolveFast({ ...sol, variant: 'unexpected' }, [self])).toBeUndefined();
  });

  test('returns nothing without parent family metadata', () => {
    expect(resolveFast({ providerID: 'openai', modelID: 'unknown' }, [])).toBeUndefined();
    expect(
      resolveFast({ providerID: 'openai', modelID: 'gpt-sol' }, [
        legacyModel('openai', 'gpt-sol', { cost: baseSchedule(10, 10) }),
      ]),
    ).toBeUndefined();
  });

  test('chooses the cheapest eligible same-family sibling', () => {
    const catalog: EnabledModel[] = [
      self,
      legacyModel('other', 'wrong-provider', { family: 'gpt', cost: baseSchedule(0, 0) }),
      legacyModel('openai', 'wrong-family', { family: 'other', cost: baseSchedule(0, 0) }),
      legacyModel('openai', 'no-tools', {
        family: 'gpt',
        capabilities: { ...capabilities, toolCall: false },
        cost: baseSchedule(0, 0),
      }),
      legacyModel('openai', 'unknown-tools', { family: 'gpt', cost: baseSchedule(0, 0) }),
      legacyModel('openai', 'old', { family: 'gpt', status: 'deprecated', cost: baseSchedule(0, 0) }),
      legacyModel('openai', 'same-price', { family: 'gpt', cost: baseSchedule(10, 10) }),
      legacyModel('openai', 'terra', {
        family: 'gpt',
        capabilities: { ...capabilities, toolCall: true },
        cost: baseSchedule(5, 5),
      }),
      legacyModel('openai', 'luna', {
        family: 'gpt',
        capabilities: { ...capabilities, toolCall: true },
        cost: baseSchedule(1, 1),
        variants: new Set(['low']),
      }),
    ];
    expect(resolveFast({ ...sol, variant: 'medium' }, catalog)).toEqual({
      providerID: 'openai',
      modelID: 'luna',
      variant: 'low',
    });
  });

  test('handles missing costs and a sibling without variants', () => {
    const expensiveWithoutCost = legacyModel('openai', 'gpt-sol', {
      family: 'gpt',
      capabilities: { ...capabilities, toolCall: true },
    });
    const cheap = legacyModel('openai', 'luna', {
      family: 'gpt',
      capabilities: { ...capabilities, toolCall: true },
      cost: baseSchedule(1, 1),
    });
    expect(resolveFast({ providerID: 'openai', modelID: 'gpt-sol' }, [expensiveWithoutCost, cheap])).toEqual({
      providerID: 'openai',
      modelID: 'luna',
    });
    expect(resolveFast({ providerID: 'openai', modelID: 'gpt-sol' }, [self])).toBeUndefined();
  });

  test('keeps catalog order when eligible siblings have equal costs', () => {
    const first = legacyModel('openai', 'first', {
      family: 'gpt',
      capabilities: { ...capabilities, toolCall: true },
      cost: baseSchedule(1, 1),
    });
    const second = legacyModel('openai', 'second', {
      family: 'gpt',
      capabilities: { ...capabilities, toolCall: true },
      cost: baseSchedule(1, 1),
    });
    expect(resolveFast({ ...sol, variant: 'medium' }, [self, first, second])).toEqual({
      providerID: 'openai',
      modelID: 'first',
    });
  });

  test('chooses a cheaper compatible model in the same inferred generation', () => {
    const parent = { providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' as const };
    const enabled = [
      enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' }),
      enabledModel('acme', 'nebula-9-middle', baseSchedule(4, 16), { family: 'nebula-middle' }),
      enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4), { family: 'nebula-small' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
      { canonicalID: 'acme/nebula-9-middle', family: 'nebula-middle', cost: { input: 4, output: 16 } },
      { canonicalID: 'acme/nebula-9-small', family: 'nebula-small', cost: { input: 1, output: 4 } },
    ]);

    expect(resolveFast(parent, enabled, { modelsDev })).toEqual({
      providerID: 'acme',
      modelID: 'nebula-9-small',
      variant: 'low',
    });
  });

  test('routes GPT-6 Astra and Sol to Luna from local naming shapes', () => {
    const enabled = [
      enabledModel('openai', 'gpt-6-astra', baseSchedule(10, 50), { family: 'gpt-astra' }),
      enabledModel('openai', 'gpt-6-sol', baseSchedule(2.5, 15), { family: 'gpt-sol' }),
      enabledModel('openai', 'gpt-6-luna', baseSchedule(0.1, 0.5), { family: 'gpt-luna' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'openai/gpt-6-astra', family: 'gpt-astra', cost: { input: 10, output: 50 } },
      { canonicalID: 'openai/gpt-6-sol', family: 'gpt-sol', cost: { input: 2.5, output: 15 } },
      { canonicalID: 'openai/gpt-6-luna', family: 'gpt-luna', cost: { input: 0.1, output: 0.5 } },
    ]);
    expect(
      resolveFast({ providerID: 'openai', modelID: 'gpt-6-astra', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({
      providerID: 'openai',
      modelID: 'gpt-6-luna',
      variant: 'low',
    });
    expect(
      resolveFast({ providerID: 'openai', modelID: 'gpt-6-sol', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({
      providerID: 'openai',
      modelID: 'gpt-6-luna',
      variant: 'low',
    });
    const astra = { providerID: 'openai', modelID: 'gpt-6-astra', variant: 'high' };
    expect(resolveFastDecision(astra, enabled, { modelsDev }).rungs).toEqual([
      { providerID: 'openai', modelID: 'gpt-6-luna', variant: 'low' },
      { providerID: 'openai', modelID: 'gpt-6-sol', variant: 'low' },
    ]);
    expect(
      resolveFastDecision({ ...astra, modelID: 'gpt-6-sol' }, enabled, { modelsDev }).rungs.map((r) => r.modelID),
    ).toEqual(['gpt-6-luna']);
  });

  test('routes Claude Fable 5.1 and Opus 5.5 to Sonnet 5', () => {
    const enabled = [
      enabledModel('anthropic', 'claude-fable-5-1', baseSchedule(5, 25), { family: 'claude-fable' }),
      enabledModel('anthropic', 'claude-opus-5-5', baseSchedule(5, 25), { family: 'claude-opus' }),
      enabledModel('anthropic', 'claude-sonnet-5', baseSchedule(1, 5), { family: 'claude-sonnet' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'anthropic/claude-fable-5-1', family: 'claude-fable', cost: { input: 5, output: 25 } },
      { canonicalID: 'anthropic/claude-opus-5-5', family: 'claude-opus', cost: { input: 5, output: 25 } },
      { canonicalID: 'anthropic/claude-sonnet-5', family: 'claude-sonnet', cost: { input: 1, output: 5 } },
    ]);
    expect(
      resolveFast({ providerID: 'anthropic', modelID: 'claude-fable-5-1', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'low' });
    expect(
      resolveFast({ providerID: 'anthropic', modelID: 'claude-opus-5-5', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'low' });
    expect(
      resolveFastDecision({ providerID: 'anthropic', modelID: 'claude-fable-5-1', variant: 'high' }, enabled, {
        modelsDev,
      }).rungs.map((r) => r.modelID),
    ).toEqual(['claude-sonnet-5']);
  });

  test('routes Claude Agent aliases with subscription pricing to the cheapest same-generation model', () => {
    const modelsDev = syntheticCatalog([
      { canonicalID: 'anthropic/claude-fable-5-1', family: 'claude-fable', cost: { input: 10, output: 50 } },
      { canonicalID: 'anthropic/claude-opus-5-5', family: 'claude-opus', cost: { input: 4, output: 20 } },
      { canonicalID: 'anthropic/claude-haiku-5-5', family: 'claude-haiku', cost: { input: 0.1, output: 0.5 } },
    ]);
    for (const [id, name] of [
      ['anthropic/claude-fable-5-1', 'Claude Fable 5.1'],
      ['anthropic/claude-opus-5-5', 'Claude Opus 5.5'],
      ['anthropic/claude-haiku-5-5', 'Claude Haiku 5.5'],
    ] as const) {
      modelsDev.models[id] = { ...modelsDev.models[id]!, name };
    }
    const agent = (modelID: string, name: string) =>
      omit(enabledModel('claude-agent', modelID, baseSchedule(0, 0), { name }), ['cost', 'family', 'releaseDate']);
    const enabled = [agent('fable', 'Fable 5.1'), agent('opus', 'Opus 5.5'), agent('haiku', 'Haiku 5.5')];

    expect(resolveFastDecision({ providerID: 'claude-agent', modelID: 'fable' }, enabled, { modelsDev })).toEqual({
      rungs: [
        { providerID: 'claude-agent', modelID: 'haiku', variant: 'low' },
        { providerID: 'claude-agent', modelID: 'opus', variant: 'low' },
      ],
      reason: 'same_generation_cheaper',
    });
    expect(resolveFastDecision({ providerID: 'claude-agent', modelID: 'opus' }, enabled, { modelsDev })).toEqual({
      rungs: [{ providerID: 'claude-agent', modelID: 'haiku', variant: 'low' }],
      reason: 'same_generation_cheaper',
    });
  });

  test('does not select an older major generation', () => {
    const enabled = [
      enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' }),
      enabledModel('acme', 'nebula-8-small', baseSchedule(1, 4), { family: 'nebula-small' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
      { canonicalID: 'acme/nebula-8-small', family: 'nebula-small', cost: { input: 1, output: 4 } },
    ]);
    expect(
      resolveFast({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' });
  });

  test('rejects a candidate that exists only on another provider', () => {
    const enabled = [
      enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' }),
      enabledModel('other', 'nebula-9-small', baseSchedule(1, 4), { family: 'nebula-small' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
      { canonicalID: 'other/nebula-9-small', family: 'nebula-small', cost: { input: 1, output: 4 } },
    ]);
    expect(
      resolveFast({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' });
  });

  test('rejects missing tools, smaller context, deprecated status, and inverted prices', () => {
    const parent = enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' });
    const modelsDev = (modelID: string, cost: ModelCost) =>
      syntheticCatalog([
        { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
        { canonicalID: `acme/${modelID}`, family: 'nebula-small', cost },
      ]);

    const noTools = enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4), {
      family: 'nebula-small',
      capabilities: { ...capabilities, toolCall: false },
    });
    expect(
      resolveFast({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, [parent, noTools], {
        modelsDev: modelsDev('nebula-9-small', { input: 1, output: 4 }),
      }),
    ).toEqual({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' });

    const smallContext = enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4), {
      family: 'nebula-small',
      limits: { context: 1_000, output: 16_000 },
    });
    expect(
      resolveFast({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, [parent, smallContext], {
        modelsDev: modelsDev('nebula-9-small', { input: 1, output: 4 }),
      }),
    ).toEqual({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' });

    const deprecated = enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4), {
      family: 'nebula-small',
      status: 'deprecated',
    });
    expect(
      resolveFast({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, [parent, deprecated], {
        modelsDev: modelsDev('nebula-9-small', { input: 1, output: 4 }),
      }),
    ).toEqual({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' });

    const inverted = enabledModel('acme', 'nebula-9-small', baseSchedule(1, 80), { family: 'nebula-small' });
    expect(
      resolveFast({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, [parent, inverted], {
        modelsDev: modelsDev('nebula-9-small', { input: 1, output: 80 }),
      }),
    ).toEqual({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' });
  });

  test('prefers cross-model over same-model low, and explicit routes over both', () => {
    const enabled = [
      enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' }),
      enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4), { family: 'nebula-small' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
      { canonicalID: 'acme/nebula-9-small', family: 'nebula-small', cost: { input: 1, output: 4 } },
    ]);
    const parent = { providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' as const };
    expect(resolveFast(parent, enabled, { modelsDev })).toEqual({
      providerID: 'acme',
      modelID: 'nebula-9-small',
      variant: 'low',
    });
    expect(
      resolveFast(parent, enabled, {
        modelsDev,
        routes: [{ parent: { model: 'acme/nebula-9-grand' }, fast: { model: 'other/forced' } }],
      }),
    ).toEqual({ providerID: 'other', modelID: 'forced' });
  });

  test('falls back to same-model low when metadata is absent', () => {
    const enabled = [enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' })];
    const parent = { providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' as const };
    expect(resolveFast(parent, enabled)).toEqual({
      providerID: 'acme',
      modelID: 'nebula-9-grand',
      variant: 'low',
    });
    expect(resolveFastDecision(parent, enabled).details).toEqual({ crossModel: 'models_dev_unavailable' });
  });

  test('uses Models.dev list prices when OpenCode reports subscription cost', () => {
    const modelsDev = syntheticCatalog([
      { canonicalID: 'openai/gpt-5.6-sol', family: 'gpt-sol', cost: { input: 4, output: 20 } },
      { canonicalID: 'openai/gpt-5.6-luna', family: 'gpt-luna', cost: { input: 0.2, output: 1.2 } },
    ]);
    const parent = { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' as const };
    const luna = enabledModel('openai', 'gpt-5.6-luna', baseSchedule(0, 0), { family: 'gpt-luna' });
    const subscribed = enabledModel('openai', 'gpt-5.6-sol', baseSchedule(0, 0), { family: 'gpt-sol' });
    expect(resolveFast(parent, [subscribed, luna], { modelsDev })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
      variant: 'low',
    });
  });

  test('explains why a cheaper model in another major is not selected', () => {
    const enabled = [
      enabledModel('openai', 'gpt-5.6-sol', baseSchedule(4, 20), { family: 'gpt-sol' }),
      enabledModel('openai', 'gpt-6-luna', baseSchedule(0.1, 0.5), { family: 'gpt-luna' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'openai/gpt-5.6-sol', family: 'gpt-sol', cost: { input: 4, output: 20 } },
      { canonicalID: 'openai/gpt-6-luna', family: 'gpt-luna', cost: { input: 0.1, output: 0.5 } },
    ]);
    const decision = resolveFastDecision({ providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' }, enabled, {
      modelsDev,
    });
    expect(decision).toMatchObject({
      reason: 'same_model_low',
      rungs: [{ providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'low' }],
      details: { crossModel: 'no_eligible_candidate' },
    });
  });

  test('fills family from source or canonical metadata', () => {
    const parent = { providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' as const };
    const enabled = [
      enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48)),
      enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4)),
    ].map((model) => omit(model, ['family']));
    const modelsDev = syntheticCatalog([
      { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
      { canonicalID: 'acme/nebula-9-small', family: 'nebula-small', cost: { input: 1, output: 4 } },
    ]);
    const cheaper = { providerID: 'acme', modelID: 'nebula-9-small', variant: 'low' };

    expect(resolveFast(parent, enabled, { modelsDev })).toEqual(cheaper);

    const sourceWithoutFamily = structuredClone(modelsDev);
    for (const provider of Object.values(sourceWithoutFamily.providers)) {
      for (const model of Object.values(provider.models)) {
        delete (model as { family?: string }).family;
      }
    }
    expect(resolveFast(parent, enabled, { modelsDev: sourceWithoutFamily })).toEqual(cheaper);

    const unresolved = { ...sourceWithoutFamily, models: {} };
    expect(resolveFast(parent, enabled, { modelsDev: unresolved })).toEqual({
      providerID: 'acme',
      modelID: 'nebula-9-grand',
      variant: 'low',
    });
  });

  test('rejects a cheaper list price that is not cheaper on the market', () => {
    const enabled = [
      enabledModel('acme', 'nebula-9-grand', baseSchedule(12, 48), { family: 'nebula-grand' }),
      enabledModel('acme', 'nebula-9-small', baseSchedule(1, 4), { family: 'nebula-small' }),
    ];
    const modelsDev = structuredClone(
      syntheticCatalog([
        { canonicalID: 'acme/nebula-9-grand', family: 'nebula-grand', cost: { input: 12, output: 48 } },
        { canonicalID: 'acme/nebula-9-small', family: 'nebula-small', cost: { input: 1, output: 4 } },
      ]),
    );
    const expensive = providerModel('nebula-9-small', 'nebula-small', { input: 20, output: 80 });
    for (const id of ['other', 'third']) {
      modelsDev.providers[id] = {
        id,
        env: [],
        npm: 'none',
        name: id,
        doc: 'https://example.test',
        models: { 'nebula-9-small': expensive },
      };
    }

    expect(
      resolveFastDecision({ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'high' }, enabled, { modelsDev }),
    ).toMatchObject({
      reason: 'same_model_low',
      rungs: [{ providerID: 'acme', modelID: 'nebula-9-grand', variant: 'low' }],
      details: { crossModel: 'no_eligible_candidate' },
    });
  });

  test('builds a three-rung ladder for a four-tier family and drops superseded versions', () => {
    const tiers = [
      // Live Models.dev prices, 2026-11.
      ['claude-fable-5-2', 'claude-fable', 8, 40, '2026-11-09'],
      ['claude-fable-5-1', 'claude-fable', 10, 50, '2026-09-01'],
      ['claude-opus-5', 'claude-opus', 5, 25, '2026-07-24'],
      ['claude-opus-5-5', 'claude-opus', 4, 20, '2026-09-22'],
      ['claude-sonnet-5', 'claude-sonnet', 2, 10, '2026-06-29'],
      ['claude-sonnet-5-5', 'claude-sonnet', 2, 10, '2026-09-28'],
      ['claude-haiku-5-5', 'claude-haiku', 0.1, 0.5, '2026-10-07'],
    ] as const;
    const enabled = tiers.map(([id, family, input, output, releaseDate]) =>
      enabledModel('anthropic', id, baseSchedule(input, output), { family, releaseDate }),
    );
    const modelsDev = syntheticCatalog(
      tiers.map(([id, family, input, output, releaseDate]) => ({
        canonicalID: `anthropic/${id}`,
        family,
        cost: { input, output },
        releaseDate,
      })),
    );
    const decision = resolveFastDecision(
      { providerID: 'anthropic', modelID: 'claude-fable-5-2', variant: 'high' },
      enabled,
      { modelsDev },
    );
    // Sonnet 5 and 5.5 tie on price; without the superseded filter both drop and the ladder skips Sonnet.
    expect(decision.rungs.map((rung) => rung.modelID)).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);
    // Fable 5.1 costs more than the parent, so it is excluded on price rather than superseded.
    expect(decision.details).toEqual({ superseded: 2 });
  });

  test('reports incomparable candidates dropped from the ladder', () => {
    const enabled = [
      enabledModel('openai', 'gpt-6-astra', baseSchedule(10, 50), { family: 'gpt-astra' }),
      enabledModel('openai', 'gpt-6-sol', baseSchedule(2, 20), { family: 'gpt-sol' }),
      enabledModel('openai', 'gpt-6-terra', baseSchedule(6, 8), { family: 'gpt-terra' }),
      enabledModel('openai', 'gpt-6-luna', baseSchedule(0.1, 0.5), { family: 'gpt-luna' }),
    ];
    const modelsDev = syntheticCatalog([
      { canonicalID: 'openai/gpt-6-astra', family: 'gpt-astra', cost: { input: 10, output: 50 } },
      { canonicalID: 'openai/gpt-6-sol', family: 'gpt-sol', cost: { input: 2, output: 20 } },
      { canonicalID: 'openai/gpt-6-terra', family: 'gpt-terra', cost: { input: 6, output: 8 } },
      { canonicalID: 'openai/gpt-6-luna', family: 'gpt-luna', cost: { input: 0.1, output: 0.5 } },
    ]);
    expect(
      resolveFastDecision({ providerID: 'openai', modelID: 'gpt-6-astra', variant: 'high' }, enabled, { modelsDev }),
    ).toEqual({
      rungs: [{ providerID: 'openai', modelID: 'gpt-6-luna', variant: 'low' }],
      reason: 'same_generation_cheaper',
      details: { crossModel: 'incomparable_candidates', dropped: 2 },
    });
  });

  test('keeps explicit route order and drops invalid rungs', () => {
    const routes: Route[] = [
      {
        parent: { model: 'openai/gpt-sol' },
        fast: [
          { model: 'openai/gpt-luna', variant: 'low' },
          { model: 'openai/gpt-sol', variant: 'max' },
          { model: 'openai/gpt-terra' },
        ],
      },
    ];
    expect(resolveFastDecision(sol, [], { routes })).toEqual({
      rungs: [
        { providerID: 'openai', modelID: 'gpt-luna', variant: 'low' },
        { providerID: 'openai', modelID: 'gpt-terra' },
      ],
      reason: 'explicit_route',
    });
  });

  test('falls through when every explicit rung is invalid', () => {
    const routes: Route[] = [
      { parent: { model: 'openai/gpt-sol' }, fast: [{ model: 'openai/gpt-sol', variant: 'max' }] },
    ];
    expect(resolveFastDecision(sol, [self], { routes })).toEqual({
      rungs: [{ ...sol, variant: 'low' }],
      reason: 'same_model_low',
      details: { crossModel: 'models_dev_unavailable' },
    });
  });
});
