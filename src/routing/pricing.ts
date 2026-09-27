import type { ModelCost } from '@opencode-ai/models/effect';
import { compact, median as calculateMedian, uniq } from 'es-toolkit';

import type { CostEstimate, ModelProfile, PriceBand, PriceSchedule, TokenPrice } from './types';

export function median(values: readonly number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);

  if (finite.length === 0) return undefined;
  return calculateMedian(finite);
}

export function tokenPriceOf(cost: Pick<ModelCost, 'input' | 'output'>): TokenPrice | undefined {
  if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return undefined;
  if (cost.input < 0 || cost.output < 0) return undefined;

  return { input: cost.input, output: cost.output };
}

export function priceScheduleOf(cost?: ModelCost): PriceSchedule | undefined {
  if (!cost) return undefined;

  const base = tokenPriceOf(cost);
  if (!base) return undefined;

  const tiers = (cost.tiers ?? []).map((tier): PriceBand | undefined => {
    const price = tokenPriceOf(tier);
    if (!price) return undefined;
    return { fromContext: tier.tier.size, price };
  });
  if (tiers.some((tier) => tier === undefined)) return undefined;

  return {
    bands: [{ fromContext: 0, price: base }, ...(tiers as PriceBand[])].toSorted(
      (left, right) => left.fromContext - right.fromContext,
    ),
  };
}

export function priceAt(schedule: PriceSchedule, contextTokens: number): TokenPrice | undefined {
  let selected: PriceBand | undefined;

  for (const band of schedule.bands) {
    if (band.fromContext > contextTokens) break;
    selected = band;
  }

  return selected?.price;
}

export function medianPrice(prices: readonly TokenPrice[]): TokenPrice | undefined {
  const input = median(prices.map((price) => price.input));
  const output = median(prices.map((price) => price.output));

  if (input === undefined || output === undefined) return undefined;

  return { input, output };
}

export function scheduleThresholds(schedules: readonly PriceSchedule[]): number[] {
  return uniq(schedules.flatMap((schedule) => schedule.bands.map((band) => band.fromContext))).toSorted(
    (left, right) => left - right,
  );
}

export function marketCost(providerSchedules: ReadonlyMap<string, readonly PriceSchedule[]>): CostEstimate | undefined {
  const allSchedules = [...providerSchedules.values()].flat();
  const thresholds = scheduleThresholds(allSchedules);
  let providerSamples = Number.POSITIVE_INFINITY;

  const bands = thresholds.map((fromContext): PriceBand | undefined => {
    const representatives = compact(
      [...providerSchedules.values()].map((aliases) =>
        medianPrice(compact(aliases.map((schedule) => priceAt(schedule, fromContext)))),
      ),
    );

    providerSamples = Math.min(providerSamples, representatives.length);
    const price = medianPrice(representatives);

    if (price === undefined) return undefined;

    return { fromContext, price };
  });

  if (bands.length === 0 || bands.some((band) => band === undefined)) return undefined;

  return {
    schedule: { bands: bands as PriceBand[] },
    providerSamples,
  };
}

export function isCheaperOrEqual(candidate: TokenPrice, parent: TokenPrice): boolean {
  return candidate.input <= parent.input && candidate.output <= parent.output;
}

export function isStrictlyCheaper(candidate: TokenPrice, parent: TokenPrice): boolean {
  return isCheaperOrEqual(candidate, parent) && (candidate.input < parent.input || candidate.output < parent.output);
}

export function scheduleIsStrictlyCheaper(
  candidate: PriceSchedule,
  parent: PriceSchedule,
  maxContext: number,
): boolean {
  const points = scheduleThresholds([candidate, parent]).filter((point) => point <= maxContext);
  let foundStrictSaving = false;

  for (const point of points) {
    const candidatePrice = priceAt(candidate, point);
    const parentPrice = priceAt(parent, point);
    if (!candidatePrice || !parentPrice || !isCheaperOrEqual(candidatePrice, parentPrice)) return false;
    if (isStrictlyCheaper(candidatePrice, parentPrice)) foundStrictSaving = true;
  }

  return foundStrictSaving;
}

export function uniqueCheapest(candidates: readonly ModelProfile[], maxContext: number): ModelProfile | undefined {
  const winners = candidates.filter((candidate) =>
    candidates.every(
      (other) =>
        other === candidate ||
        (candidate.marketCost !== undefined &&
          other.marketCost !== undefined &&
          scheduleIsStrictlyCheaper(candidate.marketCost.schedule, other.marketCost.schedule, maxContext)),
    ),
  );

  if (winners.length !== 1) return undefined;
  return winners[0];
}
