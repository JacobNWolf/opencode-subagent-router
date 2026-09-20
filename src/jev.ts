import * as z from 'zod';

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';

export const QUESTIONS = {
  kind: {
    type: 'choice' as const,
    instructions: 'What kind of coding-agent task is this?',
    criteria: {
      search: 'Find files, grep, quote existing code. No edits.',
      mechanical: 'Rename, format, apply a stated patch, boilerplate.',
      review: 'Read diffs and report issues. No implementation.',
      implementation: 'Write or change behavior in a bounded way.',
      architecture: 'Design across modules, APIs, or data models.',
      diagnosis: 'Hunt a subtle bug, race, or production failure.',
    },
  },
  reasoning: {
    type: 'score' as const,
    instructions: 'How much reasoning does this task need?',
    criteria: [
      'Lookup or grep. A fast model is enough.',
      'Focused coding in a known area.',
      'Deep design or a subtle bug. Keep the parent model.',
    ],
  },
  keep_parent: {
    type: 'noul' as const,
    instructions: 'This task is likely to fail or waste time on a faster, lower-reasoning coding model.',
    criteria: {
      true: "Needs the parent model's reasoning.",
      false: 'A faster, cheaper coding model should handle it.',
    },
  },
};

const probability = z.number().min(0).max(1);
const kindChoices = Object.keys(QUESTIONS.kind.criteria) as [
  keyof typeof QUESTIONS.kind.criteria,
  ...(keyof typeof QUESTIONS.kind.criteria)[],
];

const JevAnswersSchema = z.object({
  kind: z.object({
    type: z.literal('choice'),
    choice: z.enum(kindChoices),
    confidence: probability,
  }),
  reasoning: z.object({
    type: z.literal('score'),
    score: z
      .number()
      .min(0)
      .max(QUESTIONS.reasoning.criteria.length - 1),
    confidence: probability,
  }),
  keep_parent: z.object({
    type: z.literal('noul'),
    noul: probability,
  }),
});

export type JevAnswers = z.infer<typeof JevAnswersSchema>;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function askJev(
  input: {
    apiKey: string;
    state: { subagent_type?: string; description?: string; prompt: string };
    timeoutMs: number;
  },
  fetcher: Fetcher = fetch,
): Promise<JevAnswers> {
  const res = await fetcher(JEV_URL, {
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
    signal: AbortSignal.timeout(input.timeoutMs),
  });

  if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);

  const body: unknown = await res.json();
  const answers = body && typeof body === 'object' ? (body as Record<string, unknown>).answers : undefined;
  const parsed = JevAnswersSchema.safeParse(answers);

  if (!parsed.success) {
    throw new TypeError('Jev returned malformed answers');
  }

  return parsed.data;
}
