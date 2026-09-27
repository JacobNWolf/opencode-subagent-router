import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Option } from 'effect';

import {
  catalogFromProviders,
  getOpenRouterApiKey,
  latestAssistantModel,
  parseOptions,
  readOpenCodeOpenRouterKey,
} from '../src/runtime';

describe('parseOptions', () => {
  test('uses defaults for absent or invalid values', () => {
    expect(parseOptions()).toEqual({ timeoutMs: 2000, confidenceMin: 0.5, routes: [] });
    expect(parseOptions({ timeoutMs: Number.NaN, confidenceMin: 2, routes: 'nope' })).toEqual({
      timeoutMs: 2000,
      confidenceMin: 0.5,
      routes: [],
    });
    expect(parseOptions({ timeoutMs: 0, confidenceMin: Number.POSITIVE_INFINITY })).toEqual({
      timeoutMs: 2000,
      confidenceMin: 0.5,
      routes: [],
    });
  });

  test('accepts valid values and removes malformed routes', () => {
    const valid = {
      parent: { model: 'openai/sol', variant: ['high', 'max'] },
      fast: { model: 'openai/luna', variant: 'low' },
    };
    const stringVariant = { parent: { model: 'openai/sol', variant: 'high' }, fast: { model: 'openai/luna' } };
    expect(
      parseOptions({
        timeoutMs: 500,
        confidenceMin: 0,
        routes: [
          null,
          {},
          { parent: null, fast: {} },
          { parent: {}, fast: {} },
          { parent: { model: 1 }, fast: {} },
          { parent: { model: 'x', variant: 3 }, fast: { model: 'y' } },
          { parent: { model: 'x', variant: ['high', 3] }, fast: { model: 'y' } },
          { parent: { model: 'x' }, fast: { model: 3 } },
          valid,
          stringVariant,
        ],
      }),
    ).toEqual({ timeoutMs: 500, confidenceMin: 0, routes: [valid, stringVariant] });
  });
});

describe('catalogFromProviders', () => {
  test('preserves selectable IDs, source IDs, and known metadata', () => {
    expect(catalogFromProviders(undefined)).toEqual([]);
    const result = catalogFromProviders([
      {
        id: 'openai',
        models: {
          sol: {
            id: 'gpt-sol',
            name: 'GPT Sol',
            family: 'gpt',
            tool_call: true,
            attachment: true,
            status: 'active',
            cost: { input: 10, output: 20 },
            limit: { context: 1000, output: 200 },
            modalities: { input: ['text'], output: ['text'] },
            variants: { low: {} },
          },
          luna: { capabilities: { toolcall: false, attachment: false } },
          rawWins: {
            tool_call: true,
            capabilities: { toolcall: false },
          },
          flagged: {
            capabilities: { input: { text: true, image: false }, output: { text: true } },
          },
          bare: {},
        },
      },
    ]);
    expect(result).toEqual([
      {
        providerID: 'openai',
        modelID: 'sol',
        sourceID: 'gpt-sol',
        name: 'GPT Sol',
        family: 'gpt',
        status: 'active',
        cost: { bands: [{ fromContext: 0, price: { input: 10, output: 20 } }] },
        capabilities: {
          attachment: true,
          reasoning: false,
          toolCall: true,
          structuredOutput: false,
          input: new Set(['text']),
          output: new Set(['text']),
        },
        limits: { context: 1000, output: 200 },
        variants: new Set(['low']),
      },
      {
        providerID: 'openai',
        modelID: 'luna',
        capabilities: {
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          input: new Set(),
          output: new Set(),
        },
        variants: new Set(),
      },
      {
        providerID: 'openai',
        modelID: 'rawWins',
        capabilities: {
          attachment: false,
          reasoning: false,
          toolCall: true,
          structuredOutput: false,
          input: new Set(),
          output: new Set(),
        },
        variants: new Set(),
      },
      {
        providerID: 'openai',
        modelID: 'flagged',
        capabilities: {
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          input: new Set(['text']),
          output: new Set(['text']),
        },
        variants: new Set(),
      },
      {
        providerID: 'openai',
        modelID: 'bare',
        variants: new Set(),
      },
    ]);
  });

  test('omits malformed optional metadata instead of inventing values', () => {
    const [model] = catalogFromProviders([
      {
        id: 'openai',
        models: {
          broken: {
            cost: { input: Number.NaN, output: 1 },
            limit: { context: 1000 },
            modalities: { input: ['text', 'nope'], output: ['text'] },
          },
        },
      },
    ]);
    expect(model).toEqual({
      providerID: 'openai',
      modelID: 'broken',
      variants: new Set(),
    });
  });
});

