import { describe, expect, test } from 'bun:test';

import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import { Effect, Option } from 'effect';

import { openCodeError } from '../src/errors';
import { createServer, server } from '../src/index';
import { jevTransportError, type JevAnswers } from '../src/jev';
import type { CatalogModel } from '../src/resolve-fast';

const cheapAnswers: JevAnswers = {
  kind: { type: 'choice', choice: 'search', confidence: 1 },
  reasoning: { type: 'score', score: 0, confidence: 1 },
  keep_parent: { type: 'noul', noul: 0 },
};
const hardAnswers: JevAnswers = {
  ...cheapAnswers,
  kind: { type: 'choice', choice: 'diagnosis', confidence: 1 },
};

type ClientSetup = {
  child?: unknown;
  parent?: unknown;
  messages?: unknown;
  logFails?: boolean;
  toastFails?: boolean;
  sessionFails?: boolean;
  providers?: unknown;
  providersFail?: boolean;
  providersNeverResolve?: boolean;
};

function makeClient(setup: ClientSetup = {}) {
  const logs: Array<{ level: string; message: string }> = [];
  const toasts: unknown[] = [];
  let providerCalls = 0;
  const client = {
    app: {
      log: async ({ body }: { body: { level: string; message: string } }) => {
        logs.push(body);
        if (setup.logFails) throw new Error('log unavailable');
      },
    },
    config: {
      providers: async () => {
        providerCalls += 1;
        if (setup.providersFail) throw new Error('providers unavailable');
        if (setup.providersNeverResolve) await new Promise(() => {});
        return { data: { providers: setup.providers ?? [] } };
      },
    },
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        if (setup.sessionFails) throw new Error('session unavailable');
        return { data: path.id === 'child' ? setup.child : setup.parent };
      },
      messages: async () => ({ data: setup.messages }),
    },
    tui: {
      showToast: async (toast: unknown) => {
        toasts.push(toast);
        if (setup.toastFails) throw new Error('no tui');
      },
    },
  };
  return {
    client: client as unknown as PluginInput['client'],
    logs,
    toasts,
    get providerCalls() {
      return providerCalls;
    },
  };
}

function input(variant: string | undefined = 'high', agent: string | undefined = 'explore') {
  return { sessionID: 'child', agent, variant } as never;
}

function output(modelID = 'sol', variant: string | undefined = 'high') {
  return {
    message: {
      sessionID: 'child',
      agent: 'fallback-agent',
      model: { providerID: 'openai', modelID, ...(variant ? { variant } : {}) },
    },
    parts: [
      { type: 'text', text: 'find files' },
      { type: 'file', url: 'file:///tmp/example' },
      { type: 'text', text: 'report paths' },
    ],
  } as never;
}

function parentMessages(modelID = 'sol', variant: string | undefined = 'high') {
  return [
    {
      info: {
        role: 'assistant',
        providerID: 'openai',
        modelID,
        variant,
        time: { created: 1 },
      },
    },
  ];
}

function variantCatalog(): CatalogModel[] {
  return [
    {
      providerID: 'openai',
      id: 'sol',
      family: 'gpt',
      cost: { input: 10 },
      variants: { low: {}, high: {} },
    },
  ];
}

async function hooksFor(
  setup: ClientSetup,
  dependencies: {
    key?: string;
    catalog?: CatalogModel[];
    answers?: JevAnswers;
    askFails?: boolean;
  } = {},
) {
  const fixture = makeClient(setup);
  const plugin = createServer({
    apiKey: () => Effect.succeed(Option.fromNullishOr(dependencies.key)),
    loadCatalog: () => Effect.succeed(dependencies.catalog ?? variantCatalog()),
    ask: () => {
      if (dependencies.askFails) {
        return Effect.fail(jevTransportError('request', new Error('Jev unavailable')));
      }
      return Effect.succeed(dependencies.answers ?? cheapAnswers);
    },
  });
  const hooks = await plugin({ client: fixture.client } as PluginInput, {
    timeoutMs: 321,
    confidenceMin: 0.75,
  });
  return { ...fixture, hook: hooks['chat.message']! };
}

