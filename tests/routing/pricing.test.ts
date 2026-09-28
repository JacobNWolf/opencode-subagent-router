import { describe, expect, test } from 'bun:test';

import {
  marketCost,
  median,
  priceScheduleOf,
  scheduleIsStrictlyCheaper,
  uniqueCheapest,
} from '../../src/routing/pricing';
import type { CostEstimate, EnabledModel, ModelProfile, PriceSchedule } from '../../src/routing/types';

const schedule = (
  input: number,
  output: number,
  tiers: readonly { fromContext: number; input: number; output: number }[] = [],
): PriceSchedule => ({
  bands: [
    { fromContext: 0, price: { input, output } },
    ...tiers.map((tier) => ({ fromContext: tier.fromContext, price: { input: tier.input, output: tier.output } })),
  ],
});

const estimate = (input: number, output: number, providerSamples = 1): CostEstimate => ({
  schedule: schedule(input, output),
  providerSamples,
});

function profile(modelID: string, market: CostEstimate): ModelProfile {
  const enabled: EnabledModel = {
    providerID: 'acme',
    modelID,
    variants: new Set(),
  };
  return { enabled, marketCost: market };
}

describe('median', () => {
  test('handles odd and even sample counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test('ignores missing, zero, NaN, and infinite prices', () => {
    expect(median([0, Number.NaN, Number.POSITIVE_INFINITY, -1, 2])).toBe(2);
    expect(median([0, Number.NaN])).toBeUndefined();
  });
});

describe('priceScheduleOf', () => {
  test('reads exact tiers and ignores the legacy 200k mirror', () => {
    expect(
      priceScheduleOf({
        input: 10,
        output: 50,
        context_over_200k: { input: 20, output: 75 },
        tiers: [{ input: 20, output: 75, tier: { type: 'context', size: 272_000 } }],
      }),
    ).toEqual({
      bands: [
        { fromContext: 0, price: { input: 10, output: 50 } },
        { fromContext: 272_000, price: { input: 20, output: 75 } },
      ],
    });
  });
});

describe('marketCost', () => {
  test('counts ten aliases from one provider as one sample', () => {
    const aliases = Array.from({ length: 10 }, () => schedule(1, 2));
    const other = [schedule(3, 6)];
    const estimate = marketCost(
      new Map([
        ['gateway', aliases],
        ['lab', other],
      ]),
    );
    expect(estimate?.providerSamples).toBe(2);
    expect(estimate?.schedule.bands[0]?.price).toEqual({ input: 2, output: 4 });
  });
});

describe('schedule comparison', () => {
  test('lower input and equal output is cheaper', () => {
    expect(scheduleIsStrictlyCheaper(schedule(1, 4), schedule(2, 4), 100_000)).toBeTrue();
  });

  test('lower input and higher output is incomparable', () => {
    expect(scheduleIsStrictlyCheaper(schedule(1, 8), schedule(2, 4), 100_000)).toBeFalse();
  });

  test('a cheaper base that costs more at a parent-supported tier is rejected', () => {
    const candidate = schedule(1, 4, [{ fromContext: 50_000, input: 20, output: 80 }]);
    const parent = schedule(10, 40, [{ fromContext: 50_000, input: 12, output: 48 }]);
    expect(scheduleIsStrictlyCheaper(candidate, parent, 100_000)).toBeFalse();
    expect(scheduleIsStrictlyCheaper(candidate, parent, 10_000)).toBeTrue();
  });
});

describe('uniqueCheapest', () => {
  test('selects a unique dominating candidate', () => {
    const winner = uniqueCheapest([profile('middle', estimate(4, 16)), profile('small', estimate(1, 4))], 100_000);
    expect(winner?.enabled.modelID).toBe('small');
  });

  test('returns nothing on an ambiguous cost frontier', () => {
    expect(uniqueCheapest([profile('a', estimate(1, 8)), profile('b', estimate(2, 4))], 100_000)).toBeUndefined();
  });
});
