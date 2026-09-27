import { describe, expect, test } from 'bun:test';

import { Effect } from 'effect';

import { loadModelMetadata, modelMetadataLoadError } from '../src/models-dev';

describe('loadModelMetadata', () => {
  test('tags snapshot import failures', () => {
    expect(modelMetadataLoadError('offline')).toEqual({ _tag: 'ModelMetadataLoadError', cause: 'offline' });
  });

  test('returns a catalog from live data or the package snapshot', async () => {
    const catalog = await Effect.runPromise(loadModelMetadata(1));
    expect(typeof catalog.models).toBe('object');
    expect(typeof catalog.providers).toBe('object');
  });
});
