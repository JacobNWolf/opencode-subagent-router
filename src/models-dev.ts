import { Models, type Catalog } from '@opencode-ai/models';
import { Effect } from 'effect';

import { withOperationTimeout } from './errors';

export type ModelMetadataLoadError = {
  readonly _tag: 'ModelMetadataLoadError';
  readonly cause: unknown;
};

export const modelMetadataLoadError = (cause: unknown): ModelMetadataLoadError => ({
  _tag: 'ModelMetadataLoadError',
  cause,
});

const loadModelsDevCatalog: Effect.Effect<Catalog, ModelMetadataLoadError> = Effect.tryPromise({
  try: (signal) => Models.make().catalog({ signal }),
  catch: modelMetadataLoadError,
});

const loadSnapshot: Effect.Effect<Catalog, ModelMetadataLoadError> = Effect.tryPromise({
  try: async () => (await import('@opencode-ai/models/snapshot')).default,
  catch: modelMetadataLoadError,
});

export function loadModelMetadata(timeoutMs: number) {
  return withOperationTimeout(loadModelsDevCatalog, 'models_dev_live_load', timeoutMs).pipe(
    Effect.catch(() => loadSnapshot),
  );
}
