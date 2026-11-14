import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin';
import type { Agent, Plugin as V2 } from '@opencode/plugin/effect';
import { Cause, Effect, Option } from 'effect';

import { decide } from './decide';
import { openCodeError, withOperationTimeout, type OpenCodeError } from './errors';
import { askJev } from './jev';
import { loadModelMetadata } from './models-dev';
import { resolveFastDecision, type ModelRef } from './routing/resolve-fast';
import type { EnabledModel } from './routing/types';
import {
  catalogFromModels,
  catalogFromProviders,
  getOpenRouterApiKey,
  latestAssistantModel,
  parseOptions,
  type RouterOptions,
} from './runtime';

const ID = 'opencode-subagent-router';
const SERVICE = 'jev-router';

type Log = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: Readonly<Record<string, unknown>>,
) => Effect.Effect<void>;

export type RouterDependencies = {
  readonly ask: typeof askJev;
  readonly apiKey: () => Effect.Effect<Option.Option<string>>;
  readonly loadCatalog: (client: PluginInput['client']) => Effect.Effect<readonly EnabledModel[], OpenCodeError>;
  readonly loadModelMetadata: typeof loadModelMetadata;
};

const loadCatalog: RouterDependencies['loadCatalog'] = (client) =>
  openCodeRequest('config.providers', () => client.config.providers()).pipe(
    Effect.map((response) => catalogFromProviders(response.data?.providers)),
  );

function withDefaults(overrides: Partial<RouterDependencies>): RouterDependencies {
  return {
    ask: overrides.ask ?? askJev,
    apiKey: overrides.apiKey ?? getOpenRouterApiKey,
    loadCatalog: overrides.loadCatalog ?? loadCatalog,
    loadModelMetadata: overrides.loadModelMetadata ?? loadModelMetadata,
  };
}

const openCodeRequest = <A>(operation: string, request: () => Promise<A>): Effect.Effect<A, OpenCodeError> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => openCodeError(operation, cause),
  });

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    (left.variant ?? 'default') === (right.variant ?? 'default')
  );
}

function makeRouter(
  dependencies: RouterDependencies,
  options: RouterOptions,
  log: Log,
  catalogLoad: Effect.Effect<readonly EnabledModel[], OpenCodeError>,
) {
  const getCatalog = Effect.runSync(
    Effect.cached(
      withOperationTimeout(catalogLoad, 'catalog_load', options.timeoutMs).pipe(
        Effect.catchCause((cause) =>
          log('warn', 'catalog_load_failed', { error: Cause.pretty(cause) }).pipe(
            Effect.map((): readonly EnabledModel[] => []),
          ),
        ),
      ),
    ),
  );
  const getModelMetadata = Effect.runSync(
    Effect.cached(
      dependencies
        .loadModelMetadata(options.timeoutMs)
        .pipe(
          Effect.catchCause((cause) =>
            log('warn', 'model_metadata_load_failed', { error: Cause.pretty(cause) }).pipe(Effect.as(undefined)),
          ),
        ),
    ),
  );
  const getApiKey = Effect.runSync(Effect.cached(dependencies.apiKey()));

  return (parent: ModelRef, task: { readonly agent?: string | undefined; readonly prompt: string }) =>
    Effect.gen(function* () {
      const [catalog, modelsDev] = yield* Effect.all([getCatalog, getModelMetadata], { concurrency: 2 });
      const resolution = resolveFastDecision(parent, catalog, {
        routes: options.routes,
        ...(modelsDev === undefined ? {} : { modelsDev }),
      });

      const { rungs } = resolution;
      const [cheapest] = rungs;
      if (!cheapest) {
        yield* log('debug', 'no_fast_target', { parent, reason: resolution.reason });
        return undefined;
      }

      const apiKey = yield* getApiKey;
      if (Option.isNone(apiKey)) {
        yield* log('warn', 'missing_openrouter_api_key');
        return undefined;
      }

      const answers = yield* dependencies.ask({
        apiKey: apiKey.value,
        state: {
          ...(task.agent === undefined ? {} : { subagent_type: task.agent }),
          prompt: task.prompt,
        },
        timeoutMs: options.timeoutMs,
      });

      const verdict = decide(answers, rungs.length, options.confidenceMin);
      const rung = verdict.action === 'downgrade' ? verdict.rung : 0;
      const fast = rungs[rung] ?? cheapest;

      yield* log('info', verdict.reason, {
        answers,
        fast,
        parent,
        routing: {
          reason: resolution.reason,
          rungs,
          ...(verdict.action === 'downgrade' ? { rung: verdict.rung } : {}),
          ...resolution.details,
        },
      });

      return { fast, verdict };
    });
}

