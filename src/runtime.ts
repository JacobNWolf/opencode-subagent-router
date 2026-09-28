import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Modality } from '@opencode-ai/models/effect';
import { Effect, Option, Schema } from 'effect';
import { compact, flatMap, isUndefined, omitBy } from 'es-toolkit';

import { tokenPriceOf } from './routing/pricing';
import type { EnabledModel, ModelCapabilities, ModelLimits, ModelRef, Route } from './routing/types';

export type RouterOptions = {
  readonly timeoutMs: number;
  readonly confidenceMin: number;
  readonly routes: readonly Route[];
};

type SourceModel = {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly release_date?: string;
  readonly status?: string;
  readonly tool_call?: boolean;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly structured_output?: boolean;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly tiers?: readonly {
      readonly input?: number;
      readonly output?: number;
      readonly tier?: { readonly type?: string; readonly size?: number };
    }[];
    readonly context_over_200k?: {
      readonly input?: number;
      readonly output?: number;
    };
    readonly experimentalOver200K?: {
      readonly input?: number;
      readonly output?: number;
    };
  };
  readonly limit?: {
    readonly context?: number;
    readonly input?: number;
    readonly output?: number;
  };
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
  readonly variants?: Readonly<Record<string, unknown>>;
  readonly capabilities?: {
    readonly attachment?: boolean;
    readonly reasoning?: boolean;
    readonly toolcall?: boolean;
    readonly input?: Readonly<Record<string, boolean>>;
    readonly output?: Readonly<Record<string, boolean>>;
  };
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
    ? compact(options.routes.map((route) => Option.getOrUndefined(decodeRoute(route))))
    : [];

  return {
    timeoutMs: Option.getOrElse(decodeTimeout(options?.timeoutMs), () => 2000),
    confidenceMin: Option.getOrElse(decodeConfidence(options?.confidenceMin), () => 0.5),
    routes,
  };
}

const MODALITIES = new Set<Modality>(['text', 'audio', 'image', 'video', 'pdf']);

function modalitySet(
  raw?: readonly string[],
  flags?: Readonly<Record<string, boolean>>,
): ReadonlySet<Modality> | undefined {
  if (raw) {
    const items = raw.filter((item): item is Modality => MODALITIES.has(item as Modality));
    if (items.length !== raw.length) return undefined;
    return new Set(items);
  }

  if (!flags) return undefined;

  return new Set(
    Object.entries(flags)
      .filter(([, enabled]) => enabled)
      .map(([item]) => item)
      .filter((item): item is Modality => MODALITIES.has(item as Modality)),
  );
}

function capabilitiesOf(rawModel: SourceModel): ModelCapabilities | undefined {
  const toolCall = rawModel.tool_call ?? rawModel.capabilities?.toolcall;
  const attachment = rawModel.attachment ?? rawModel.capabilities?.attachment;
  const reasoning = rawModel.reasoning ?? rawModel.capabilities?.reasoning;

  const structuredOutput = rawModel.structured_output;
  const input = modalitySet(rawModel.modalities?.input, rawModel.capabilities?.input);
  const output = modalitySet(rawModel.modalities?.output, rawModel.capabilities?.output);

  const malformedModalities =
    (rawModel.modalities?.input !== undefined && input === undefined) ||
    (rawModel.modalities?.output !== undefined && output === undefined);
  if (
    toolCall === undefined &&
    attachment === undefined &&
    reasoning === undefined &&
    structuredOutput === undefined &&
    (malformedModalities || (input === undefined && output === undefined))
  ) {
    return undefined;
  }

  return {
    attachment: attachment ?? false,
    reasoning: reasoning ?? false,
    toolCall: toolCall ?? false,
    structuredOutput: structuredOutput ?? false,
    input: input ?? new Set(),
    output: output ?? new Set(),
  };
}

function limitsOf(limit: SourceModel['limit']): ModelLimits | undefined {
  if (limit?.context === undefined || limit.output === undefined) return undefined;
  if (!Number.isFinite(limit.context) || !Number.isFinite(limit.output)) return undefined;

  return compactUndefined({
    context: limit.context,
    output: limit.output,
    input: limit.input,
  });
}

export function catalogFromProviders(value: readonly SourceProvider[] | undefined): EnabledModel[] {
  return flatMap(value ?? [], (provider) =>
    Object.entries(provider.models).map(([selectableID, rawModel]) => {
      const price = tokenPriceOf({
        input: rawModel.cost?.input ?? Number.NaN,
        output: rawModel.cost?.output ?? Number.NaN,
      });

      return compactUndefined({
        providerID: provider.id,
        modelID: selectableID,
        sourceID: rawModel.id,
        name: rawModel.name,
        family: rawModel.family,
        releaseDate: rawModel.release_date,
        status: rawModel.status,
        cost: price ? { bands: [{ fromContext: 0, price }] } : undefined,
        capabilities: capabilitiesOf(rawModel),
        limits: limitsOf(rawModel.limit),
        variants: new Set(Object.keys(rawModel.variants ?? {})),
      }) satisfies EnabledModel;
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
  if (!trimmed) return Option.none();
  return Option.some(trimmed);
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
