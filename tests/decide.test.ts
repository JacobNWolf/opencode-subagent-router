import { describe, expect, test } from 'bun:test';

import { decide } from '../src/decide';
import type { JevAnswers } from '../src/jev';

const answers = (overrides: Partial<JevAnswers> = {}): JevAnswers => ({
  kind: { type: 'choice', choice: 'search', confidence: 0.9 },
  reasoning: { type: 'score', score: 0.2, confidence: 0.9 },
  keep_parent: { type: 'noul', noul: 0.1 },
  ...overrides,
});

describe('decide', () => {
  test('keeps low-confidence tasks', () => {
    expect(decide(answers({ kind: { type: 'choice', choice: 'search', confidence: 0.49 } }))).toEqual({
      action: 'keep',
      reason: 'low_confidence',
    });
    expect(decide(answers({ reasoning: { type: 'score', score: 0, confidence: 0.4 } }), 0.6).reason).toBe(
      'low_confidence',
    );
  });

  test('keeps tasks with a high keep-parent probability', () => {
    expect(decide(answers({ keep_parent: { type: 'noul', noul: 0.55 } }))).toEqual({
      action: 'keep',
      reason: 'keep_parent_noul',
    });
  });

  test('keeps hard kinds and high-reasoning tasks', () => {
    expect(decide(answers({ kind: { type: 'choice', choice: 'architecture', confidence: 1 } })).reason).toBe(
      'hard_task',
    );
    expect(decide(answers({ reasoning: { type: 'score', score: 1.5, confidence: 1 } })).reason).toBe('hard_task');
  });

  test('downgrades a confident cheap task', () => {
    expect(decide(answers())).toEqual({ action: 'downgrade', reason: 'cheap_task' });
  });
});
