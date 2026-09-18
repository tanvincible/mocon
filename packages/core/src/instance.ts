/**
 * The instance behind every handle. It holds nothing about any execution,
 * runs no timer and buffers nothing; the one thing it keeps per sink is
 * whether that sink holds the host declaration, so every batch a sink
 * receives before it has accepted one starts with it (core.md 5.1).
 */

import { types } from "node:util";
import { createIdPool, type IdPool } from "./ids.js";
import type { Capturer } from "./payload.js";
import { quote } from "./serialize.js";
import { createClock, type Clock } from "./time.js";
import type { Mocon, MoconOptions, Sink, SinkPhase } from "./types.js";

export interface Instance {
  readonly host: string;
  /** The host as a JSON string literal, the way every line writes it. */
  readonly hostText: string;
  readonly now: Clock;
  /** No sinks: nothing is written, captured or hashed. Ids are still minted. */
  readonly inert: boolean;
  readonly ids: IdPool;
  readonly capture: Capturer;
  /** Never throws for a sink's failure; that goes to `onError`. */
  emit(lines: string[]): void;
}

export type Runtime = Pick<Mocon, "declare" | "flush" | "close"> & { readonly inst: Instance };

/** A sink has not accepted the declaration. */
const NONE = 0;
/** A write that carried the declaration has not settled. */
const PENDING = 1;
/** A write that carried the declaration went through. */
const HELD = 2;

export function createRuntime(host: string, declarationText: string, sinks: readonly Sink[], capture: Capturer, onError: MoconOptions["onError"]): Runtime {
  let closed = false;
  let closing: Promise<void> | undefined;
  const declared: number[] = sinks.map(() => NONE);

  const report = (error: unknown, sink: Sink, lines: number, phase: SinkPhase): void => {
    if (onError === undefined) return;
    try {
      watch(onError(error, { sink, lines, phase }), ignore);
    } catch {
      // A failing error handler has nowhere else to go.
    }
  };

  /** One batch to one sink, the declaration first while the sink lacks it. */
  const deliver = (index: number, lines: readonly string[], declaration: boolean): void => {
    const sink = sinks[index] as Sink;
    const carries = declaration || declared[index] !== HELD;
    const batch = carries && !declaration ? Object.freeze([declarationText, ...lines]) : lines;
    let result: unknown;
    try {
      result = sink.write(batch);
    } catch (e) {
      if (carries) declared[index] = NONE;
      report(e, sink, batch.length, "write");
      return;
    }
    // A synchronous sink returns nothing, and pays for no handler.
    if (result === undefined) {
      if (carries) declared[index] = HELD;
      return;
    }
    const failed = (e: unknown): void => {
      if (carries) declared[index] = NONE;
      report(e, sink, batch.length, "write");
    };
    if (!carries) {
      watch(result, failed);
      return;
    }
    declared[index] = PENDING;
    if (!watch(result, failed, () => void (declared[index] = HELD))) declared[index] = HELD;
  };

  const write = (lines: readonly string[], declaration: boolean): void => {
    if (closed) {
      for (const sink of sinks) report(new Error(`mocon: ${lines.length} line(s) written after close were dropped`), sink, lines.length, "write");
      return;
    }
    Object.freeze(lines);
    for (let i = 0; i < sinks.length; i++) deliver(i, lines, declaration);
  };

  const inst: Instance = {
    host,
    // Not `JSON.stringify`: a `toJSON` on `String.prototype` answers for it.
    hostText: quote(host),
    now: createClock(),
    inert: sinks.length === 0,
    ids: createIdPool(),
    capture,
    emit(lines) {
      write(lines, false);
    },
  };

  const settle = async (sink: Sink, phase: SinkPhase): Promise<void> => {
    try {
      await (phase === "flush" ? sink.flush?.() : sink.close?.());
    } catch (e) {
      report(e, sink, 0, phase);
    }
  };

  return {
    inst,
    declare() {
      if (!inst.inert) write([declarationText], true);
    },
    async flush() {
      await Promise.all(sinks.map((sink) => settle(sink, "flush")));
    },
    close() {
      if (closing === undefined) {
        closed = true;
        closing = Promise.all(
          sinks.map(async (sink) => {
            await settle(sink, "flush");
            await settle(sink, "close");
          }),
        ).then(ignore);
      }
      return closing;
    },
  };
}

function ignore(): void {}

const { isPromise } = types;
const promiseThen = Promise.prototype.then;

/**
 * Attaches `onError`, and `onValue` when given, to a native promise from any
 * realm through the intrinsic `then`, so no `then` the value carries is read
 * or called. Attaching can throw only where `await` would reject, reading the
 * promise's constructor, and that error goes to `onError`.
 */
export function watch(v: unknown, onError: (error: unknown) => void, onValue?: () => void): boolean {
  if (!isPromise(v)) return false;
  try {
    promiseThen.call(v, onValue, onError);
  } catch (e) {
    onError(e);
  }
  return true;
}

/**
 * What a wrapper hands back for `result`. A native promise from any realm is
 * followed through the intrinsic `then` and the derived promise is returned:
 * it settles the same way, so a rejection nobody awaits is still reported
 * unhandled. Any other value, a thenable of another kind included, is the
 * outcome as it is: `onValue` runs now and `result` is returned unchanged,
 * its `then` never read or called.
 */
export function follow<T>(result: T, onValue: (value: unknown) => void, onError: (error: unknown) => void): T {
  if (!isPromise(result)) {
    onValue(result);
    return result;
  }
  try {
    return promiseThen.call(
      result,
      (value) => {
        onValue(value);
        return value;
      },
      (error: unknown) => {
        onError(error);
        throw error;
      },
    ) as T;
  } catch (e) {
    // Reading the promise's constructor threw, as `await` on it would too.
    onError(e);
    return result;
  }
}
