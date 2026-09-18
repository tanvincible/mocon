/**
 * @mocon/core: the reference emitter for mocon.
 *
 * `mocon` builds an instance from a host string, a capabilities
 * declaration and sinks. The instance writes the host line once and hands
 * out execution handles. It keeps no registry of executions and runs
 * nothing in the background.
 */

import { checkExt, checkString, checkTimestamp } from "./check.js";
import { CLOSED } from "./closed.js";
import { Execution } from "./execution.js";
import { createRuntime, follow } from "./instance.js";
import { Capturer, REDACTED_TEXT } from "./payload.js";
import { extJson, objectJson, quote, raw } from "./serialize.js";
import type { Ext, ExecutionContext, ExecutionHandle, ExecutionStartOptions, HostLine, Mocon, MoconOptions } from "./types.js";
import { SPEC_VERSION } from "./version.js";

export type * from "./types.js";
export { targetOf } from "./check.js";
export { InvariantError, invariant } from "./invariants.js";
export { fileSink, stderrSink } from "./node.js";
export { memorySink, type MemorySink } from "./sinks.js";
export { SPEC_VERSION } from "./version.js";

export function mocon(options: MoconOptions): Mocon {
  const hostLine = buildHostLine(options);
  if (!Array.isArray(options.sinks)) throw new TypeError("mocon: sinks must be an array");
  const runtime = createRuntime(hostLine.host, JSON.stringify(hostLine), [...options.sinks], new Capturer(options.capture), options.onError);
  const inst = runtime.inst;
  runtime.declare();

  const start = (o: ExecutionStartOptions): ExecutionHandle => {
    const { program, id, language, start: given, context, ext, notice } = o as { [K in keyof ExecutionStartOptions]: unknown };
    const programText = checkString(program, "program");
    const ownId = id === undefined ? undefined : checkString(id, "execution id");
    const lang = language === undefined ? undefined : checkString(language, "language");
    const floor = given === undefined ? undefined : checkTimestamp(given, "start");
    const ctx = normalizeContext(context);
    const extText = extJson(checkExt(ext, "ext"));
    const executionId = ownId ?? inst.ids.execution();
    const startTime = floor ?? inst.now();
    const execution = new Execution(inst, {
      id: executionId,
      idText: ownId === undefined ? raw(executionId) : quote(ownId),
      start: startTime,
      startText: raw(startTime),
      floor,
      programText: inst.inert ? REDACTED_TEXT : inst.capture.program(programText).text,
      language: lang,
      context: ctx,
      ext: extText,
    });
    if (notice !== false) execution.announce();
    return execution;
  };

  const run = <T>(o: ExecutionStartOptions, body: (execution: ExecutionHandle) => T): T => {
    const execution = start(o);
    let out: T;
    try {
      out = body(execution);
    } catch (e) {
      execution.fail(e);
      throw e;
    }
    return follow(
      out,
      (value) => execution.complete({ result: value }),
      (e) => execution.fail(e),
    );
  };

  return { execution: { start, run }, declare: runtime.declare, flush: runtime.flush, close: runtime.close };
}

function buildHostLine(options: MoconOptions): HostLine {
  const { host, capabilities } = options;
  if (typeof host !== "string" || host === "") throw new TypeError("mocon: host must be a non-empty string");
  if (capabilities === null || typeof capabilities !== "object") throw new TypeError("mocon: capabilities are required");
  if (!CLOSED.observes_crossings.has(capabilities.observes_crossings)) {
    throw new RangeError(`mocon: observes_crossings must be "all", "some" or "none"`);
  }
  const line: HostLine = { kind: "host", host, spec_version: SPEC_VERSION, observes_crossings: capabilities.observes_crossings };
  if (capabilities.unmediated_egress !== undefined) {
    if (typeof capabilities.unmediated_egress !== "boolean") throw new TypeError("mocon: unmediated_egress must be a boolean");
    line.unmediated_egress = capabilities.unmediated_egress;
  }
  if (capabilities.crossing_edge !== undefined) {
    if (!CLOSED.crossing_edge.has(capabilities.crossing_edge)) throw new RangeError(`mocon: crossing_edge must be "invocation" or "dispatch"`);
    line.crossing_edge = capabilities.crossing_edge;
  }
  if (capabilities.attested !== undefined) {
    if (!Array.isArray(capabilities.attested)) throw new TypeError("mocon: attested must be an array");
    for (const entry of capabilities.attested) {
      if (!CLOSED.attested.has(entry)) throw new RangeError(`mocon: unknown attested entry ${JSON.stringify(entry)}`);
    }
    line.attested = [...capabilities.attested];
  }
  // Serialized once and parsed back, so the declaration carries plain data and a toJSON inside runs once.
  const ext = objectJson(checkExt(capabilities.ext, "capabilities.ext"));
  if (ext === null) throw new TypeError("mocon: capabilities.ext must serialize to a JSON object");
  if (ext !== undefined) line.ext = JSON.parse(ext) as Ext;
  return line;
}

function normalizeContext(context: unknown): ExecutionContext | undefined {
  if (context === undefined) return undefined;
  if (context === null || typeof context !== "object") throw new TypeError("mocon: context must be an object");
  const { session, traceparent } = context as ExecutionContext;
  const out: ExecutionContext = {};
  if (session !== undefined) out.session = checkString(session, "context.session");
  if (traceparent !== undefined) out.traceparent = checkString(traceparent, "context.traceparent");
  return out.session === undefined && out.traceparent === undefined ? undefined : out;
}
