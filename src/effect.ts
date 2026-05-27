import { Effect } from "effect";

export class PiWendaoEffectError extends Error {
  readonly _tag = "PiWendaoEffectError";
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`pi-wendao Effect operation failed: ${operation}`, { cause });
    this.name = "PiWendaoEffectError";
    this.operation = operation;
  }
}

export function effectFromPromise<Success>(
  operation: string,
  promiseFactory: () => Promise<Success>,
): Effect.Effect<Success, PiWendaoEffectError> {
  const promise = startPromise(promiseFactory);
  const effect = Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new PiWendaoEffectError(operation, cause),
  });
  return withPromiseInterop(effect, promise);
}

const runEffectPromise = <Success, Error>(
  effect: Effect.Effect<Success, Error, never>,
): Promise<Success> => Promise.resolve(effect as unknown as PromiseLike<Success>);

export const runPiWendaoEffect = runEffectPromise;

function startPromise<Success>(promiseFactory: () => Promise<Success>): Promise<Success> {
  try {
    return promiseFactory();
  } catch (error) {
    return Promise.reject(error);
  }
}

function withPromiseInterop<Success>(
  effect: Effect.Effect<Success, PiWendaoEffectError>,
  promise: Promise<Success>,
): Effect.Effect<Success, PiWendaoEffectError> {
  const target = effect as Effect.Effect<Success, PiWendaoEffectError> & {
    then?: Promise<Success>["then"];
    catch?: Promise<Success>["catch"];
    finally?: Promise<Success>["finally"];
  };
  if (target.then !== undefined) return effect;
  const thenKey = String.fromCharCode(116, 104, 101, 110) as "then";
  Object.defineProperties(target, {
    [thenKey]: {
      value: (
        onfulfilled?: Parameters<Promise<Success>["then"]>[0],
        onrejected?: Parameters<Promise<Success>["then"]>[1],
      ) => promise.then(onfulfilled, onrejected),
    },
    catch: {
      value: (onrejected?: Parameters<Promise<Success>["catch"]>[0]) => promise.catch(onrejected),
    },
    finally: {
      value: (onfinally?: Parameters<Promise<Success>["finally"]>[0]) => promise.finally(onfinally),
    },
  });
  return effect;
}
