/**
 * @mocon/core: the reference emitter for mocon. The instance writes the host line once and hands out execution
 * handles; it keeps no registry of executions and runs nothing in the background.
 */

import { checkDimensions, checkExt, checkString, checkTimestamp, linksText } from "./check.js";
import { CLOSED } from "./closed.js";
import { Execution } from "./execution.js";
import { createRuntime, follow } from "./instance.js";
import { Capturer, REDACTED_TEXT } from "./payload.js";
import { extJson, objectJson, quote, raw } from "./serialize.js";
import type { Attestation, Capabilities, Ext, ExecutionContext, ExecutionHandle, ExecutionStartOptions, HostLine, Mocon, MoconOptions } from "./types.js";
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
  // A `toJSON` on `Object.prototype` makes the serialization of any object whatever it returns. A declaration
  // that is not a JSON object refuses construction: core.md 5.1 wants one on every stream.
  const declaration = objectJson(hostLine);
  if (typeof declaration !== "string") throw new TypeError("mocon: the host declaration must serialize to a JSON object");
  const runtime = createRuntime(hostLine.host, declaration, [...options.sinks], new Capturer(options.capture), options.onError);
  const inst = runtime.inst;
  runtime.declare();

  const start = (o: ExecutionStartOptions): ExecutionHandle => {
    const { program, id, language, start: given, context, links, ext, notice } = o as { [K in keyof ExecutionStartOptions]: unknown };
    const programText = checkString(program, "program");
    const ownId = id === undefined ? undefined : checkString(id, "execution id");
    const lang = language === undefined ? undefined : checkString(language, "language");
    const floor = given === undefined ? undefined : checkTimestamp(given, "start");
    const ctx = normalizeContext(context);
    const linkText = linksText(links, "execution", ownId);
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
      links: linkText,
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

/**
 * The declaration from the capabilities, each field read once and the line written from what was read, the way
 * every other option is handled (core.md 5.1 and 8). Reading a field twice would let a getter or a Proxy answer
 * the closed-set check with a member and the write with anything, putting a value on the wire that never passed
 * a check; `attested` is copied before its entries are checked for the same reason.
 */
function buildHostLine(options: MoconOptions): HostLine {
  const { host, capabilities } = options;
  if (typeof host !== "string" || host === "") throw new TypeError("mocon: host must be a non-empty string");
  if (capabilities === null || typeof capabilities !== "object") throw new TypeError("mocon: capabilities are required");
  const { observes_crossings: observes, unmediated_egress: egress, crossing_edge: edge, attested, dimensions, ext: extIn } = capabilities as Capabilities;
  if (!CLOSED.observes_crossings.has(observes)) {
    throw new RangeError(`mocon: observes_crossings must be "all", "some" or "none"`);
  }
  const line: HostLine = { kind: "host", host, spec_version: SPEC_VERSION, observes_crossings: observes };
  if (egress !== undefined) {
    if (typeof egress !== "boolean") throw new TypeError("mocon: unmediated_egress must be a boolean");
    line.unmediated_egress = egress;
  }
  if (edge !== undefined) {
    if (!CLOSED.crossing_edge.has(edge)) throw new RangeError(`mocon: crossing_edge must be "invocation" or "dispatch"`);
    line.crossing_edge = edge;
  }
  if (attested !== undefined) {
    if (!Array.isArray(attested)) throw new TypeError("mocon: attested must be an array");
    const entries = [...attested] as unknown[];
    for (const entry of entries) {
      if (!CLOSED.attested.has(entry)) throw new RangeError(`mocon: unknown attested entry ${JSON.stringify(entry)}`);
    }
    line.attested = entries as Attestation[];
  }
  const declared = checkDimensions(dimensions);
  if (declared !== undefined) line.dimensions = declared;
  // Serialized once and parsed back, so the declaration carries plain data and a toJSON inside runs once.
  const ext = objectJson(checkExt(extIn, "capabilities.ext"));
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
