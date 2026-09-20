import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Effect, Option, Schema } from 'effect';
import { flatMap, isNotNil, isUndefined, omitBy } from 'es-toolkit';

import type { CatalogModel, ModelRef, Route } from './resolve-fast';

export type RouterOptions = {
  readonly timeoutMs: number;
  readonly confidenceMin: number;
  readonly routes: readonly Route[];
};

type SourceModel = {
  readonly id?: string;
  readonly family?: string;
  readonly tool_call?: boolean;
  readonly status?: string;
  readonly cost?: { readonly input?: number };
  readonly variants?: Readonly<Record<string, unknown>>;
  readonly capabilities?: { readonly toolcall?: boolean };
};

type SourceProvider = {
  readonly id: string;
  readonly models: Readonly<Record<string, SourceModel>>;
};

type MessageSnapshot = {
  readonly info: {
    readonly role: string;
    readonly providerID?: string;
    readonly modelID?: string;
    readonly variant?: string;
    readonly time?: { readonly created?: number };
  };
};

const RouteSchema = Schema.Struct({
  parent: Schema.Struct({
    model: Schema.String,
    variant: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
  fast: Schema.Struct({
    model: Schema.String,
    variant: Schema.optionalKey(Schema.String),
  }),
});
const PositiveNumber = Schema.Finite.check(Schema.isGreaterThan(0));
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const AuthFileSchema = Schema.fromJsonString(
  Schema.Struct({
    openrouter: Schema.optionalKey(
      Schema.Struct({
        key: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

const decodeTimeout = Schema.decodeUnknownOption(PositiveNumber);
const decodeConfidence = Schema.decodeUnknownOption(Probability);
const decodeRoute = Schema.decodeUnknownOption(RouteSchema);

type UndefinedKey<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type CompactUndefined<T> = Omit<T, UndefinedKey<T>> &
  Partial<{
    [K in UndefinedKey<T>]: Exclude<T[K], undefined>;
  }>;

function compactUndefined<T extends Record<PropertyKey, unknown>>(value: T): CompactUndefined<T> {
  return omitBy(value, isUndefined) as CompactUndefined<T>;
}

export function parseOptions(options?: Readonly<Record<string, unknown>>): RouterOptions {
  const routes = Array.isArray(options?.routes)
    ? options.routes.map((route) => Option.getOrUndefined(decodeRoute(route))).filter(isNotNil)
    : [];

  return {
    timeoutMs: Option.getOrElse(decodeTimeout(options?.timeoutMs), () => 2000),
    confidenceMin: Option.getOrElse(decodeConfidence(options?.confidenceMin), () => 0.5),
    routes,
  };
}

export function catalogFromProviders(value: readonly SourceProvider[] | undefined): CatalogModel[] {
  return flatMap(value ?? [], (provider) =>
    Object.entries(provider.models).map(([key, rawModel]) => {
      const toolCall = rawModel.tool_call ?? rawModel.capabilities?.toolcall;
      return compactUndefined({
        providerID: provider.id,
        id: rawModel.id ?? key,
        family: rawModel.family,
        tool_call: toolCall,
        status: rawModel.status,
        cost: rawModel.cost?.input === undefined ? undefined : { input: rawModel.cost.input },
        variants: rawModel.variants,
      }) satisfies CatalogModel;
    }),
  );
}

export function latestAssistantModel(value: readonly MessageSnapshot[] | undefined): ModelRef | undefined {
  let latest: { readonly created: number; readonly model: ModelRef } | undefined;
  for (const entry of value ?? []) {
    const info = entry.info;
    if (info.role !== 'assistant' || !info.providerID || !info.modelID) continue;

    const created = info.time?.created ?? 0;
    if (!latest || created >= latest.created) {
      latest = {
        created,
        model: compactUndefined({
          providerID: info.providerID,
          modelID: info.modelID,
          variant: info.variant,
        }) satisfies ModelRef,
      };
    }
  }

  return latest?.model;
}

export type CredentialError = {
  readonly _tag: 'CredentialError';
  readonly path: string;
  readonly cause: unknown;
};

const credentialError = (path: string, cause: unknown): CredentialError => ({
  _tag: 'CredentialError',
  path,
  cause,
});

const readTextFile = (path: string) => readFileSync(path, 'utf8');

function nonEmptyString(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed ? Option.some(trimmed) : Option.none();
}

export function readOpenCodeOpenRouterKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readText: (path: string) => string = readTextFile,
): Effect.Effect<Option.Option<string>, CredentialError> {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  const path = join(dataHome, 'opencode', 'auth.json');

  return Effect.try({
    try: () => readText(path),
    catch: (cause) => credentialError(path, cause),
  }).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(AuthFileSchema)(text).pipe(Effect.mapError((cause) => credentialError(path, cause))),
    ),
    Effect.map((auth) => nonEmptyString(auth.openrouter?.key)),
  );
}

export function getOpenRouterApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readText: (path: string) => string = readTextFile,
): Effect.Effect<Option.Option<string>> {
  const direct = nonEmptyString(env.OPENROUTER_API_KEY);
  if (Option.isSome(direct)) return Effect.succeed(direct);

  return readOpenCodeOpenRouterKey(env, readText).pipe(Effect.catch(() => Effect.succeed(Option.none())));
}
