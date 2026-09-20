import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin';
import { Cause, Effect, Option } from 'effect';

import { decide } from './decide';
import { openCodeError, withOperationTimeout, type OpenCodeError } from './errors';
import { askJev } from './jev';
import { resolveFast, type CatalogModel, type ModelRef } from './resolve-fast';
import { catalogFromProviders, getOpenRouterApiKey, latestAssistantModel, parseOptions } from './runtime';

const SERVICE = 'jev-router';

export type RouterDependencies = {
  readonly ask: typeof askJev;
  readonly apiKey: () => Effect.Effect<Option.Option<string>>;
  readonly loadCatalog: (client: PluginInput['client']) => Effect.Effect<readonly CatalogModel[], OpenCodeError>;
};

const loadCatalog: RouterDependencies['loadCatalog'] = (client) =>
  Effect.tryPromise({
    try: () => client.config.providers(),
    catch: (cause) => openCodeError('config.providers', cause),
  }).pipe(Effect.map((response) => catalogFromProviders(response.data?.providers)));

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    (left.variant ?? 'default') === (right.variant ?? 'default')
  );
}

export function createServer(overrides: Partial<RouterDependencies> = {}): Plugin {
  const dependencies: RouterDependencies = {
    ask: overrides.ask ?? askJev,
    apiKey: overrides.apiKey ?? getOpenRouterApiKey,
    loadCatalog: overrides.loadCatalog ?? loadCatalog,
  };

  return ({ client }, rawOptions?: PluginOptions) => {
    const options = parseOptions(rawOptions);
    const log = (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      extra?: Readonly<Record<string, unknown>>,
    ): Effect.Effect<void> =>
      Effect.tryPromise({
        try: () =>
          client.app.log({
            body: {
              service: SERVICE,
              level,
              message,
              ...(extra === undefined ? {} : { extra }),
            },
          }),
        catch: (cause) => openCodeError('app.log', cause),
      }).pipe(Effect.asVoid, Effect.ignoreCause);

    const catalogLoad = withOperationTimeout(dependencies.loadCatalog(client), 'catalog_load', options.timeoutMs).pipe(
      Effect.catchCause((cause) =>
        log('warn', 'catalog_load_failed', { error: Cause.pretty(cause) }).pipe(
          Effect.map((): readonly CatalogModel[] => []),
        ),
      ),
    );
    const getCatalog = Effect.runSync(Effect.cached(catalogLoad));
    const getApiKey = Effect.runSync(Effect.cached(dependencies.apiKey()));

    const openCodeRequest = <A>(operation: string, request: () => Promise<A>): Effect.Effect<A, OpenCodeError> =>
      Effect.tryPromise({
        try: request,
        catch: (cause) => openCodeError(operation, cause),
      });

    return Promise.resolve({
      'chat.message': (input, output) => {
        const route = Effect.gen(function* () {
          const childResponse = yield* openCodeRequest('session.get.child', () =>
            client.session.get({ path: { id: output.message.sessionID } }),
          );
          const child = childResponse.data;
          if (!child?.parentID) {
            yield* log('debug', 'not_child_session');
            return;
          }
          const parentID = child.parentID;

          const parentResponse = yield* openCodeRequest('session.get.parent', () =>
            client.session.get({ path: { id: parentID } }),
          );
          const parent = parentResponse.data;
          if (!parent || parent.parentID) {
            yield* log('debug', 'not_primary_child');
            return;
          }

          const messagesResponse = yield* openCodeRequest('session.messages', () =>
            client.session.messages({ path: { id: parent.id } }),
          );
          const parentModel = latestAssistantModel(messagesResponse.data);
          if (!parentModel) {
            yield* log('warn', 'parent_model_unavailable');
            return;
          }

          const model = output.message.model as typeof output.message.model & { variant?: string };
          const variant = model.variant ?? input.variant;
          const incoming: ModelRef = {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(variant === undefined ? {} : { variant }),
          };
          if (!sameModel(incoming, parentModel)) {
            yield* log('info', 'pinned_model', { incoming, parent: parentModel });
            return;
          }

          const fast = resolveFast(parentModel, yield* getCatalog, options.routes);
          if (!fast) {
            yield* log('debug', 'no_fast_target', { parent: parentModel });
            return;
          }

          const apiKey = yield* getApiKey;
          if (Option.isNone(apiKey)) {
            yield* log('warn', 'missing_openrouter_api_key');
            return;
          }

          const prompt = output.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const answers = yield* dependencies.ask({
            apiKey: apiKey.value,
            state: {
              ...(input.agent === undefined ? {} : { subagent_type: input.agent }),
              prompt,
            },
            timeoutMs: options.timeoutMs,
          });
          const verdict = decide(answers, options.confidenceMin);
          yield* log('info', verdict.reason, { answers, fast, parent: parentModel });

          if (verdict.action === 'keep') {
            yield* Effect.tryPromise({
              try: () =>
                client.tui.showToast({
                  body: {
                    title: 'Subagent kept parent model',
                    message: `${input.agent ?? output.message.agent}: ${verdict.reason}`,
                    variant: 'warning',
                  },
                }),
              catch: (cause) => openCodeError('tui.showToast', cause),
            }).pipe(Effect.asVoid, Effect.ignoreCause);
            return;
          }

          yield* Effect.sync(() => {
            model.providerID = fast.providerID;
            model.modelID = fast.modelID;
            if (fast.variant) model.variant = fast.variant;
            else delete model.variant;
          });
        }).pipe(Effect.catchCause((cause) => log('warn', 'routing_failed', { error: Cause.pretty(cause) })));

        return Effect.runPromise(route);
      },
    });
  };
}

export const server = createServer();

export default { id: 'opencode-subagent-router', server };
