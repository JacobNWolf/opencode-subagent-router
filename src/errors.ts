import { Effect } from 'effect';

export type OpenCodeError = {
  readonly _tag: 'OpenCodeError';
  readonly operation: string;
  readonly cause: unknown;
};

export const openCodeError = (operation: string, cause: unknown): OpenCodeError => ({
  _tag: 'OpenCodeError',
  operation,
  cause,
});

export type OperationTimeoutError = {
  readonly _tag: 'OperationTimeoutError';
  readonly operation: string;
  readonly timeoutMs: number;
};

const operationTimeoutError = (operation: string, timeoutMs: number): OperationTimeoutError => ({
  _tag: 'OperationTimeoutError',
  operation,
  timeoutMs,
});

export function withOperationTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  operation: string,
  timeoutMs: number,
): Effect.Effect<A, E | OperationTimeoutError, R> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(operationTimeoutError(operation, timeoutMs)),
    }),
  );
}
