import type { Catalog, ModelMetadata } from '@opencode-ai/models/effect';
import { regex } from 'arkregex';
import { uniq } from 'es-toolkit';

import type { CanonicalIdentity, EnabledModel } from './types';

const nonAlphanumeric = regex('[^a-z0-9]+', 'g');
const trailingDate = regex('[-_.](?:19|20)\\d{2}(?:[-_.]?\\d{2}){0,2}$');
const idSeparator = regex('[-_.]');
const majorVersionToken = regex('^(\\d+)(?:[a-z]+)?$', 'i');

export type GenerationKey = {
  readonly lab: string;
  readonly lineage: string;
  readonly major: number;
};

function unique<T>(values: readonly T[]): T | undefined {
  if (values.length !== 1) return undefined;
  return values[0];
}

function directCanonicalIDs(model: EnabledModel, catalog: Catalog): string[] {
  const keys = [
    `${model.providerID}/${model.modelID}`,
    model.sourceID === undefined ? undefined : `${model.providerID}/${model.sourceID}`,
  ];

  return uniq(keys.filter((key): key is string => key !== undefined && catalog.models[key] !== undefined));
}

function prefixedCanonicalIDs(model: EnabledModel, catalog: Catalog): string[] {
  const keys = [model.modelID, model.sourceID].filter((key): key is string => key !== undefined);

  return uniq(keys.filter((key) => catalog.models[key] !== undefined));
}

export function normalizedName(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().replaceAll(nonAlphanumeric, ' ');

  return normalized || undefined;
}

export function sameFingerprint(enabled: EnabledModel, metadata: ModelMetadata): boolean {
  return (
    normalizedName(enabled.name) === normalizedName(metadata.name) &&
    enabled.family === metadata.family &&
    enabled.releaseDate === metadata.release_date &&
    enabled.limits?.context === metadata.limit?.context
  );
}

function fingerprintCanonicalIDs(model: EnabledModel, catalog: Catalog): string[] {
  return Object.values(catalog.models)
    .filter((metadata) => sameFingerprint(model, metadata))
    .map((metadata) => metadata.id);
}

export function resolveCanonicalID(model: EnabledModel, catalog: Catalog): string | undefined {
  const direct = directCanonicalIDs(model, catalog);
  if (direct.length > 0) return unique(direct);

  const prefixed = prefixedCanonicalIDs(model, catalog);
  if (prefixed.length > 0) return unique(prefixed);

  return unique(fingerprintCanonicalIDs(model, catalog));
}

export function labOf(canonicalID: string): string | undefined {
  const separator = canonicalID.indexOf('/');
  if (separator <= 0) return undefined;
  return canonicalID.slice(0, separator);
}

export function lineageOf(family?: string): string | undefined {
  const [lineage] = family?.split('-') ?? [];
  return lineage || undefined;
}

export function stripTrailingDate(value: string): string {
  return value.replace(trailingDate, '');
}

export function majorGenerationOf(canonicalID: string): number | undefined {
  const modelID = canonicalID.slice(canonicalID.indexOf('/') + 1);
  const tokens = stripTrailingDate(modelID).split(idSeparator);

  for (const token of tokens) {
    const match = majorVersionToken.exec(token);
    if (!match?.[1]) continue;

    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) return value;
  }

  return undefined;
}

export function generationKeyOf(canonicalID: string, family?: string): GenerationKey | undefined {
  const lab = labOf(canonicalID);
  const lineage = lineageOf(family);
  const major = majorGenerationOf(canonicalID);

  if (!lab || !lineage || major === undefined) return undefined;
  return { lab, lineage, major };
}

export function canonicalIdentityOf(canonicalID: string, family?: string): CanonicalIdentity | undefined {
  const key = generationKeyOf(canonicalID, family);
  if (!key) return undefined;
  return { id: canonicalID, lab: key.lab, lineage: key.lineage, generation: key.major };
}

export function sameGeneration(left: CanonicalIdentity, right: CanonicalIdentity): boolean {
  return left.lab === right.lab && left.lineage === right.lineage && left.generation === right.generation;
}

function isSubset<T>(required: ReadonlySet<T>, available: ReadonlySet<T>): boolean {
  for (const item of required) {
    if (!available.has(item)) return false;
  }
  return true;
}

export function preservesCapabilities(parent: EnabledModel, candidate: EnabledModel): boolean {
  const parentCapabilities = parent.capabilities;
  const candidateCapabilities = candidate.capabilities;
  const parentLimits = parent.limits;
  const candidateLimits = candidate.limits;

  if (!parentCapabilities || !candidateCapabilities || !parentLimits || !candidateLimits) return false;
  if (candidate.status === 'deprecated') return false;

  if (!candidateCapabilities.toolCall) return false;
  if (!candidateCapabilities.input.has('text') || !candidateCapabilities.output.has('text')) return false;

  if (!isSubset(parentCapabilities.input, candidateCapabilities.input)) return false;
  if (!isSubset(parentCapabilities.output, candidateCapabilities.output)) return false;

  if (parentCapabilities.attachment && !candidateCapabilities.attachment) return false;
  if (parentCapabilities.structuredOutput && !candidateCapabilities.structuredOutput) return false;

  if (candidateLimits.context < parentLimits.context) return false;
  if (candidateLimits.output < parentLimits.output) return false;

  return true;
}
