import { describe, expect, test } from 'bun:test';

import type { CatalogModel } from '../src/runtime';
import { cheapAnswers, opus, setupPlugin, type Setup } from './plugin-v2-fixture';

const t3Tool = 't3-code-544c1eaf-e4af-483b-a4c5-4ea7a38b93d8_delegate_task';
const t3Task = (overrides: Record<string, unknown> = {}) => ({
  task: 'Explain this workspace project from its source files',
  role: 'research',
  title: 'Explain project',
  ...overrides,
});

const sol: CatalogModel = {
  ...opus,
  id: 'gpt-6.1-sol',
  modelID: 'gpt-6.1-sol',
  providerID: 'openai',
  name: 'GPT-6.1 Sol',
};
const low = { id: 'variant', value: 'low' };
const plan = { id: 'agent', value: 'plan' };
const routeTo = (fast: Record<string, unknown>) => ({
  options: { routes: [{ parent: { model: 'openai/gpt-6.1-sol' }, fast }] },
});

const setupT3 = (setup: Setup = {}) =>
  setupPlugin({
    key: 'key',
    caller: { model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' } },
    models: [sol],
    ...setup,
  });

const expectUnchanged = async (fixture: Awaited<ReturnType<typeof setupT3>>, input: Record<string, unknown>) => {
  const original = structuredClone(input);
  expect(await fixture.run(t3Tool, input)).toEqual(original);
};

describe('V2 T3 delegation routing', () => {
  test.each([
    t3Tool,
    't3_code_9243357a_8bb3_4ba5_9cba_66b4cb8135ab_delegate_task',
    't3-code_delegate_task',
    'mcp__t3-code__delegate_task',
    `mcp__${t3Tool}`,
    t3Tool.toUpperCase(),
  ])('routes cheap work through %s', async (tool) => {
    const fixture = await setupT3();
    expect(await fixture.run(tool, t3Task())).toEqual(
      t3Task({ target: { model: 'openai/gpt-6.1-sol', options: [low] } }),
    );
    expect(fixture.asked).toEqual([
      {
        apiKey: 'key',
        state: { subagent_type: 'research', prompt: t3Task().task },
        timeoutMs: 2000,
      },
    ]);
    expect(fixture.agentLookups).toEqual([]);
    expect(fixture.transports).toContain('t3');
  });

  test.each([{ options: { agent: 'plan' } }, { options: [plan] }])(
    'keeps caller options in either form: %j',
    async ({ options }) => {
      const fixture = await setupT3();
      const input = t3Task({ isolation: 'worktree', mode: 'wait', target: { driverKind: 'opencode', options } });
      const original = structuredClone(input);
      expect(await fixture.run(t3Tool, input)).toEqual({
        ...original,
        target: { driverKind: 'opencode', model: 'openai/gpt-6.1-sol', options: [plan, low] },
      });
    },
  );

  test.each([{ model: 'openai/gpt-6-mini' }, { model: 'openai/gpt-6-mini', variant: 'low' }])(
    'skips cross-model routing when inherited options are unknown: %j',
    async (fast) => {
      for (const variant of ['high', undefined]) {
        for (const target of [undefined, {}, { options: [plan] }, { options: { agent: 'plan' } }]) {
          const fixture = await setupT3({
            ...routeTo(fast),
            caller: { model: { providerID: 'openai', id: 'gpt-6.1-sol', ...(variant ? { variant } : {}) } },
          });
          await expectUnchanged(fixture, t3Task(target === undefined ? {} : { target }));
          expect(fixture.logs.at(-1)).toBe('inherited_options');
        }
      }
    },
  );

  test('keeps the parent when only an inherited variant would change', async () => {
    const fixture = await setupT3(routeTo({ model: 'openai/gpt-6.1-sol' }));
    await expectUnchanged(fixture, t3Task());
    expect(fixture.logs.at(-1)).toBe('inherited_variant');
  });

  test('classifies tasks without a role', async () => {
    const fixture = await setupT3();
    expect(await fixture.run(t3Tool, { task: 'find files' })).toEqual({
      task: 'find files',
      target: { model: 'openai/gpt-6.1-sol', options: [low] },
    });
    expect(fixture.asked).toEqual([{ apiKey: 'key', state: { prompt: 'find files' }, timeoutMs: 2000 }]);
  });

  test.each([
    { model: 'openai/gpt-6.1-sol' },
    { options: { variant: 'high' } },
    { options: [{ id: 'variant', value: 'high' }] },
    { options: {} },
    { options: [] },
  ])('respects an explicitly pinned model or variant: %j', async (target) => {
    const fixture = await setupT3();
    await expectUnchanged(fixture, t3Task({ target }));
    expect(fixture.logs.at(-1)).toBe('pinned_model');
    expect(fixture.asked).toEqual([]);
  });

  test.each([
    { providerInstanceId: 'claudeAgent' },
    { providerInstanceId: 'opencode' },
    { driverKind: 'claudeAgent' },
    { environmentId: 'another-machine' },
    { projectId: 'another-project' },
  ])('leaves explicitly selected providers and locations unchanged: %j', async (target) => {
    const fixture = await setupT3();
    await expectUnchanged(fixture, t3Task({ target }));
    expect(fixture.logs.at(-1)).toBe('unsupported_target');
    expect(fixture.asked).toEqual([]);
  });

  test.each([
    'delegate_task',
    'unrelated_delegate_task',
    't3-code_task_status',
    't3-code_t3_thread_send',
    't3-code-544c1eaf-e4af-483b-a4c5-4ea7a38b93dg_delegate_task',
    't3-code-544c1eaf_delegate_task',
    `prefix_${t3Tool}`,
    `${t3Tool}_suffix`,
  ])('does not intercept %s', async (tool) => {
    const fixture = await setupT3();
    const input = t3Task();
    const original = structuredClone(input);
    expect(await fixture.run(tool, input)).toEqual(original);
    expect(fixture.logs).toEqual([]);
    expect(fixture.asked).toEqual([]);
  });

  test.each([
    { task: null },
    { task: 123 },
    { target: null },
    { target: { options: 'high' } },
    { target: { options: [null] } },
    { target: { model: null } },
  ])('fails open for malformed T3 input: %j', async (overrides) => {
    const fixture = await setupT3();
    await expectUnchanged(fixture, t3Task(overrides));
    expect(fixture.logs.at(-1)).toBe('invalid_delegation_input');
    expect(fixture.asked).toEqual([]);
  });

  test('keeps the parent for architecture work', async () => {
    const fixture = await setupT3({
      answers: { ...cheapAnswers, kind: { type: 'choice', choice: 'architecture', confidence: 1 } },
    });
    await expectUnchanged(fixture, t3Task());
    expect(fixture.logs.at(-1)).toBe('hard_task');
  });

  test('does not apply native agent model pins to T3 roles', async () => {
    const fixture = await setupT3({ agentModel: { providerID: 'openai', id: 'another-model' } });
    expect((await fixture.run(t3Tool, t3Task())).target).toEqual({ model: 'openai/gpt-6.1-sol', options: [low] });
    expect(fixture.agentLookups).toEqual([]);
  });

  test('skips callers with a native parent session', async () => {
    const fixture = await setupT3({
      caller: { parentID: 'root', model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' } },
    });
    await expectUnchanged(fixture, t3Task());
    expect(fixture.logs.at(-1)).toBe('not_primary_child');
    expect(fixture.asked).toEqual([]);
  });

  test.each([{ sessionFails: true }, { modelsFail: true }, { askFails: true }])(
    'leaves T3 input unchanged on routing failure: %j',
    async (setup) => {
      const fixture = await setupT3(setup);
      await expectUnchanged(fixture, t3Task());
      expect(fixture.logs.length).toBeGreaterThan(0);
    },
  );

  test('leaves T3 input unchanged without classifier credentials', async () => {
    const fixture = await setupPlugin({
      caller: { model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' } },
      models: [sol],
    });
    await expectUnchanged(fixture, t3Task());
    expect(fixture.logs.at(-1)).toBe('missing_openrouter_api_key');
    expect(fixture.asked).toEqual([]);
  });
});
