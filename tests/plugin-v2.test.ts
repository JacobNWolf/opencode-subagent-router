import { describe, expect, test } from 'bun:test';

import plugin from '../src/index';
import type { JevAnswers } from '../src/jev';
import { cheapAnswers, parentCaller, setupPlugin } from './plugin-v2-fixture';

const hardAnswers: JevAnswers = { ...cheapAnswers, kind: { type: 'choice', choice: 'diagnosis', confidence: 1 } };
const task = (overrides: Record<string, unknown> = {}) => ({ agent: 'explore', prompt: 'find files', ...overrides });

describe('V2 subagent routing', () => {
  test('exports one definition for V1 and V2 hosts', () => {
    expect(plugin.id).toBe('opencode-subagent-router');
    expect(plugin.effect).toBeFunction();
    expect(plugin.server).toBeFunction();
  });

  test('ignores other tools, follow-ups, and pinned models', async () => {
    const fixture = await setupPlugin({ key: 'key' });
    expect(await fixture.run('read', { filePath: 'x' })).toEqual({ filePath: 'x' });
    expect(fixture.logs).toEqual([]);

    expect(await fixture.run('subagent', task({ sessionID: 'child' }))).toEqual(task({ sessionID: 'child' }));
    expect(fixture.logs.at(-1)).toBe('follow_up');

    expect(await fixture.run('subagent', task({ model: 'claude-agent/sonnet' }))).toEqual(
      task({ model: 'claude-agent/sonnet' }),
    );
    expect(fixture.logs.at(-1)).toBe('pinned_model');

    const agentPinned = await setupPlugin({ key: 'key', agentModel: { providerID: 'claude-agent', id: 'sonnet' } });
    expect(await agentPinned.run('subagent', task())).toEqual(task());
    expect(agentPinned.logs.at(-1)).toBe('pinned_model');
    expect(fixture.asked).toEqual([]);
  });

  test('skips nested callers and callers without a model', async () => {
    const nested = await setupPlugin({ key: 'key', caller: { parentID: 'root', ...parentCaller } });
    await nested.run('subagent', task());
    expect(nested.logs.at(-1)).toBe('not_primary_child');

    const unknown = await setupPlugin({ key: 'key', caller: {} });
    await unknown.run('subagent', task());
    expect(unknown.logs.at(-1)).toBe('parent_model_unavailable');
  });

  test('sets the fast model and variant for cheap work', async () => {
    const fixture = await setupPlugin({ key: 'key', options: { timeoutMs: 321 } });
    expect(await fixture.run('subagent', task())).toEqual(task({ model: 'claude-agent/opus#low' }));
    expect(fixture.asked).toEqual([
      { apiKey: 'key', state: { subagent_type: 'explore', prompt: 'find files' }, timeoutMs: 321 },
    ]);
    expect(fixture.logs.at(-1)).toBe('cheap_task');
  });

  test('writes a target without a variant from an explicit route', async () => {
    const fixture = await setupPlugin({
      key: 'key',
      caller: { model: { providerID: 'claude-agent', id: 'opus' } },
      options: { routes: [{ parent: { model: 'claude-agent/opus' }, fast: { model: 'claude-agent/sonnet' } }] },
    });
    expect((await fixture.run('subagent', task())).model).toBe('claude-agent/sonnet');
  });

  test('keeps the parent for hard work or without a target', async () => {
    const hard = await setupPlugin({ key: 'key', answers: hardAnswers });
    expect(await hard.run('subagent', task())).toEqual(task());
    expect(hard.logs.at(-1)).toBe('hard_task');

    const noTarget = await setupPlugin({ key: 'key', caller: { model: { providerID: 'claude-agent', id: 'opus' } } });
    expect(await noTarget.run('subagent', task())).toEqual(task());
    expect(noTarget.logs.at(-1)).toBe('no_fast_target');
  });

  test('fails open on OpenCode and classifier errors', async () => {
    const session = await setupPlugin({ key: 'key', sessionFails: true });
    expect(await session.run('subagent', task())).toEqual(task());
    expect(session.logs.at(-1)).toBe('routing_failed');

    const catalog = await setupPlugin({ key: 'key', modelsFail: true });
    expect(await catalog.run('subagent', task())).toEqual(task());
    expect(catalog.logs).toContain('catalog_load_failed');

    const classifier = await setupPlugin({ key: 'key', askFails: true });
    expect(await classifier.run('subagent', task())).toEqual(task());
    expect(classifier.logs.at(-1)).toBe('routing_failed');
  });

  test('picks the middle rung of an explicit route ladder', async () => {
    const routes = [
      {
        parent: { model: 'claude-agent/opus' },
        fast: [
          { model: 'claude-agent/haiku', variant: 'low' },
          { model: 'claude-agent/sonnet', variant: 'low' },
        ],
      },
    ];
    const { run } = await setupPlugin({
      key: 'key',
      options: { routes },
      answers: { ...cheapAnswers, reasoning: { type: 'score', score: 1, confidence: 1 } },
    });
    expect((await run('subagent', task())).model).toBe('claude-agent/sonnet#low');
  });
});
