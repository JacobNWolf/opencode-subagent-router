import { describe, expect, test } from 'bun:test';

import { cartesianProduct } from 'es-toolkit';

import { decide, type Verdict } from '../src/decide';
import type { JevAnswers } from '../src/jev';

const answers = (overrides: Partial<JevAnswers> = {}): JevAnswers => ({
  kind: { type: 'choice', choice: 'search', confidence: 0.9 },
  reasoning: { type: 'score', score: 0.2, confidence: 0.9 },
  keep_parent: { type: 'noul', noul: 0.1 },
  ...overrides,
});

const at = (score: number, noul = 0.1) =>
  answers({ reasoning: { type: 'score', score, confidence: 0.9 }, keep_parent: { type: 'noul', noul } });
const rungOf = (verdict: Verdict) => (verdict.action === 'downgrade' ? verdict.rung : verdict.reason);

describe('decide', () => {
  test('keeps low-confidence tasks', () => {
    expect(decide(answers({ kind: { type: 'choice', choice: 'search', confidence: 0.49 } }), 1)).toEqual({
      action: 'keep',
      reason: 'low_confidence',
    });
    expect(decide(answers({ reasoning: { type: 'score', score: 0, confidence: 0.4 } }), 1, 0.6).reason).toBe(
      'low_confidence',
    );
  });

  test('keeps tasks with a high keep-parent probability', () => {
    expect(decide(answers({ keep_parent: { type: 'noul', noul: 0.55 } }), 1)).toEqual({
      action: 'keep',
      reason: 'keep_parent_noul',
    });
  });

  test('keeps hard kinds and high-reasoning tasks', () => {
    expect(decide(answers({ kind: { type: 'choice', choice: 'architecture', confidence: 1 } }), 1).reason).toBe(
      'hard_task',
    );
    expect(decide(answers({ reasoning: { type: 'score', score: 1.5, confidence: 1 } }), 1).reason).toBe('hard_task');
  });

  test('downgrades a confident cheap task', () => {
    expect(decide(answers(), 1)).toEqual({ action: 'downgrade', reason: 'cheap_task', rung: 0 });
  });

  test('a single rung reproduces the binary verdict', () => {
    const kinds = ['search', 'mechanical', 'review', 'implementation', 'architecture', 'diagnosis'] as const;
    for (const [choice, score, noul, confidence] of cartesianProduct(
      kinds,
      [0, 0.5, 0.75, 1, 1.49, 1.5, 2],
      [0, 0.35, 0.54, 0.55],
      [0.49, 0.9],
    )) {
      const input = answers({
        kind: { type: 'choice', choice, confidence },
        reasoning: { type: 'score', score, confidence: 0.9 },
        keep_parent: { type: 'noul', noul },
      });

      const legacy =
        confidence < 0.5 || noul >= 0.55 || choice === 'architecture' || choice === 'diagnosis' || score >= 1.5
          ? 'keep'
          : 'downgrade';

      const verdict = decide(input, 1);

      expect(verdict.action).toBe(legacy);
      if (verdict.action === 'downgrade') expect(verdict.rung).toBe(0);
    }
  });

  test('splits the downgrade range into equal bands', () => {
    expect([0, 0.74, 0.75, 1.49, 1.5].map((score) => rungOf(decide(at(score), 2)))).toEqual([0, 0, 1, 1, 'hard_task']);
    expect([0.49, 0.5, 0.99, 1].map((score) => rungOf(decide(at(score), 3)))).toEqual([0, 1, 1, 2]);
  });

  test('steps up one rung on a moderate keep-parent signal, clamped to the top', () => {
    expect(rungOf(decide(at(0.2, 0.35), 2))).toBe(1);
    expect(rungOf(decide(at(1, 0.35), 2))).toBe(1);
    expect(rungOf(decide(at(0.2, 0.34), 2))).toBe(0);
  });
});
