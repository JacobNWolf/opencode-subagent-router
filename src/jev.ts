import { Effect, Schema } from 'effect';

import { withOperationTimeout, type OperationTimeoutError } from './errors';

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
const KIND_CHOICES = [
  'search',
  'research',
  'mechanical',
  'review',
  'implementation',
  'architecture',
  'diagnosis',
] as const;

export const QUESTIONS = {
  kind: {
    type: 'choice' as const,
    instructions: 'What kind of coding-agent task is this?',
    criteria: {
      search: 'Find files, grep, quote existing code. No edits.',
      research: 'Read code and explain or summarize what exists. No edits or design decisions.',
      mechanical: 'Rename, format, apply a stated patch, boilerplate.',
      review: 'Read diffs and report issues. No implementation.',
      implementation: 'Write or change behavior in a bounded way.',
      architecture: 'Design or restructure across modules, APIs, or data models.',
      diagnosis: 'Hunt a subtle bug, race, or production failure.',
    },
  },
  reasoning: {
    type: 'score' as const,
    instructions: 'How much reasoning does this task need?',
    criteria: [
      'Lookup, grep, or reading and summarizing code. A fast model is enough.',
      'Focused coding or tracing in a known area.',
      'Deep design, cross-system analysis, or a subtle bug. Keep the parent model.',
    ],
  },
  keep_parent: {
    type: 'noul' as const,
    instructions: 'This task requires judgment beyond reading code and reporting what it finds.',
    criteria: {
      true: 'Needs design judgment, cross-system synthesis, root-cause debugging, or tradeoff decisions.',
      false: 'Reading code and reporting findings, even thoroughly, or applying a clearly specified change.',
    },
  },
};

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const JevAnswersSchema = Schema.Struct({
  kind: Schema.Struct({
    type: Schema.Literal('choice'),
    choice: Schema.Literals(KIND_CHOICES),
    confidence: Probability,
  }),
  reasoning: Schema.Struct({
    type: Schema.Literal('score'),
    score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: QUESTIONS.reasoning.criteria.length - 1 })),
    confidence: Probability,
  }),
  keep_parent: Schema.Struct({
    type: Schema.Literal('noul'),
    noul: Probability,
  }),
});
const JevResponseSchema = Schema.fromJsonString(Schema.Struct({ answers: JevAnswersSchema }));

export type JevAnswers = typeof JevAnswersSchema.Type;

export type JevTransportError = {
  readonly _tag: 'JevTransportError';
  readonly operation: 'request' | 'response_body';
  readonly cause: unknown;
};

export type JevHttpError = {
  readonly _tag: 'JevHttpError';
  readonly status: number;
  readonly body: string;
};

export type JevResponseError = {
  readonly _tag: 'JevResponseError';
  readonly cause: unknown;
};

export const jevTransportError = (operation: JevTransportError['operation'], cause: unknown): JevTransportError => ({
  _tag: 'JevTransportError',
  operation,
  cause,
});

const jevHttpError = (status: number, body: string): JevHttpError => ({ _tag: 'JevHttpError', status, body });

const jevResponseError = (cause: unknown): JevResponseError => ({ _tag: 'JevResponseError', cause });

export type JevError = JevTransportError | JevHttpError | JevResponseError | OperationTimeoutError;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function askJev(
  input: {
    readonly apiKey: string;
    readonly state: { readonly subagent_type?: string; readonly description?: string; readonly prompt: string };
    readonly timeoutMs: number;
  },
  fetcher: Fetcher = fetch,
): Effect.Effect<JevAnswers, JevError> {
  const request = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(JEV_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: JEV_MODEL,
            state: {
              subagent_type: input.state.subagent_type ?? '',
              description: input.state.description ?? '',
              prompt: input.state.prompt.slice(0, 2000),
            },
            questions: QUESTIONS,
          }),
          signal,
        }),
      catch: (cause) => jevTransportError('request', cause),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => jevTransportError('response_body', cause),
    });

    if (!response.ok) {
      return yield* Effect.fail(jevHttpError(response.status, body));
    }

    const parsed = yield* Schema.decodeUnknownEffect(JevResponseSchema)(body).pipe(Effect.mapError(jevResponseError));
    return parsed.answers;
  });

  return withOperationTimeout(request, 'jev_request', input.timeoutMs);
}
