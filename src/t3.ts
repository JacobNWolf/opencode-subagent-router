import { regex } from 'arkregex';
import { Option, Schema } from 'effect';
import { isNotNil } from 'es-toolkit';

import type { ModelRef } from './routing/resolve-fast';

const DELEGATE_TOOL = regex.as<string, { flags: 'i' }>(
  '^(?:mcp__)?t3[-_]code(?:[-_][\\da-f]{8}(?:[-_][\\da-f]{4}){3}[-_][\\da-f]{12})?(?:__|_)delegate_task$',
  'i',
);

const OptionValue = Schema.Union([Schema.String, Schema.Boolean, Schema.Finite]);
type Selection = { id: string; value: typeof OptionValue.Type };

const decodeInput = Schema.decodeUnknownOption(
  Schema.Struct({
    task: Schema.String,
    role: Schema.optionalKey(Schema.String),
    target: Schema.optionalKey(
      Schema.Struct({
        model: Schema.optionalKey(Schema.String),
        providerInstanceId: Schema.optionalKey(Schema.String),
        driverKind: Schema.optionalKey(Schema.String),
        environmentId: Schema.optionalKey(Schema.String),
        projectId: Schema.optionalKey(Schema.String),
        options: Schema.optionalKey(
          Schema.Union([
            Schema.Record(Schema.String, OptionValue),
            Schema.mutable(Schema.Array(Schema.Struct({ id: Schema.String, value: OptionValue }))),
          ]),
        ),
      }),
    ),
  }),
);

type Skip = {
  readonly level: 'info' | 'warn';
  readonly skip: 'invalid_delegation_input' | 'unsupported_target' | 'pinned_model' | 'inherited_variant';
};

type T3Delegation =
  | Skip
  | {
      readonly task: { readonly agent: string | undefined; readonly prompt: string };
      /** Rewrites the tool input in place, or returns why it could not. */
      readonly apply: (fast: ModelRef, parent: ModelRef) => Skip | undefined;
    };

export const isT3DelegateTool = (tool: string) => DELEGATE_TOOL.test(tool);

function optionsWithVariant(selections: Selection[], variant?: string): Selection[] {
  if (variant === undefined) return selections;
  return [...selections, { id: 'variant', value: variant }];
}

export function readT3Delegation(input: unknown): T3Delegation {
  const delegation = Option.getOrUndefined(decodeInput(input));
  if (!delegation) return { level: 'warn', skip: 'invalid_delegation_input' };

  const {
    model,
    options,
    driverKind = 'opencode',
    providerInstanceId,
    environmentId,
    projectId,
  } = delegation.target ?? {};

  if (driverKind !== 'opencode' || [providerInstanceId, environmentId, projectId].some(isNotNil)) {
    return { level: 'info', skip: 'unsupported_target' };
  }

  const selections = Array.isArray(options)
    ? options
    : Object.entries(options ?? {}).map(([id, value]) => ({ id, value }));

  const clearsOptions = options !== undefined && selections.length === 0;
  if (model !== undefined || clearsOptions || selections.some(({ id }) => id === 'variant')) {
    return { level: 'info', skip: 'pinned_model' };
  }

  return {
    task: { agent: delegation.role, prompt: delegation.task },
    apply: (fast, parent) => {
      // T3's OpenCode V2 adapter only reads `variant`; cross-model switches do not lose other provider settings.
      const sameModel = fast.providerID === parent.providerID && fast.modelID === parent.modelID;

      // Same-model inheritance cannot clear just the variant without discarding other inherited options.
      if (sameModel && fast.variant === undefined) return { level: 'info', skip: 'inherited_variant' };

      const raw = input as { target?: Record<string, unknown> };
      raw.target = {
        ...raw.target,
        model: `${fast.providerID}/${fast.modelID}`,
        options: optionsWithVariant(selections, fast.variant),
      };

      return undefined;
    },
  };
}
