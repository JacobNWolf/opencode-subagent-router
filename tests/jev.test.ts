import { describe, expect, test } from 'bun:test';

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
      request = { url: url instanceof Request ? url.url : url.toString(), init };
      return Response.json({ answers: result });
    };

    const answers = await askJev(
      {
        apiKey: 'secret',
        state: { subagent_type: 'general', description: 'format', prompt: 'x'.repeat(2100) },
        timeoutMs: 1234,
      },
      fetcher,
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

    await askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 10 }, fetcher);
  });

  test('includes the response body in HTTP errors', async () => {
    const fetcher = async () => new Response('rate limited', { status: 429 });
    let error: unknown;
    try {
      await askJev({ apiKey: 'key', state: { prompt: 'prompt' }, timeoutMs: 10 }, fetcher);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Jev 429: rate limited');
  });
});
