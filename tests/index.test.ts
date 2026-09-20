import { describe, expect, test } from 'bun:test';

import type { Plugin, PluginInput } from '@opencode-ai/plugin';

import { createServer, server } from '../src/index';
import type { JevAnswers } from '../src/jev';
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
};

function makeClient(setup: ClientSetup = {}) {
  const logs: Array<{ level: string; message: string }> = [];
  const toasts: unknown[] = [];
  const client = {
    app: {
      log: async ({ body }: { body: { level: string; message: string } }) => {
        logs.push(body);
        if (setup.logFails) throw new Error('log unavailable');
      },
    },
    config: {
      providers: async () => ({ data: { providers: setup.providers ?? [] } }),
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
  return { client: client as unknown as PluginInput['client'], logs, toasts };
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
    apiKey: () => dependencies.key,
    loadCatalog: async () => dependencies.catalog ?? variantCatalog(),
    ask: async () => {
      if (dependencies.askFails) throw new Error('Jev unavailable');
      return dependencies.answers ?? cheapAnswers;
    },
  });
  const hooks = await plugin({ client: fixture.client } as PluginInput, {
    timeoutMs: 321,
    confidenceMin: 0.75,
  });
  return { ...fixture, hook: hooks['chat.message']! };
}

describe('plugin initialization', () => {
  test('loads and normalizes the real provider adapter', async () => {
    const { client } = makeClient({
      providers: [{ id: 'openai', models: { sol: { family: 'gpt', cost: { input: 1 } } } }],
    });
    const hooks = await server({ client } as PluginInput);
    expect(hooks['chat.message']).toBeFunction();
  });

  test('fails open when catalog loading and logging fail', async () => {
    const fixture = makeClient({ logFails: true });
    const plugin = createServer({
      apiKey: () => undefined,
      loadCatalog: async () => {
        throw new Error('catalog unavailable');
      },
    });
    const hooks = await plugin({ client: fixture.client } as PluginInput);
    expect(hooks['chat.message']).toBeFunction();
    expect(fixture.logs.at(-1)?.message).toBe('catalog_load_failed');
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
      apiKey: () => 'key',
      loadCatalog: async () => variantCatalog(),
      ask: async (request) => {
        received = request;
        return cheapAnswers;
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
      { providerID: 'openai', id: 'luna', family: 'gpt', cost: { input: 1 } },
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
