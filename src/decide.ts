import type { JevAnswers } from './jev';

export type Verdict =
  | { readonly action: 'keep'; readonly reason: 'low_confidence' | 'keep_parent_noul' | 'hard_task' }
  | { readonly action: 'downgrade'; readonly reason: 'cheap_task'; readonly rung: number };

const HARD_KINDS: ReadonlySet<JevAnswers['kind']['choice']> = new Set(['architecture', 'diagnosis']);
const HARD_SCORE = 1.5;
const KEEP_NOUL = 0.55;
const STEP_UP_NOUL = 0.35;

function reasoningBand(answers: JevAnswers, rungCount: number): number {
  if (answers.kind.choice === 'research') return 0;
  return Math.floor((answers.reasoning.score * rungCount) / HARD_SCORE);
}

export function decide(answers: JevAnswers, rungCount: number, confidenceMin = 0.5): Verdict {
  if (answers.kind.confidence < confidenceMin) {
    return { action: 'keep', reason: 'low_confidence' };
  }

  if (answers.keep_parent.noul >= KEEP_NOUL) {
    return { action: 'keep', reason: 'keep_parent_noul' };
  }

  if (HARD_KINDS.has(answers.kind.choice) || answers.reasoning.score >= HARD_SCORE) {
    return { action: 'keep', reason: 'hard_task' };
  }

  const band = reasoningBand(answers, rungCount);
  const stepUp = answers.keep_parent.noul >= STEP_UP_NOUL ? 1 : 0;
  return { action: 'downgrade', reason: 'cheap_task', rung: Math.min(rungCount - 1, band + stepUp) };
}
