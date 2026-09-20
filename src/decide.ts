import type { JevAnswers } from './jev';

export type Verdict =
  | { readonly action: 'keep'; readonly reason: 'low_confidence' | 'keep_parent_noul' | 'hard_task' }
  | { readonly action: 'downgrade'; readonly reason: 'cheap_task' };

const HARD_KINDS: ReadonlySet<JevAnswers['kind']['choice']> = new Set(['architecture', 'diagnosis']);

export function decide(answers: JevAnswers, confidenceMin = 0.5): Verdict {
  if (answers.kind.confidence < confidenceMin || answers.reasoning.confidence < confidenceMin) {
    return { action: 'keep', reason: 'low_confidence' };
  }

  if (answers.keep_parent.noul >= 0.55) {
    return { action: 'keep', reason: 'keep_parent_noul' };
  }

  if (HARD_KINDS.has(answers.kind.choice) || answers.reasoning.score >= 1.5) {
    return { action: 'keep', reason: 'hard_task' };
  }

  return { action: 'downgrade', reason: 'cheap_task' };
}
