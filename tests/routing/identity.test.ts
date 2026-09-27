import { describe, expect, test } from 'bun:test';

import type { Catalog, ModelFamily, ModelMetadata } from '@opencode-ai/models/effect';

import {
  canonicalIdentityOf,
  generationKeyOf,
  majorGenerationOf,
  preservesCapabilities,
  resolveCanonicalID,
  sameGeneration,
  stripTrailingDate,
} from '../../src/routing/identity';
import type { EnabledModel, ModelCapabilities, ModelLimits } from '../../src/routing/types';

const capabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  attachment: true,
  reasoning: true,
  toolCall: true,
  structuredOutput: true,
  input: new Set(['text']),
  output: new Set(['text']),
  ...overrides,
});

const limits = (overrides: Partial<ModelLimits> = {}): ModelLimits => ({
  context: 100_000,
  output: 16_000,
  ...overrides,
});

function enabled(
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

function catalog(models: readonly ModelMetadata[]): Catalog {
  return {
    providers: {},
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  };
}

function metadata(id: string, family: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id,
    name: overrides.name ?? id.slice(id.indexOf('/') + 1),
    description: id,
    family: family as ModelFamily,
    ...overrides,
  };
}

describe('resolveCanonicalID', () => {
  test('resolves native provider and model keys', () => {
    const models = [metadata('openai/gpt-6-luna', 'gpt-luna')];
    expect(resolveCanonicalID(enabled('openai', 'gpt-6-luna'), catalog(models))).toBe('openai/gpt-6-luna');
    expect(resolveCanonicalID(enabled('openai', 'luna', { sourceID: 'gpt-6-luna' }), catalog(models))).toBe(
      'openai/gpt-6-luna',
    );
  });

  test('resolves canonically prefixed gateway IDs', () => {
    expect(
      resolveCanonicalID(
        enabled('openrouter', 'openai/gpt-6-luna'),
        catalog([metadata('openai/gpt-6-luna', 'gpt-luna')]),
      ),
    ).toBe('openai/gpt-6-luna');
  });

  test('resolves a unique exact fingerprint', () => {
    const models = [
      metadata('acme/nebula-9-grand', 'nebula-grand', {
        name: 'Nebula Grand',
        release_date: '2030-01-01',
        limit: { context: 100_000 },
      }),
    ];
    expect(
      resolveCanonicalID(
        enabled('gateway', 'alias', {
          name: 'nebula grand',
          family: 'nebula-grand',
          releaseDate: '2030-01-01',
          limits: limits(),
        }),
        catalog(models),
      ),
    ).toBe('acme/nebula-9-grand');
  });

  test('treats two matching fingerprints as ambiguous', () => {
    const models = [
      metadata('acme/nebula-9-grand', 'nebula-grand', {
        name: 'Nebula',
        release_date: '2030-01-01',
        limit: { context: 100_000 },
      }),
      metadata('acme/nebula-9-grand-alias', 'nebula-grand', {
        name: 'Nebula',
        release_date: '2030-01-01',
        limit: { context: 100_000 },
      }),
    ];
    expect(
      resolveCanonicalID(
        enabled('gateway', 'alias', {
          name: 'Nebula',
          family: 'nebula-grand',
          releaseDate: '2030-01-01',
          limits: limits(),
        }),
        catalog(models),
      ),
    ).toBeUndefined();
  });

  test('returns undefined without throwing when nothing matches', () => {
    expect(resolveCanonicalID(enabled('openai', 'missing'), catalog([]))).toBeUndefined();
  });
});

describe('generation inference', () => {
  test('strips trailing dates and reads the first version token', () => {
    expect(stripTrailingDate('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
    expect(majorGenerationOf('openai/gpt-6-astra')).toBe(6);
    expect(majorGenerationOf('anthropic/claude-fable-5-1')).toBe(5);
    expect(majorGenerationOf('anthropic/claude-sonnet-5')).toBe(5);
    expect(majorGenerationOf('anthropic/claude-3-5-sonnet-20241022')).toBe(3);
    expect(majorGenerationOf('acme/nebula')).toBeUndefined();
  });

  test('builds keys from invented names rather than known brands', () => {
    expect(generationKeyOf('acme/nebula-9-grand', 'nebula-grand')).toEqual({
      lab: 'acme',
      lineage: 'nebula',
      major: 9,
    });
    expect(generationKeyOf('acme/nebula-9-small', 'nebula-small')).toEqual({
      lab: 'acme',
      lineage: 'nebula',
      major: 9,
    });
    expect(generationKeyOf('acme/nebula-8-small', 'nebula-small')).toEqual({
      lab: 'acme',
      lineage: 'nebula',
      major: 8,
    });
    expect(generationKeyOf('nebula-9-grand', 'nebula-grand')).toBeUndefined();
    expect(generationKeyOf('acme/nebula-9-grand')).toBeUndefined();
  });

  test('compares generation identity', () => {
    const grand = canonicalIdentityOf('acme/nebula-9-grand', 'nebula-grand');
    const small = canonicalIdentityOf('acme/nebula-9-small', 'nebula-small');
    const older = canonicalIdentityOf('acme/nebula-8-small', 'nebula-small');
    expect(grand && small && sameGeneration(grand, small)).toBeTrue();
    expect(grand && older && sameGeneration(grand, older)).toBeFalse();
  });
});

describe('preservesCapabilities', () => {
  const parent = enabled('acme', 'nebula-9-grand', { capabilities: capabilities(), limits: limits() });

  test('rejects missing tool calling, text output, and smaller context', () => {
    expect(
      preservesCapabilities(
        parent,
        enabled('acme', 'small', { capabilities: capabilities({ toolCall: false }), limits: limits() }),
      ),
    ).toBeFalse();
    expect(
      preservesCapabilities(
        parent,
        enabled('acme', 'small', { capabilities: capabilities({ output: new Set() }), limits: limits() }),
      ),
    ).toBeFalse();
    expect(
      preservesCapabilities(
        parent,
        enabled('acme', 'small', { capabilities: capabilities(), limits: limits({ context: 1 }) }),
      ),
    ).toBeFalse();
  });

  test('rejects a missing parent image modality under the strict policy', () => {
    const imageParent = enabled('acme', 'vision', {
      capabilities: capabilities({ input: new Set(['text', 'image']) }),
      limits: limits(),
    });
    expect(
      preservesCapabilities(
        imageParent,
        enabled('acme', 'text-only', { capabilities: capabilities(), limits: limits() }),
      ),
    ).toBeFalse();
  });

  test('does not require equal reasoning support', () => {
    expect(
      preservesCapabilities(
        parent,
        enabled('acme', 'small', { capabilities: capabilities({ reasoning: false }), limits: limits() }),
      ),
    ).toBeTrue();
  });

  test('rejects deprecated candidates', () => {
    expect(
      preservesCapabilities(
        parent,
        enabled('acme', 'old', { status: 'deprecated', capabilities: capabilities(), limits: limits() }),
      ),
    ).toBeFalse();
  });
});