describe('plugin initialization', () => {
  test('does not call back into OpenCode while the instance is bootstrapping', async () => {
    const fixture = makeClient({ providersNeverResolve: true });
    const initializing = createServer({ apiKey: () => Effect.succeed(Option.none()) })({
      client: fixture.client,
    } as PluginInput);

    await Promise.resolve();
    expect(fixture.providerCalls).toBe(0);

    const hooks = await initializing;
    expect(hooks['chat.message']).toBeFunction();
  });

  test('loads and normalizes the real provider adapter on demand', async () => {
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
      providers: [
        {
          id: 'openai',
          models: { sol: { family: 'gpt', cost: { input: 1 }, variants: { low: {}, high: {} } } },
        },
      ],
    });
    const plugin = createServer({ apiKey: () => Effect.succeed(Option.none()) });
    const hooks = await plugin({ client: fixture.client } as PluginInput);
    expect(hooks['chat.message']).toBeFunction();
    expect(fixture.providerCalls).toBe(0);

    await hooks['chat.message']!(input(), output());
    expect(fixture.providerCalls).toBe(1);
    expect(fixture.logs.at(-1)?.message).toBe('missing_openrouter_api_key');
  });

  test('runs the exported server with its default credential adapter', async () => {
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
      providers: [
        {
          id: 'openai',
          models: { sol: { family: 'gpt', cost: { input: 1 }, variants: { low: {}, high: {} } } },
        },
      ],
    });
    const previousKey = process.env.OPENROUTER_API_KEY;
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.OPENROUTER_API_KEY = '';
    process.env.XDG_DATA_HOME = '/missing-jev-router-test-data';
    try {
      const hooks = await server({ client: fixture.client } as PluginInput);
      await hooks['chat.message']!(input(), output());
      expect(fixture.logs.at(-1)?.message).toBe('missing_openrouter_api_key');
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
    }
  });

  test('fails open when catalog loading and logging fail', async () => {
    let catalogCalls = 0;
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
      logFails: true,
    });
    const plugin = createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadCatalog: () =>
        Effect.suspend(() => {
          catalogCalls += 1;
          return Effect.fail(openCodeError('config.providers', new Error('catalog unavailable')));
        }),
    });
    const hooks = await plugin({ client: fixture.client } as PluginInput);
    expect(hooks['chat.message']).toBeFunction();
    await hooks['chat.message']!(input(), output());
    await hooks['chat.message']!(input(), output());
    expect(catalogCalls).toBe(1);
    expect(fixture.logs.some((entry) => entry.message === 'catalog_load_failed')).toBeTrue();
  });

  test('shares one lazy catalog load across concurrent messages', async () => {
    let catalogCalls = 0;
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    });
    const plugin = createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadCatalog: () =>
        Effect.sync(() => {
          catalogCalls += 1;
          return variantCatalog();
        }),
    });
    const hooks = await plugin({ client: fixture.client } as PluginInput);

    await Promise.all([hooks['chat.message']!(input(), output()), hooks['chat.message']!(input(), output())]);
    expect(catalogCalls).toBe(1);
  });

  test('fails open when lazy catalog loading stalls', async () => {
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
      providersNeverResolve: true,
    });
    const hooks = await createServer({ apiKey: () => Effect.succeed(Option.none()) })(
      { client: fixture.client } as PluginInput,
      {
        timeoutMs: 10,
      },
    );

    await hooks['chat.message']!(input(), output());
    expect(fixture.logs.some((entry) => entry.message === 'catalog_load_failed')).toBeTrue();
  });

  test('maps a rejected provider request through the default catalog adapter', async () => {
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
      providersFail: true,
    });
    const hooks = await createServer({ apiKey: () => Effect.succeed(Option.none()) })({
      client: fixture.client,
    } as PluginInput);

    await hooks['chat.message']!(input(), output());
    expect(fixture.logs.some((entry) => entry.message === 'catalog_load_failed')).toBeTrue();
  });
});

