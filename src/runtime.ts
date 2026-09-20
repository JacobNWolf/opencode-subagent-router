import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as z from 'zod';

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

const RouteSchema: z.ZodType<Route> = z.object({
  parent: z.object({
    model: z.string(),
    variant: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  fast: z.object({
    model: z.string(),
    variant: z.string().optional(),
  }),
});
const positiveNumber = z.number().positive();
const probability = z.number().min(0).max(1);
const AuthFileSchema = z.object({
  openrouter: z.object({ key: z.string().optional() }).optional(),
});

export function parseOptions(options?: Record<string, unknown>): RouterOptions {
  const timeoutMs = positiveNumber.safeParse(options?.timeoutMs);
  const confidenceMin = probability.safeParse(options?.confidenceMin);

  return {
    timeoutMs: timeoutMs.success ? timeoutMs.data : 2000,
    confidenceMin: confidenceMin.success ? confidenceMin.data : 0.5,
    routes: Array.isArray(options?.routes)
      ? options.routes.flatMap((route) => {
          const parsed = RouteSchema.safeParse(route);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
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
    const auth = AuthFileSchema.safeParse(JSON.parse(readText(join(dataHome, 'opencode', 'auth.json'))));
    if (!auth.success) return;
    const key = auth.data.openrouter?.key;

    const trimmed = key?.trim();
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
