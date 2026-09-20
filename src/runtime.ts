import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CatalogModel, ModelRef, Route } from './resolve-fast';

export type RouterOptions = {
  timeoutMs: number;
  confidenceMin: number;
  routes: Route[];
};

type SourceModel = {
  id?: string;
  family?: string;
  tool_call?: boolean;
  status?: string;
  cost?: { input?: number };
  variants?: Record<string, unknown>;
  capabilities?: { toolcall?: boolean };
};

type SourceProvider = {
  id: string;
  models: Record<string, SourceModel>;
};

type MessageSnapshot = {
  info: {
    role: string;
    providerID?: string;
    modelID?: string;
    variant?: string;
    time?: { created?: number };
  };
};

type AuthFile = {
  openrouter?: { key?: unknown };
};

function isRoute(value: unknown): value is Route {
  const candidate = value as Partial<Route> | null | undefined;
  if (typeof candidate?.parent?.model !== 'string' || typeof candidate.fast?.model !== 'string') return false;
  if (candidate.fast.variant !== undefined && typeof candidate.fast.variant !== 'string') return false;

  const variant = candidate.parent.variant;
  if (variant === undefined || typeof variant === 'string') return true;
  return Array.isArray(variant) && variant.every((item) => typeof item === 'string');
}

export function parseOptions(options?: Record<string, unknown>): RouterOptions {
  let timeoutMs = 2000;
  if (typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    timeoutMs = options.timeoutMs;
  }

  let confidenceMin = 0.5;
  if (typeof options?.confidenceMin === 'number' && options.confidenceMin >= 0 && options.confidenceMin <= 1) {
    confidenceMin = options.confidenceMin;
  }

  return {
    timeoutMs,
    confidenceMin,
    routes: Array.isArray(options?.routes) ? options.routes.filter(isRoute) : [],
  };
}

export function catalogFromProviders(value: readonly SourceProvider[] | undefined): CatalogModel[] {
  const catalog: CatalogModel[] = [];
  for (const provider of value ?? []) {
    for (const [key, rawModel] of Object.entries(provider.models)) {
      catalog.push({
        providerID: provider.id,
        id: rawModel.id ?? key,
        family: rawModel.family,
        tool_call: rawModel.tool_call ?? rawModel.capabilities?.toolcall,
        status: rawModel.status,
        cost: rawModel.cost?.input === undefined ? undefined : { input: rawModel.cost.input },
        variants: rawModel.variants,
      });
    }
  }

  return catalog;
}

export function latestAssistantModel(value: readonly MessageSnapshot[] | undefined): ModelRef | undefined {
  let latest: { created: number; model: ModelRef } | undefined;
  for (const entry of value ?? []) {
    const info = entry.info;
    if (info.role !== 'assistant' || !info.providerID || !info.modelID) continue;

    const created = info.time?.created ?? 0;
    if (!latest || created >= latest.created) {
      latest = {
        created,
        model: {
          providerID: info.providerID,
          modelID: info.modelID,
          variant: info.variant,
        },
      };
    }
  }

  return latest?.model;
}

const readTextFile = (path: string) => readFileSync(path, 'utf8');

export function readOpenCodeOpenRouterKey(
  env: Record<string, string | undefined> = process.env,
  readText: (path: string) => string = readTextFile,
): string | undefined {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');

  try {
    const auth = JSON.parse(readText(join(dataHome, 'opencode', 'auth.json'))) as AuthFile | null;
    const key = auth?.openrouter?.key;
    if (typeof key !== 'string') return;

    const trimmed = key.trim();
    if (trimmed) return trimmed;
  } catch {
    return;
  }
}

export function getOpenRouterApiKey(
  env: Record<string, string | undefined> = process.env,
  readText: (path: string) => string = readTextFile,
): string | undefined {
  const key = env.OPENROUTER_API_KEY?.trim();
  return key || readOpenCodeOpenRouterKey(env, readText);
}
