import { describe, expect, test } from 'bun:test';

import { matchRoute, resolveFast, type CatalogModel, type ModelRef, type Route } from '../src/resolve-fast';

const sol: ModelRef = { providerID: 'openai', modelID: 'gpt-sol', variant: 'high' };
const self: CatalogModel = {
  providerID: 'openai',
  id: 'gpt-sol',
  family: 'gpt',
  tool_call: true,
  cost: { input: 10 },
  variants: { low: {}, high: {} },
};

describe('matchRoute', () => {
  test('uses the last wildcard or variant match', () => {
    const routes: Route[] = [
      { parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-luna', variant: 'low' } },
      {
        parent: { model: 'openai/gpt-sol', variant: ['high', 'max'] },
        fast: { model: 'openai/gpt-terra' },
      },
    ];
    expect(matchRoute(sol, routes)).toEqual({ providerID: 'openai', modelID: 'gpt-terra' });
    expect(matchRoute({ ...sol, variant: 'medium' }, routes)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-luna',
      variant: 'low',
    });
  });

  test('supports string and implicit default variants', () => {
    const route: Route = {
      parent: { model: 'openai/gpt-sol', variant: 'default' },
      fast: { model: 'openai/gpt-luna' },
    };
    expect(matchRoute({ providerID: 'openai', modelID: 'gpt-sol' }, [route])).toEqual({
      providerID: 'openai',
      modelID: 'gpt-luna',
    });
    expect(matchRoute(sol, [{ ...route, parent: { ...route.parent, variant: 'low' } }])).toBeUndefined();
  });

  test('ignores unrelated and malformed targets', () => {
    const routes: Route[] = [
      { parent: { model: 'other/gpt-sol' }, fast: { model: 'openai/gpt-luna' } },
      { parent: { model: 'openai/gpt-sol' }, fast: { model: '/missing-provider' } },
      { parent: { model: 'openai/gpt-sol' }, fast: { model: 'missing-model/' } },
    ];
    expect(matchRoute(sol, routes)).toBeUndefined();
  });
});

describe('resolveFast', () => {
  test('prefers a model or provider override', () => {
    expect(
      resolveFast(sol, [self], [{ parent: { model: 'openai/gpt-sol' }, fast: { model: 'other/gpt-luna' } }]),
    ).toEqual({ providerID: 'other', modelID: 'gpt-luna' });
    expect(
      resolveFast(
        sol,
        [self],
        [{ parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-sol', variant: 'low' } }],
      ),
    ).toEqual({ ...sol, variant: 'low' });
  });

  test('rejects a same-or-higher override and lowers a high parent variant', () => {
    expect(
      resolveFast(
        sol,
        [self],
        [{ parent: { model: 'openai/gpt-sol' }, fast: { model: 'openai/gpt-sol', variant: 'max' } }],
      ),
    ).toEqual({ ...sol, variant: 'low' });
    expect(resolveFast({ ...sol, variant: 'unexpected' }, [self])).toBeUndefined();
  });

  test('returns nothing without parent family metadata', () => {
    expect(resolveFast({ providerID: 'openai', modelID: 'unknown' }, [])).toBeUndefined();
    expect(resolveFast({ providerID: 'openai', modelID: 'gpt-sol' }, [{ ...self, family: undefined }])).toBeUndefined();
  });

  test('chooses the cheapest eligible same-family sibling', () => {
    const catalog: CatalogModel[] = [
      self,
      { providerID: 'other', id: 'wrong-provider', family: 'gpt', cost: { input: 0 } },
      { providerID: 'openai', id: 'wrong-family', family: 'other', cost: { input: 0 } },
      { providerID: 'openai', id: 'no-tools', family: 'gpt', tool_call: false, cost: { input: 0 } },
      { providerID: 'openai', id: 'old', family: 'gpt', status: 'deprecated', cost: { input: 0 } },
      { providerID: 'openai', id: 'same-price', family: 'gpt', cost: { input: 10 } },
      { providerID: 'openai', id: 'terra', family: 'gpt', cost: { input: 5 } },
      { providerID: 'openai', id: 'luna', family: 'gpt', cost: { input: 1 }, variants: { low: {} } },
    ];
    expect(resolveFast({ ...sol, variant: 'medium' }, catalog)).toEqual({
      providerID: 'openai',
      modelID: 'luna',
      variant: 'low',
    });
  });

  test('handles missing costs and a sibling without variants', () => {
    const expensiveWithoutCost = { ...self, cost: undefined, variants: undefined };
    const cheap = { providerID: 'openai', id: 'luna', family: 'gpt', cost: { input: 1 } };
    expect(resolveFast({ providerID: 'openai', modelID: 'gpt-sol' }, [expensiveWithoutCost, cheap])).toEqual({
      providerID: 'openai',
      modelID: 'luna',
      variant: undefined,
    });
    expect(resolveFast({ providerID: 'openai', modelID: 'gpt-sol' }, [self])).toBeUndefined();
  });
});