/** V1 entrypoint: rewrites the child's first message model in `chat.message`. */
export function createServer(overrides: Partial<RouterDependencies> = {}): Plugin {
  const dependencies = withDefaults(overrides);

  return ({ client }, rawOptions?: PluginOptions) => {
    const options = parseOptions(rawOptions);
    const log: Log = (level, message, extra) =>
      openCodeRequest('app.log', () =>
        client.app.log({
          body: {
            service: SERVICE,
            level,
            message,
            ...(extra === undefined ? {} : { extra }),
          },
        }),
      ).pipe(Effect.asVoid, Effect.ignoreCause);
    const route = makeRouter(dependencies, options, log, dependencies.loadCatalog(client));

    return Promise.resolve({
      'chat.message': (input, output) => {
        const handle = Effect.gen(function* () {
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

          const prompt = output.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const routed = yield* route(parentModel, { agent: input.agent, prompt });
          if (!routed) return;

          if (routed.verdict.action === 'keep') {
            yield* openCodeRequest('tui.showToast', () =>
              client.tui.showToast({
                body: {
                  title: 'Subagent kept parent model',
                  message: `${input.agent ?? output.message.agent}: ${routed.verdict.reason}`,
                  variant: 'warning',
                },
              }),
            ).pipe(Effect.asVoid, Effect.ignoreCause);
            return;
          }

          const { fast } = routed;
          yield* Effect.sync(() => {
            model.providerID = fast.providerID;
            model.modelID = fast.modelID;
            if (fast.variant) model.variant = fast.variant;
            else delete model.variant;
          });
        }).pipe(Effect.catchCause((cause) => log('warn', 'routing_failed', { error: Cause.pretty(cause) })));

        return Effect.runPromise(handle);
      },
    });
  };
}

type SubagentInput = {
  agent: Agent.ID;
  prompt: string;
  model?: string;
  sessionID?: string;
};

const LOGGERS = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const;

/** Runs on the host's Effect runtime, so these land in OpenCode's server log. */
const hostLog: Log = (level, message, extra) =>
  LOGGERS[level](message).pipe(
    Effect.annotateLogs({ service: SERVICE, ...(extra === undefined ? {} : { extra: JSON.stringify(extra) }) }),
  );

const hostRequest = <A>(operation: string, request: Effect.Effect<A, unknown>): Effect.Effect<A, OpenCodeError> =>
  request.pipe(Effect.mapError((cause) => openCodeError(operation, cause)));

/** V2 entrypoint: fills the `subagent` tool's `model` before OpenCode creates the child session. */
export function createPlugin(overrides: Partial<RouterDependencies> = {}): V2.Plugin {
  const dependencies = withDefaults(overrides);

  return {
    id: ID,
    effect: (ctx) =>
      Effect.gen(function* () {
        const route = makeRouter(
          dependencies,
          parseOptions(ctx.options),
          hostLog,
          hostRequest('model.list', ctx.model.list()).pipe(Effect.map((response) => catalogFromModels(response.data))),
        );

        yield* ctx.tool.hook('execute.before', (event) => {
          if (event.tool !== 'subagent') return Effect.void;
          const input = event.input as SubagentInput;

          return Effect.gen(function* () {
            if (input.sessionID !== undefined) {
              yield* hostLog('debug', 'follow_up');
              return;
            }
            if (input.model !== undefined) {
              yield* hostLog('info', 'pinned_model', { incoming: input.model });
              return;
            }

            const caller = yield* hostRequest('session.get', ctx.session.get({ sessionID: event.sessionID }));
            if (caller.parentID) {
              yield* hostLog('debug', 'not_primary_child');
              return;
            }

            const agent = yield* hostRequest('agent.get', ctx.agent.get({ agentID: input.agent }));
            if (agent.data.model) {
              yield* hostLog('info', 'pinned_model', { incoming: agent.data.model });
              return;
            }

            if (!caller.model) {
              yield* hostLog('warn', 'parent_model_unavailable');
              return;
            }
            const parent: ModelRef = {
              providerID: caller.model.providerID,
              modelID: caller.model.id,
              ...(caller.model.variant === undefined ? {} : { variant: caller.model.variant }),
            };

            const routed = yield* route(parent, { agent: input.agent, prompt: input.prompt });
            if (routed?.verdict.action !== 'downgrade') return;

            const { fast } = routed;
            input.model = `${fast.providerID}/${fast.modelID}${fast.variant ? `#${fast.variant}` : ''}`;
          }).pipe(Effect.catchCause((cause) => hostLog('warn', 'routing_failed', { error: Cause.pretty(cause) })));
        });
      }),
  };
}

export const server = createServer();

/** V1 calls `server`; V2 reads `id` and `effect`. */
export default { ...createPlugin(), server };