describe('chat.message routing', () => {
  test('skips primary sessions', async () => {
    const fixture = await hooksFor({ child: { id: 'child' }, logFails: true });
    await fixture.hook(input(), output());
    expect(fixture.logs.at(-1)?.message).toBe('not_child_session');
  });

  test('skips missing parents and nested children', async () => {
    const missing = await hooksFor({ child: { id: 'child', parentID: 'parent' } });
    await missing.hook(input(), output());
    expect(missing.logs.at(-1)?.message).toBe('not_primary_child');

    const nested = await hooksFor({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent', parentID: 'root' },
    });
    await nested.hook(input(), output());
    expect(nested.logs.at(-1)?.message).toBe('not_primary_child');
  });

  test('skips when the parent model cannot be resolved', async () => {
    const fixture = await hooksFor({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: [],
    });
    await fixture.hook(input(), output());
    expect(fixture.logs.at(-1)?.message).toBe('parent_model_unavailable');
  });

  test('honors pinned child models and variants', async () => {
    const setup = {
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    };
    const modelPin = await hooksFor(setup);
    await modelPin.hook(input(), output('terra'));
    expect(modelPin.logs.at(-1)?.message).toBe('pinned_model');

    const variantPin = await hooksFor(setup);
    await variantPin.hook(input(undefined), output('sol', 'low'));
    expect(variantPin.logs.at(-1)?.message).toBe('pinned_model');
  });

  test('skips when no faster target exists', async () => {
    const fixture = await hooksFor(
      {
        child: { id: 'child', parentID: 'parent' },
        parent: { id: 'parent' },
        messages: parentMessages('sol', 'medium'),
      },
      { catalog: [] },
    );
    await fixture.hook(input('medium'), output('sol', 'medium'));
    expect(fixture.logs.at(-1)?.message).toBe('no_fast_target');
  });

  test('skips the classifier without an API key', async () => {
    const fixture = await hooksFor({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    });
    await fixture.hook(input(), output());
    expect(fixture.logs.at(-1)?.message).toBe('missing_openrouter_api_key');
  });

  test('downgrades cheap work and joins only text parts', async () => {
    let received: unknown;
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    });
    const plugin = createServer({
      apiKey: () => Effect.succeed(Option.some('key')),
      loadCatalog: () => Effect.succeed(variantCatalog()),
      ask: (request) => {
        received = request;
        return Effect.succeed(cheapAnswers);
      },
    });
    const hooks = await plugin({ client: fixture.client } as PluginInput, { timeoutMs: 321, confidenceMin: 0.75 });
    const routed = output();
    await hooks['chat.message']!(input(), routed);
    expect(received).toEqual({
      apiKey: 'key',
      state: { subagent_type: 'explore', prompt: 'find files\nreport paths' },
      timeoutMs: 321,
    });
    expect((routed as { message: { model: unknown } }).message.model).toEqual({
      providerID: 'openai',
      modelID: 'sol',
      variant: 'low',
    });
    expect(fixture.logs.at(-1)?.message).toBe('cheap_task');
  });

  test('routes to a cheaper sibling and removes an inherited variant', async () => {
    const catalog: CatalogModel[] = [
      { providerID: 'openai', id: 'sol', family: 'gpt', cost: { input: 10 } },
      { providerID: 'openai', id: 'luna', family: 'gpt', tool_call: true, cost: { input: 1 } },
    ];
    const fixture = await hooksFor(
      {
        child: { id: 'child', parentID: 'parent' },
        parent: { id: 'parent' },
        messages: parentMessages('sol', 'medium'),
      },
      { key: 'key', catalog },
    );
    const routed = output('sol', 'medium');
    await fixture.hook(input('medium'), routed);
    expect((routed as { message: { model: unknown } }).message.model).toEqual({
      providerID: 'openai',
      modelID: 'luna',
    });
  });

  test('keeps hard work and tolerates missing or failing TUI output', async () => {
    const setup = {
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    };
    const shown = await hooksFor(setup, { key: 'key', answers: hardAnswers });
    await shown.hook(input(), output());
    expect(shown.toasts).toHaveLength(1);

    const headless = await hooksFor({ ...setup, toastFails: true }, { key: 'key', answers: hardAnswers });
    await headless.hook(input('high', undefined), output());
    expect(headless.toasts).toHaveLength(1);
  });

  test('fails open on classifier and session errors', async () => {
    const setup = {
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    };
    const classifier = await hooksFor(setup, { key: 'key', askFails: true });
    await classifier.hook(input(), output());
    expect(classifier.logs.at(-1)?.message).toBe('routing_failed');

    const session = await hooksFor({ sessionFails: true });
    await session.hook(input(), output());
    expect(session.logs.at(-1)?.message).toBe('routing_failed');
  });
});

test('the exported server conforms to the Plugin type', () => {
  const typed: Plugin = server;
  expect(typed).toBe(server);
});
