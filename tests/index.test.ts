import { describe, expect, test } from 'bun:test';

import type { Catalog } from '@opencode-ai/models/effect';
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import { Effect, Option } from 'effect';

import { openCodeError } from '../src/errors';
import { createServer, server } from '../src/index';
import { jevTransportError, type JevAnswers } from '../src/jev';
import type { EnabledModel } from '../src/routing/types';

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

const emptyMetadata = { providers: {}, models: {} } as Catalog;
const unusedMetadata = () => Effect.succeed(emptyMetadata);

function variantCatalog(): EnabledModel[] {
  return [
    {
      providerID: 'openai',
      modelID: 'sol',
      family: 'gpt',
      cost: { bands: [{ fromContext: 0, price: { input: 10, output: 10 } }] },
      variants: new Set(['low', 'high']),
    },
  ];
}

async function hooksFor(
  setup: ClientSetup,
  dependencies: {
    key?: string;
    catalog?: EnabledModel[];
    metadata?: Catalog;
    metadataFails?: boolean;
    answers?: JevAnswers;
    askFails?: boolean;
  } = {},
) {
  const fixture = makeClient(setup);
  const plugin = createServer({
    apiKey: () => Effect.succeed(Option.fromNullishOr(dependencies.key)),
    loadCatalog: () => Effect.succeed(dependencies.catalog ?? variantCatalog()),
    loadModelMetadata: () => {
      if (dependencies.metadataFails) {
        return Effect.fail({ _tag: 'ModelMetadataLoadError', cause: new Error('metadata unavailable') });
      }
      return Effect.succeed(dependencies.metadata ?? emptyMetadata);
    },
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
    let metadataCalls = 0;
    const initializing = createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadModelMetadata: () =>
        Effect.suspend(() => {
          metadataCalls += 1;
          return Effect.die('metadata should remain lazy');
        }),
    })({ client: fixture.client } as PluginInput);

    await Promise.resolve();
    expect(fixture.providerCalls).toBe(0);
    expect(metadataCalls).toBe(0);

    const hooks = await initializing;
    expect(hooks['chat.message']).toBeFunction();
    expect(metadataCalls).toBe(0);
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
    const plugin = createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadModelMetadata: unusedMetadata,
    });
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
      loadModelMetadata: unusedMetadata,
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
      loadModelMetadata: unusedMetadata,
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
    const hooks = await createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadModelMetadata: unusedMetadata,
    })({ client: fixture.client } as PluginInput, {
      timeoutMs: 10,
    });

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
    const hooks = await createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadModelMetadata: unusedMetadata,
    })({
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
      loadModelMetadata: unusedMetadata,
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
    const catalog: EnabledModel[] = [
      {
        providerID: 'openai',
        modelID: 'sol',
        family: 'gpt',
        cost: { bands: [{ fromContext: 0, price: { input: 10, output: 10 } }] },
        variants: new Set(),
      },
      {
        providerID: 'openai',
        modelID: 'luna',
        family: 'gpt',
        capabilities: {
          attachment: false,
          reasoning: false,
          toolCall: true,
          structuredOutput: false,
          input: new Set(),
          output: new Set(),
        },
        cost: { bands: [{ fromContext: 0, price: { input: 1, output: 1 } }] },
        variants: new Set(),
      },
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

  test('shares one lazy metadata load across concurrent messages', async () => {
    let metadataCalls = 0;
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages(),
    });
    const plugin = createServer({
      apiKey: () => Effect.succeed(Option.none()),
      loadCatalog: () => Effect.succeed(variantCatalog()),
      loadModelMetadata: () =>
        Effect.sync(() => {
          metadataCalls += 1;
          return emptyMetadata;
        }),
    });
    const hooks = await plugin({ client: fixture.client } as PluginInput);
    await Promise.all([hooks['chat.message']!(input(), output()), hooks['chat.message']!(input(), output())]);
    expect(metadataCalls).toBe(1);
  });

  test('metadata failure falls back without calling Jev when no other target exists', async () => {
    let asked = false;
    const fixture = makeClient({
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: parentMessages('sol', 'medium'),
    });
    const plugin = createServer({
      apiKey: () => Effect.succeed(Option.some('key')),
      loadCatalog: () => Effect.succeed([]),
      loadModelMetadata: () => Effect.fail({ _tag: 'ModelMetadataLoadError', cause: new Error('offline') }),
      ask: () => {
        asked = true;
        return Effect.succeed(cheapAnswers);
      },
    });
    const hooks = await plugin({ client: fixture.client } as PluginInput);
    await hooks['chat.message']!(input('medium'), output('sol', 'medium'));
    expect(asked).toBeFalse();
    expect(fixture.logs.some((entry) => entry.message === 'model_metadata_load_failed')).toBeTrue();
    expect(fixture.logs.at(-1)?.message).toBe('no_fast_target');
  });

  test('mutates a cross-model target and keeps the parent when Jev says the work is hard', async () => {
    const capabilities = {
      attachment: true,
      reasoning: true,
      toolCall: true,
      structuredOutput: true,
      input: new Set(['text'] as const),
      output: new Set(['text'] as const),
    };
    const catalog: EnabledModel[] = [
      {
        providerID: 'acme',
        modelID: 'nebula-9-grand',
        sourceID: 'nebula-9-grand',
        name: 'nebula-9-grand',
        family: 'nebula-grand',
        releaseDate: '2030-01-01',
        cost: { bands: [{ fromContext: 0, price: { input: 12, output: 48 } }] },
        capabilities,
        limits: { context: 100_000, output: 16_000 },
        variants: new Set(['low', 'high']),
      },
      {
        providerID: 'acme',
        modelID: 'nebula-9-small',
        sourceID: 'nebula-9-small',
        name: 'nebula-9-small',
        family: 'nebula-small',
        releaseDate: '2030-01-01',
        cost: { bands: [{ fromContext: 0, price: { input: 1, output: 4 } }] },
        capabilities,
        limits: { context: 100_000, output: 16_000 },
        variants: new Set(['low', 'high']),
      },
    ];
    const metadata = {
      models: {
        'acme/nebula-9-grand': {
          id: 'acme/nebula-9-grand',
          name: 'nebula-9-grand',
          description: 'grand',
          family: 'nebula-grand',
          release_date: '2030-01-01',
          limit: { context: 100_000 },
        },
        'acme/nebula-9-small': {
          id: 'acme/nebula-9-small',
          name: 'nebula-9-small',
          description: 'small',
          family: 'nebula-small',
          release_date: '2030-01-01',
          limit: { context: 100_000 },
        },
      },
      providers: {
        acme: {
          id: 'acme',
          env: [],
          npm: 'none',
          name: 'acme',
          doc: 'https://example.test',
          models: {
            'nebula-9-grand': {
              id: 'nebula-9-grand',
              name: 'nebula-9-grand',
              description: 'grand',
              family: 'nebula-grand',
              attachment: true,
              reasoning: true,
              tool_call: true,
              structured_output: true,
              release_date: '2030-01-01',
              last_updated: '2030-01-01',
              modalities: { input: ['text'], output: ['text'] },
              open_weights: false,
              limit: { context: 100_000, output: 16_000 },
              cost: { input: 12, output: 48 },
            },
            'nebula-9-small': {
              id: 'nebula-9-small',
              name: 'nebula-9-small',
              description: 'small',
              family: 'nebula-small',
              attachment: true,
              reasoning: true,
              tool_call: true,
              structured_output: true,
              release_date: '2030-01-01',
              last_updated: '2030-01-01',
              modalities: { input: ['text'], output: ['text'] },
              open_weights: false,
              limit: { context: 100_000, output: 16_000 },
              cost: { input: 1, output: 4 },
            },
          },
        },
      },
    } as unknown as Catalog;

    const setup = {
      child: { id: 'child', parentID: 'parent' },
      parent: { id: 'parent' },
      messages: [
        {
          info: {
            role: 'assistant',
            providerID: 'acme',
            modelID: 'nebula-9-grand',
            variant: 'high',
            time: { created: 1 },
          },
        },
      ],
    };

    const cheap = await hooksFor(setup, { key: 'key', catalog, metadata });
    const routed = output('nebula-9-grand', 'high');
    (routed as { message: { model: { providerID: string } } }).message.model.providerID = 'acme';
    await cheap.hook(input(), routed);
    expect((routed as { message: { model: unknown } }).message.model).toEqual({
      providerID: 'acme',
      modelID: 'nebula-9-small',
      variant: 'low',
    });

    const hard = await hooksFor(setup, { key: 'key', catalog, metadata, answers: hardAnswers });
    const kept = output('nebula-9-grand', 'high');
    (kept as { message: { model: { providerID: string } } }).message.model.providerID = 'acme';
    await hard.hook(input(), kept);
    expect((kept as { message: { model: unknown } }).message.model).toEqual({
      providerID: 'acme',
      modelID: 'nebula-9-grand',
      variant: 'high',
    });
  });
});

test('the exported server conforms to the Plugin type', () => {
  const typed: Plugin = server;
  expect(typed).toBe(server);
});
