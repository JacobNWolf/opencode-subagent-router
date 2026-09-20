import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin';

import { decide } from './decide';
import { askJev } from './jev';
import { resolveFast, type CatalogModel, type ModelRef } from './resolve-fast';
import { catalogFromProviders, getOpenRouterApiKey, latestAssistantModel, parseOptions } from './runtime';

const SERVICE = 'jev-router';

type Dependencies = {
  ask: typeof askJev;
  apiKey: () => string | undefined;
  loadCatalog: (client: PluginInput['client']) => Promise<CatalogModel[]>;
};

const loadCatalog = async (client: PluginInput['client']): Promise<CatalogModel[]> => {
  const response = await client.config.providers();
  return catalogFromProviders(response.data?.providers);
};

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    (left.variant ?? 'default') === (right.variant ?? 'default')
  );
}

export function createServer(overrides: Partial<Dependencies> = {}): Plugin {
  const dependencies: Dependencies = {
    ask: overrides.ask ?? askJev,
    apiKey: overrides.apiKey ?? getOpenRouterApiKey,
    loadCatalog: overrides.loadCatalog ?? loadCatalog,
  };

  return async ({ client }, rawOptions?: PluginOptions) => {
    const options = parseOptions(rawOptions);
    const log = async (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      extra?: Record<string, unknown>,
    ) => {
      try {
        await client.app.log({ body: { service: SERVICE, level, message, extra } });
      } catch {
        // Routing must never fail because diagnostic logging is unavailable.
      }
    };

    let catalog: CatalogModel[] = [];
    try {
      catalog = await dependencies.loadCatalog(client);
    } catch (error) {
      await log('warn', 'catalog_load_failed', { error: String(error) });
    }
    const apiKey = dependencies.apiKey();

    return {
      'chat.message': async (input, output) => {
        try {
          const child = (await client.session.get({ path: { id: output.message.sessionID } })).data;
          if (!child?.parentID) {
            await log('debug', 'not_child_session');
            return;
          }

          const parent = (await client.session.get({ path: { id: child.parentID } })).data;
          if (!parent || parent.parentID) {
            await log('debug', 'not_primary_child');
            return;
          }

          const messages = (await client.session.messages({ path: { id: parent.id } })).data;
          const parentModel = latestAssistantModel(messages);
          if (!parentModel) {
            await log('warn', 'parent_model_unavailable');
            return;
          }

          const model = output.message.model as typeof output.message.model & { variant?: string };
          const incoming: ModelRef = {
            providerID: model.providerID,
            modelID: model.modelID,
            variant: model.variant ?? input.variant,
          };
          if (!sameModel(incoming, parentModel)) {
            await log('info', 'pinned_model', { incoming, parent: parentModel });
            return;
          }

          const fast = resolveFast(parentModel, catalog, options.routes);
          if (!fast) {
            await log('debug', 'no_fast_target', { parent: parentModel });
            return;
          }
          if (!apiKey) {
            await log('warn', 'missing_openrouter_api_key');
            return;
          }

          const prompt = output.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const answers = await dependencies.ask({
            apiKey,
            state: { subagent_type: input.agent, prompt },
            timeoutMs: options.timeoutMs,
          });
          const verdict = decide(answers, options.confidenceMin);
          await log('info', verdict.reason, { answers, fast, parent: parentModel });

          if (verdict.action === 'keep') {
            try {
              await client.tui.showToast({
                body: {
                  title: 'Subagent kept parent model',
                  message: `${input.agent ?? output.message.agent}: ${verdict.reason}`,
                  variant: 'warning',
                },
              });
            } catch {
              // The TUI is optional (for example, when OpenCode runs headlessly).
            }
            return;
          }

          model.providerID = fast.providerID;
          model.modelID = fast.modelID;
          if (fast.variant) model.variant = fast.variant;
          else delete model.variant;
        } catch (error) {
          await log('warn', 'routing_failed', { error: String(error) });
        }
      },
    };
  };
}

export const server = createServer();

export default { id: 'opencode-subagent-router', server };
