import { describe, expect, test } from 'bun:test';

import { Effect } from 'effect';

import { askJev, QUESTIONS, type JevAnswers } from '../src/jev';

const result: JevAnswers = {
  kind: { type: 'choice', choice: 'mechanical', confidence: 0.9 },
  reasoning: { type: 'score', score: 0.4, confidence: 0.8 },
  keep_parent: { type: 'noul', noul: 0.1 },
};

function bodyText(body: unknown): string {
  if (typeof body !== 'string') throw new TypeError('Expected a string request body');
  return body;
}

describe('askJev', () => {
  test('sends a bounded Decisions API request and returns answers', async () => {
    let request: { url?: string; init?: RequestInit } = {};
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      request = {
        url: url instanceof Request ? url.url : url.toString(),
        ...(init === undefined ? {} : { init }),
      };
      return Response.json({ answers: result });
    };

    const answers = await Effect.runPromise(
      askJev(
        {
          apiKey: 'secret',
          state: { subagent_type: 'general', description: 'format', prompt: 'x'.repeat(2100) },
          timeoutMs: 1234,
        },
        fetcher,
      ),
    );
    expect(answers).toEqual(result);

    expect(request.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(request.init?.method).toBe('POST');
    expect(request.init?.headers).toEqual({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(bodyText(request.init?.body)) as {
      model: string;
      state: { subagent_type: string; description: string; prompt: string };
      questions: unknown;
    };
    expect(body).toEqual({
      model: 'typesafe/jev-1.13',
      state: { subagent_type: 'general', description: 'format', prompt: 'x'.repeat(2000) },
      questions: QUESTIONS,
    });
  });

  test('fills optional state fields with empty strings', async () => {
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init?.body)) as {
        state: { subagent_type: string; description: string; prompt: string };
      };
      expect(body.state).toEqual({ subagent_type: '', description: '', prompt: 'prompt' });
      return Response.json({ answers: result });
    };

    await Effect.runPromise(askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 10 }, fetcher));
  });

  test('uses the global fetch adapter by default', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ answers: result })) as unknown as typeof fetch;
    try {
      const answers = await Effect.runPromise(askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 100 }));
      expect(answers).toEqual(result);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns tagged request and response-body transport failures', async () => {
    const requestError = await Effect.runPromise(
      Effect.flip(
        askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 100 }, async () => {
          throw new Error('offline');
        }),
      ),
    );
    expect(requestError).toMatchObject({ _tag: 'JevTransportError', operation: 'request' });

    const responseError = await Effect.runPromise(
      Effect.flip(
        askJev(
          { apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 100 },
          async () =>
            ({ ok: true, text: async () => Promise.reject(new Error('body unavailable')) }) as unknown as Response,
        ),
      ),
    );
    expect(responseError).toMatchObject({ _tag: 'JevTransportError', operation: 'response_body' });
  });

  test('includes the response body in tagged HTTP errors', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        askJev(
          { apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 100 },
          async () => new Response('rate limited', { status: 429 }),
        ),
      ),
    );
    expect(error).toMatchObject({ status: 429, body: 'rate limited' });
  });

  test('rejects invalid JSON and malformed successful responses', async () => {
    const invalidJson = await Effect.runPromise(
      Effect.flip(
        askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 100 }, async () => new Response('{')),
      ),
    );
    expect(invalidJson._tag).toBe('JevResponseError');

    const malformed = [
      {},
      { ...result, kind: { ...result.kind, choice: 'invalid' } },
      { ...result, kind: { ...result.kind, confidence: Number.NaN } },
      { ...result, reasoning: { ...result.reasoning, score: 3 } },
      { ...result, reasoning: { ...result.reasoning, confidence: -0.1 } },
      { ...result, keep_parent: { ...result.keep_parent, noul: Number.POSITIVE_INFINITY } },
    ];

    for (const answers of malformed) {
      const error = await Effect.runPromise(
        Effect.flip(
          askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 100 }, async () =>
            Response.json({ answers }),
          ),
        ),
      );
      expect(error._tag).toBe('JevResponseError');
    }
  });

  test('times out and aborts a stalled request', async () => {
    let signal: AbortSignal | undefined;
    const error = await Effect.runPromise(
      Effect.flip(
        askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 10 }, async (_url, init) => {
          signal = init?.signal ?? undefined;
          return await new Promise<Response>(() => {});
        }),
      ),
    );
    expect(error._tag).toBe('OperationTimeoutError');
    expect(signal?.aborted).toBeTrue();
  });
});
