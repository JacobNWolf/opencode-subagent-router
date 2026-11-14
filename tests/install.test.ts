import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseToValueStrict } from 'jsonc-morph';

const parse = (source: string) => parseToValueStrict(source, { allowComments: true, allowTrailingCommas: true });

const cli = join(import.meta.dir, '../bin/install.mjs');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required to test the installer.');

const packageName = '@jacobwolf/opencode-subagent-router';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(source?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'subagent-router-install-'));
  directories.push(directory);

  const config = join(directory, 'opencode.jsonc');
  if (source !== undefined) writeFileSync(config, source);

  function runWithEnv(env: Record<string, string>, ...args: string[]) {
    const result = Bun.spawnSync([node!, cli, ...args], {
      cwd: directory,
      env: { ...process.env, OPENCODE_CONFIG: config, XDG_CONFIG_HOME: directory, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  const run = (...args: string[]) => runWithEnv({}, ...args);

  return { directory, config, run, runWithEnv };
}

for (const [major, key] of [
  ['1', 'plugin'],
  ['2', 'plugins'],
] as const) {
  test(`Node installer creates V${major} config and is idempotent`, () => {
    const { config, directory, run } = setup();

    expect(run('install', '--opencode-version', major).status).toBe(0);

    const source = readFileSync(config, 'utf8');

    expect(JSON.parse(source)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      [key]: [packageName],
    });

    expect(run('--opencode-version', major).stdout).toContain('Already configured');
    expect(readFileSync(config, 'utf8')).toBe(source);
    expect(readdirSync(directory)).toEqual(['opencode.jsonc']);
  });
}

test('preserves JSONC comments, other plugins, trailing commas, options and backs up the original', () => {
  const source = `{
  // Keep my settings
  "model": "provider/model",
  "plugins": [
    { "package": "other", "options": { "url": "https://example.com//" } },
  ],
}
`;
  const { config, directory, run } = setup(source);

  expect(run('install', '--opencode-version', '2').status).toBe(0);

  const output = readFileSync(config, 'utf8');

  expect(output).toContain('// Keep my settings');
  expect(parse(output)).toEqual({
    model: 'provider/model',
    plugins: [{ package: 'other', options: { url: 'https://example.com//' } }, packageName],
  });

  const backups = readdirSync(directory).filter((name) => name.endsWith('.bak'));

  expect(backups).toHaveLength(1);
  expect(readFileSync(join(directory, backups[0]!), 'utf8')).toBe(source);
});

test('preserves inline comment ownership, tabs, CRLF and trailing commas when appending', () => {
  const source = '{\r\n\t"plugins": [\r\n\t\t"other", // keep other\r\n\t],\r\n}\r\n';
  const { config, run } = setup(source);

  expect(run('--opencode-version', '2').status).toBe(0);

  const output = readFileSync(config, 'utf8');

  expect(output).toBe(`{\r\n\t"plugins": [\r\n\t\t"other", // keep other\r\n\t\t"${packageName}",\r\n\t],\r\n}\r\n`);
});

for (const [major, entry] of [
  ['1', `"plugin": [["${packageName}@0.3.0", {"timeoutMs": 1000}]]`],
  ['2', `"plugins": [{"package": "${packageName}@latest", "options": {"timeoutMs": 1000}}]`],
  ['2', `"plugin": [["${packageName}", {"timeoutMs": 1000}]]`],
] as const) {
  test(`recognizes existing ${entry} on V${major}`, () => {
    const source = `{${entry}}`;
    const { config, run } = setup(source);

    expect(run('--opencode-version', major).stdout).toContain('Already configured');
    expect(readFileSync(config, 'utf8')).toBe(source);
  });
}

for (const source of [
  '{ broken',
  '[]',
  'null',
  '{"plugins": null}',
  '{"plugin": {}}',
  '',
  '// comments only',
  "{'model': 'single quotes'}",
  '{model: "unquoted key"}',
  '{"steps": 0x10}',
  '{"steps": +10}',
  '{"temperature": .5}',
  '{"temperature": Infinity}',
  '{"model": "one" "plugins": []}',
  '{"model": "\\x41"}',
]) {
  test(`refuses malformed config without changing it: ${source}`, () => {
    const { config, directory, run } = setup(source);

    expect(run('--opencode-version', '2').status).toBe(1);
    expect(readFileSync(config, 'utf8')).toBe(source);
    expect(readdirSync(directory)).toEqual(['opencode.jsonc']);
  });
}

test('dry run and help create no files', () => {
  const { directory, run } = setup();

  expect(run('install', '--opencode-version', '2', '--dry-run').stdout).toContain('Would configure');
  expect(run('--help').status).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

test('project ignores OPENCODE_CONFIG and prefers existing JSONC', () => {
  const { config, directory, runWithEnv } = setup('{"model":"keep"}');

  expect(
    runWithEnv({ OPENCODE_CONFIG: join(directory, 'ignored.json') }, '--project', '--opencode-version', '1').status,
  ).toBe(0);
  expect(parse(readFileSync(config, 'utf8')).plugin).toEqual([packageName]);
  expect(readdirSync(directory)).not.toContain('opencode.json');
  expect(readdirSync(directory)).not.toContain('ignored.json');
});

test('global install respects XDG_CONFIG_HOME when OPENCODE_CONFIG is unset', () => {
  const { directory, runWithEnv } = setup();

  expect(runWithEnv({ OPENCODE_CONFIG: '' }, '--opencode-version', '2').status).toBe(0);
  expect(JSON.parse(readFileSync(join(directory, 'opencode', 'opencode.json'), 'utf8')).plugins).toEqual([packageName]);
});

for (const [version, key] of [
  ['1.18.31', 'plugin'],
  ['v2.2.6-beta.1', 'plugins'],
  ['3.0.0', undefined],
  ['unrecognized', undefined],
] as const) {
  test(`detects version from the OpenCode executable: ${version}`, () => {
    const { config, directory, runWithEnv } = setup();
    const bin = join(directory, 'bin');

    mkdirSync(bin);
    writeFileSync(join(bin, 'opencode'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`, {
      mode: 0o755,
    });

    const result = runWithEnv({ PATH: `${bin}:${process.env.PATH}` }, 'install');

    if (!key) {
      expect(result.status).toBe(1);
      expect(readdirSync(directory)).toEqual(['bin']);
      return;
    }

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(config, 'utf8'))[key]).toEqual([packageName]);
  });
}

test('missing OpenCode fails without writing config', () => {
  const { directory } = setup();

  const result = Bun.spawnSync([node, cli], {
    cwd: directory,
    env: { ...process.env, PATH: '', OPENCODE_CONFIG: join(directory, 'opencode.json') },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('Cannot detect OpenCode');
  expect(readdirSync(directory)).toEqual([]);
});

test('explicit config overrides environment', () => {
  const { config, directory, run } = setup();
  const explicit = join(directory, 'custom.json');

  expect(run('--config', explicit, '--opencode-version', '2').status).toBe(0);
  expect(readdirSync(directory)).toEqual(['custom.json']);
  expect(explicit).not.toBe(config);
});

for (const args of [
  ['uninstall'],
  ['--unknown'],
  ['--opencode-version', '3'],
  ['--project', '--config', 'other.json'],
  ['--opencode-version'],
]) {
  test(`rejects invalid arguments: ${args.join(' ')}`, () => {
    const { directory, run } = setup();

    expect(run(...args).status).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
  });
}

test('V1 refuses a V2 registration rather than creating a second copy', () => {
  const source = JSON.stringify({ plugins: [packageName] });
  const { config, run } = setup(source);

  expect(run('--opencode-version', '1').status).toBe(1);
  expect(readFileSync(config, 'utf8')).toBe(source);
});
