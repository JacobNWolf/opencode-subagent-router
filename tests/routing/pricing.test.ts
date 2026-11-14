import { describe, expect, test } from 'bun:test';

import {
  cheapestChain,
  marketCost,
  median,
  priceScheduleOf,
  scheduleIsStrictlyCheaper,
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

describe('cheapestChain', () => {
  const ids = (profiles: readonly ModelProfile[]) => profiles.map((p) => p.enabled.modelID);

  test('orders a strict price chain cheapest first', () => {
    const chain = cheapestChain(
      [profile('mid', estimate(4, 16)), profile('small', estimate(1, 4)), profile('big', estimate(8, 32))],
      100_000,
    );
    expect(ids(chain)).toEqual(['small', 'mid', 'big']);
  });

  test('orders equal base prices by savings at later tiers, regardless of catalog order', () => {
    const tiers = [1, 2, 3].map((price) =>
      profile(`tier-${price}`, {
        schedule: schedule(1, 4, [{ fromContext: 50_000, input: price, output: price * 4 }]),
        providerSamples: 1,
      }),
    );
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      expect(
        ids(
          cheapestChain(
            order.map((index) => tiers[index]!),
            100_000,
          ),
        ),
      ).toEqual(['tier-1', 'tier-2', 'tier-3']);
    }
  });

  test('drops an incomparable middle pair and keeps the floor', () => {
    const chain = cheapestChain(
      [profile('small', estimate(1, 4)), profile('a', estimate(2, 20)), profile('b', estimate(6, 8))],
      100_000,
    );
    expect(ids(chain)).toEqual(['small']);
  });

  test('returns nothing when the floor is ambiguous', () => {
    const candidates = [profile('a', estimate(1, 8)), profile('b', estimate(2, 4)), profile('c', estimate(10, 10))];
    expect(cheapestChain(candidates, 100_000)).toEqual([]);
  });

  test('drops equal prices', () => {
    expect(cheapestChain([profile('a', estimate(1, 4)), profile('b', estimate(1, 4))], 100_000)).toEqual([]);
  });

  test('compares tiers only up to the parent context', () => {
    const tiered = (modelID: string, input: number, over: number) =>
      profile(modelID, {
        schedule: schedule(input, input * 4, [{ fromContext: 200_000, input: over, output: over * 4 }]),
        providerSamples: 1,
      });
    const candidates = [tiered('small', 1, 20), tiered('mid', 4, 8)];
    expect(ids(cheapestChain(candidates, 100_000))).toEqual(['small', 'mid']);
    expect(cheapestChain(candidates, 1_000_000)).toEqual([]);
  });
});
