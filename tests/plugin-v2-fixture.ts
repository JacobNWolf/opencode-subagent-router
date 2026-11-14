import { expect } from 'bun:test';

import type { Catalog } from '@opencode-ai/models';
import type { Plugin as V2 } from '@opencode/plugin/effect';
import { Effect, Logger, Option, References } from 'effect';

import { createPlugin } from '../src/index';
import { jevTransportError, type JevAnswers } from '../src/jev';
import type { CatalogModel } from '../src/runtime';

export const cheapAnswers: JevAnswers = {
  kind: { type: 'choice', choice: 'search', confidence: 1 },
  reasoning: { type: 'score', score: 0, confidence: 1 },
  keep_parent: { type: 'noul', noul: 0 },
};

export const opus: CatalogModel = {
  id: 'opus',
  modelID: 'opus',
  providerID: 'claude-agent',
  name: 'Opus 5.5',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  limit: { context: 1_000_000, output: 0 },
  variants: [{ id: 'low' }, { id: 'high' }],
};

export type Setup = {
  caller?: { parentID?: string; model?: { providerID: string; id: string; variant?: string } };
  agentModel?: unknown;
  models?: readonly CatalogModel[];
  modelsFail?: boolean;
  sessionFails?: boolean;
  options?: Record<string, unknown>;
  key?: string;
  answers?: JevAnswers;
  askFails?: boolean;
};

export const parentCaller = { model: { providerID: 'claude-agent', id: 'opus', variant: 'high' } };

export async function setupPlugin(setup: Setup = {}) {
  const logs: string[] = [];
  const asked: unknown[] = [];
  const agentLookups: unknown[] = [];
  const transports: unknown[] = [];
  let hook: ((event: unknown) => Effect.Effect<void, unknown>) | undefined;

  const ctx = {
    options: setup.options ?? {},
    model: {
      list: () =>
        setup.modelsFail
          ? Effect.fail(new Error('models unavailable'))
          : Effect.succeed({ data: setup.models ?? [opus] }),
    },
    session: {
      get: () =>
        setup.sessionFails
          ? Effect.fail(new Error('session unavailable'))
          : Effect.succeed(setup.caller ?? parentCaller),
    },
    agent: {
      get: (input: unknown) => {
        agentLookups.push(input);

        return Effect.succeed({ data: setup.agentModel === undefined ? {} : { model: setup.agentModel } });
      },
    },
    tool: {
      hook: (name: string, callback: typeof hook) =>
        Effect.sync(() => {
          expect(name).toBe('execute.before');
          hook = callback;

          return { dispose: Effect.void };
        }),
    },
  } as unknown as V2.Context;

  const instance = createPlugin({
    apiKey: () => Effect.succeed(Option.fromNullishOr(setup.key)),
    loadModelMetadata: () => Effect.succeed({ providers: {}, models: {} } as Catalog),
    ask: (request) => {
      asked.push(request);
      if (setup.askFails) return Effect.fail(jevTransportError('request', new Error('Jev unavailable')));

      return Effect.succeed(setup.answers ?? cheapAnswers);
    },
  });

  expect(instance.id).toBe('opencode-subagent-router');
  await Effect.runPromise(Effect.scoped(instance.effect(ctx)));

  const logger = Logger.make(({ message, fiber }) => {
    logs.push(String(Array.isArray(message) ? message[0] : message));
    transports.push(fiber.getRef(References.CurrentLogAnnotations).transport);
  });

  const run = async (tool: string, input: Record<string, unknown>) => {
    await Effect.runPromise(
      hook!({ tool, sessionID: 'parent', input }).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
      ),
    );

    return input;
  };

  return { run, logs, asked, agentLookups, transports };
}