describe('latestAssistantModel', () => {
  test('finds the newest valid assistant independently of array order', () => {
    expect(latestAssistantModel(undefined)).toBeUndefined();
    const messages = [
      { info: { role: 'user' } },
      { info: { role: 'assistant', modelID: 'missing-provider' } },
      { info: { role: 'assistant', providerID: 'openai', modelID: 'older', time: { created: 1 } } },
      { info: { role: 'assistant', providerID: 'openai', modelID: 'no-time' } },
      { info: { role: 'assistant', providerID: 'openai', modelID: 'newer', variant: 'high', time: { created: 2 } } },
    ];
    expect(latestAssistantModel(messages)).toEqual({ providerID: 'openai', modelID: 'newer', variant: 'high' });
  });
});

describe('OpenRouter credentials', () => {
  test('reads and trims the OpenCode auth key', async () => {
    let path = '';
    const key = await Effect.runPromise(
      readOpenCodeOpenRouterKey({ XDG_DATA_HOME: '/data' }, (requested) => {
        path = requested;
        return JSON.stringify({ openrouter: { key: '  auth-key  ' } });
      }),
    );
    expect(Option.getOrUndefined(key)).toBe('auth-key');
    expect(path).toBe('/data/opencode/auth.json');
  });

  test('returns tagged failures for unreadable or malformed auth data', async () => {
    const inputs = ['{', 'null', JSON.stringify({ openrouter: null }), JSON.stringify({ openrouter: { key: 3 } })];
    for (const input of inputs) {
      const error = await Effect.runPromise(Effect.flip(readOpenCodeOpenRouterKey({}, () => input)));
      expect(error._tag).toBe('CredentialError');
    }
    const unreadable = await Effect.runPromise(
      Effect.flip(
        readOpenCodeOpenRouterKey({}, () => {
          throw new Error('missing');
        }),
      ),
    );
    expect(unreadable._tag).toBe('CredentialError');

    const empty = await Effect.runPromise(
      readOpenCodeOpenRouterKey({}, () => JSON.stringify({ openrouter: { key: ' ' } })),
    );
    expect(Option.isNone(empty)).toBeTrue();
  });

  test('prefers the environment and otherwise uses the auth file', async () => {
    const direct = await Effect.runPromise(getOpenRouterApiKey({ OPENROUTER_API_KEY: ' direct ' }, () => 'not json'));
    expect(Option.getOrUndefined(direct)).toBe('direct');

    const stored = await Effect.runPromise(
      getOpenRouterApiKey({ OPENROUTER_API_KEY: ' ', XDG_DATA_HOME: '/data' }, () =>
        JSON.stringify({ openrouter: { key: 'stored' } }),
      ),
    );
    expect(Option.getOrUndefined(stored)).toBe('stored');

    const missing = await Effect.runPromise(
      getOpenRouterApiKey({}, () => {
        throw new Error('missing');
      }),
    );
    expect(Option.isNone(missing)).toBeTrue();
  });

  test('uses the real file reader with XDG_DATA_HOME', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-router-'));
    const authDirectory = join(directory, 'opencode');
    mkdirSync(authDirectory);
    writeFileSync(join(authDirectory, 'auth.json'), JSON.stringify({ openrouter: { key: 'file-key' } }));
    try {
      const key = await Effect.runPromise(readOpenCodeOpenRouterKey({ XDG_DATA_HOME: directory }));
      expect(Option.getOrUndefined(key)).toBe('file-key');
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test('provides safe defaults for the process environment and file reader', async () => {
    const authExit = await Effect.runPromise(Effect.exit(readOpenCodeOpenRouterKey()));
    const keyExit = await Effect.runPromise(Effect.exit(getOpenRouterApiKey()));
    expect(authExit._tag === 'Success' || authExit._tag === 'Failure').toBeTrue();
    expect(keyExit._tag).toBe('Success');
  });
});
