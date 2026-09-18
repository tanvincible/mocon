/**
 * The handler wrapper. `moconTool` returns a tools/call handler that
 * brackets every call with one execution: `start` before the body, one
 * `end` after it, on both exits.
 */

import type { ErrorInput, ExecutionContext, ExecutionEndOptions, ExecutionHandle, Ext, Mocon } from "@mocon/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isErrorResult } from "./client.js";
import { contextFromMcp, relayable, type McpExtra } from "./context.js";

export interface MoconToolOptions<Args> {
  /** The program text, taken from the tool arguments. */
  program: (args: Args) => string;
  /** The language of every call, or of this call when it names one in its arguments. */
  language?: string | ((args: Args) => string | undefined);
  /** The execution context. Default: `contextFromMcp(extra)`. */
  context?: (extra: McpExtra) => ExecutionContext | undefined;
  /** `ext` for the start notice and the complete record: the same on every call, or built from this one. */
  ext?: Ext | ((args: Args, extra: McpExtra) => Ext | undefined);
  /** Write a start notice. Default: true. */
  notice?: boolean;
  /**
   * Names the disposition and class of a call that did not end normally.
   * `cause` is what `run` threw, or the `isError` result it returned. A
   * field it gives replaces that field's default. A field it leaves out, a
   * `disposition` other than `failed` or `terminated`, a `class` that is
   * not a string, a return that is not an object, and a throw all keep the
   * defaults, so a mistake here never costs the record.
   */
  classify?: (cause: unknown, extra: McpExtra) => Classification | undefined;
  /**
   * The body. Returns the result the host sends back. A body that settles
   * `execution` itself wins; the wrapper's own settlement is then ignored.
   */
  run: (args: Args, context: { execution: ExecutionHandle; extra: McpExtra }) => CallToolResult | Promise<CallToolResult>;
}

interface Classification {
  disposition?: "failed" | "terminated";
  class?: string;
}

/** What `moconTool` returns: the callback shape `McpServer.registerTool` takes. */
export type MoconToolHandler<Args> = (args: Args, extra: McpExtra) => Promise<CallToolResult>;

type Classify = MoconToolOptions<never>["classify"];

export function moconTool<Args>(m: Mocon, options: MoconToolOptions<Args>): MoconToolHandler<Args> {
  const { program, language, context = contextFromMcp, ext, notice, classify, run } = options;
  return async (args, extra) => {
    const execution = m.execution.start({
      program: program(args),
      language: typeof language === "function" ? language(args) : language,
      context: context(extra),
      ext: typeof ext === "function" ? ext(args, extra) : ext,
      notice,
    });
    let result: CallToolResult;
    try {
      result = await run(args, { execution, extra });
    } catch (thrown) {
      execution.end(nonNormal(thrown, extra, classify));
      throw thrown;
    }
    execution.end(isErrorResult(result) ? nonNormal(result, extra, classify) : { disposition: "completed", result });
    return result;
  };
}

/**
 * The end of a call that threw or returned `isError`. By default it is
 * `terminated` with class `cancelled` when the request's signal was
 * aborted, because the host acted on an external cancel, and `failed` with
 * class `runtime` otherwise; `classify` overrides either field. `message`
 * and `value` come from the cause under the core cause rule, except for
 * the client's cancel reason, which reaches the record through `relayable`
 * or not at all: one of 256 characters or fewer is the message, and a
 * longer one is dropped, as `contextFromMcp` treats the client's other
 * strings.
 *
 * That holds however the body ends. A body that surfaces the reason itself
 * — `signal.throwIfAborted()`, or a race the signal rejects, which is the
 * ordinary way to stop waiting — would otherwise hand the client's own
 * string in as the cause, where only the error slot's cap bounds it, and a
 * client would choose how many kilobytes of its text each cancelled
 * execution writes. So a cause that is the string reason is not passed to
 * the cause rule; the reason's own rule answers for it.
 */
function nonNormal(cause: unknown, extra: McpExtra, classify: Classify): ExecutionEndOptions {
  // Guarded, not destructured: this runs inside the wrapper's own catch, on the path that writes the record
  // for a call that already failed. An `extra` without `signal` — a shape the SDK does not hand over today,
  // and a host or a test may — would otherwise throw here, replace the body's error on its way to the SDK,
  // and leave the execution with a start notice and no complete record. A missing signal costs the class.
  const signal: AbortSignal | undefined = (extra as { signal?: AbortSignal } | undefined)?.signal;
  const given = classified(classify, cause, extra);
  const aborted = signal?.aborted === true;
  const reason: unknown = aborted ? signal?.reason : undefined;
  const surfaced = typeof reason === "string" && cause === reason;
  const error: ErrorInput = { class: given.class ?? (aborted ? "cancelled" : "runtime"), cause: surfaced ? undefined : cause };
  // The reason is the message under the default class, and also when it is all the body left: `classify`
  // replacing the class does not make the client's string the wrong text when there is no other.
  if (aborted && relayable(reason) && (surfaced || given.class === undefined)) error.message = reason;
  return { disposition: given.disposition ?? (aborted ? "terminated" : "failed"), error };
}

const UNCLASSIFIED: Classification = Object.freeze({});

/** What `classify` said, reduced to the fields and values it may set. */
function classified(classify: Classify, cause: unknown, extra: McpExtra): Classification {
  if (classify === undefined) return UNCLASSIFIED;
  let disposition: unknown;
  let cls: unknown;
  try {
    const given: unknown = classify(cause, extra);
    if (typeof given !== "object" || given === null) return UNCLASSIFIED;
    ({ disposition, class: cls } = given as Record<string, unknown>);
  } catch {
    return UNCLASSIFIED;
  }
  const out: Classification = {};
  if (disposition === "failed" || disposition === "terminated") out.disposition = disposition;
  if (typeof cls === "string") out.class = cls;
  return out;
}
