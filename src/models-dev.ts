import { Models, type Catalog, type ModelsDevError } from '@opencode-ai/models/effect';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { withOperationTimeout } from './errors';

export type ModelMetadataLoadError = {
  readonly _tag: 'ModelMetadataLoadError';
  readonly cause: unknown;
};

export const modelMetadataLoadError = (cause: unknown): ModelMetadataLoadError => ({
  _tag: 'ModelMetadataLoadError',
  cause,
});

const loadModelsDevCatalog: Effect.Effect<Catalog, ModelsDevError> = Models.make().pipe(
  Effect.flatMap((client) => client.catalog()),
  Effect.provide(FetchHttpClient.layer),
);

const loadSnapshot: Effect.Effect<Catalog, ModelMetadataLoadError> = Effect.tryPromise({
  try: async () => (await import('@opencode-ai/models/snapshot')).default,
  catch: modelMetadataLoadError,
});

export function loadModelMetadata(timeoutMs: number) {
  return withOperationTimeout(loadModelsDevCatalog, 'models_dev_live_load', timeoutMs).pipe(
    Effect.catch(() => loadSnapshot),
  );
}
