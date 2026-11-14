#!/usr/bin/env node
/* oxlint-disable no-console -- This executable reports installation results to the terminal. */

import { execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { regex } from 'arkregex';
import { isPlainObject } from 'es-toolkit';
import { parseStrict } from 'jsonc-morph';

const PACKAGE = '@jacobwolf/opencode-subagent-router';
const opencodeVersion = regex('^v?([12])\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$');
const HELP = `Usage: npx ${PACKAGE} [install] [options]

  --project                 Install in the current project's opencode.json(c)
  --config <path>           Use a specific config file
  --opencode-version <1|2>  Override version detection (opencode --version)
  --dry-run                 Preview the config without writing
  --help                    Show this help

Default: OPENCODE_CONFIG, or $XDG_CONFIG_HOME/opencode/opencode.json(c),
falling back to ~/.config/opencode/opencode.json(c).`;

function packageSpecifier(entry) {
  if (Array.isArray(entry)) return entry[0];
  if (isPlainObject(entry)) return entry.package;

  return entry;
}

function isRouterPackage(entry) {
  const spec = packageSpecifier(entry);

  return typeof spec === 'string' && (spec === PACKAGE || spec.startsWith(`${PACKAGE}@`));
}

function detectMajorVersion() {
  let version;

  try {
    version = execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('Cannot detect OpenCode. Install it first, or pass --opencode-version 1 or 2.');
  }

  return opencodeVersion.exec(version)?.[1];
}

function configPath(values) {
  if (values.config) return resolve(values.config);
  if (!values.project && process.env.OPENCODE_CONFIG) return resolve(process.env.OPENCODE_CONFIG);

  let directory = process.cwd();

  if (!values.project) {
    directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
  }

  const jsonc = join(directory, 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;

  return join(directory, 'opencode.json');
}

function readConfig(source, path) {
  let root;

  try {
    root = parseStrict(source, { allowComments: true, allowTrailingCommas: true });
  } catch {
    throw new Error(`Invalid JSON/JSONC object in ${path}; no changes made.`);
  }

  const config = root.toValue();

  if (!isPlainObject(config)) {
    throw new Error(`Invalid JSON/JSONC object in ${path}; no changes made.`);
  }

  for (const name of ['plugin', 'plugins']) {
    if (name in config && !Array.isArray(config[name])) {
      throw new Error(`Expected "${name}" to be an array in ${path}; no changes made.`);
    }
  }

  return { root, config };
}

function writeConfig(path, source, output, existed) {
  mkdirSync(dirname(path), { recursive: true });

  if (!existed) {
    writeFileSync(path, output, { flag: 'wx', mode: 0o600 });
    return;
  }

  const backup = `${path}.${crypto.randomUUID()}.bak`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;

  copyFileSync(path, backup, constants.COPYFILE_EXCL);

  try {
    writeFileSync(temporary, output, { flag: 'wx', mode: statSync(path).mode & 0o777 });

    if (readFileSync(path, 'utf8') !== source) throw new Error('Config changed during install; retry.');

    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }

  console.log(`Backup: ${backup}`);
}

function install() {
  const { values, positionals } = parseArgs({
    options: {
      project: { type: 'boolean' },
      config: { type: 'string' },
      'opencode-version': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (positionals.length > 1 || (positionals[0] && positionals[0] !== 'install')) throw new Error(HELP);
  if (values.project && values.config) throw new Error('Use either --project or --config, not both.');

  const major = values['opencode-version'] ?? detectMajorVersion();
  if (major !== '1' && major !== '2') throw new Error('Supported OpenCode versions: 1 and 2.');

  const key = major === '1' ? 'plugin' : 'plugins';
  let path = configPath(values);
  const existed = existsSync(path);

  if (existed) path = realpathSync(path);

  const source = existed ? readFileSync(path, 'utf8') : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const { root, config } = readConfig(source, path);
  const installed = config[key]?.some(isRouterPackage) || (major === '2' && config.plugin?.some(isRouterPackage));

  if (installed) {
    console.log(`Already configured for OpenCode V${major} in ${path}.`);
    return;
  }

  if (major === '1' && config.plugins?.some(isRouterPackage)) {
    throw new Error('This plugin is configured for V2. Move its entry to "plugin" before using V1.');
  }

  root.asObjectOrThrow().getIfArrayOrCreate(key).append(PACKAGE);

  const output = root.toString();

  if (values['dry-run']) {
    console.log(`Would configure OpenCode V${major} in ${path}:\n${output}`);
    return;
  }

  writeConfig(path, source, output, existed);

  console.log(`Configured OpenCode V${major} in ${path}. OpenCode downloads the plugin when it loads config.`);
  console.log(major === '2' ? 'Run /reload if needed.' : 'Restart OpenCode to load the plugin.');
  console.log('Jev needs OpenRouter authentication: set OPENROUTER_API_KEY or connect OpenRouter in OpenCode.');
}

try {
  install();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
