/**
 * What a program-built value cannot make the capture do: read memory past
 * a binary value's own bytes, pass an array-like off as binary, make a
 * string or a key the walk will not keep cost more than the cap, flatten
 * a rope far past the cap, serialize differently from `JSON.stringify`,
 * nest so deep that the record no longer serializes, or make the walk read
 * more members than the cap pays for.
 *
 * Every timing here follows the rule stated at the top of
 * `performance.test.ts`: two measurements in the same process, each the
 * minimum of several rounds after a warmup, compared as a ratio with a
 * bound far above the steady state and far below the regression. Most of
 * them scale the hostile value itself, a 1 MB key against a 4 MB one, so
 * the assertion is that the cost does not follow the size, which no
 * machine can make true or false.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { memorySink, mocon } from "../src/index.js";
import { assertValidStream, harness, least, type Rec } from "./helpers.js";

/* ------------------------------------------------------------------ */

const SECRET = "host-secret-7f3a9c1e2b";

/** A secret and a short Buffer that share one pool slab, the second handed to the program. */
function pooledPair(): { secret: Buffer; handed: Buffer } {
  for (let i = 0; i < 8; i++) {
    const secret = Buffer.from(SECRET);
    const handed = Buffer.from("ok");
    if (secret.buffer === handed.buffer) return { secret, handed };
  }
  throw new Error("precondition: Buffer.from did not pool two short strings together");
}

/** What a program does to a Buffer it holds: own properties that claim the whole pool slab. */
function widen(b: Buffer): Buffer {
  Object.defineProperty(b, "byteOffset", { value: 0 });
  Object.defineProperty(b, "byteLength", { value: b.buffer.byteLength });
  return b;
}

test("a result Buffer with its own byteOffset and byteLength records only its own two bytes", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink] });
  const { secret, handed } = pooledPair();
  const ex = m.execution.start({ program: "return buf" });
  ex.complete({ result: widen(handed) });
  const result = (JSON.parse(sink.lines.at(-1) as string) as { end: { result: { value?: unknown; bytes?: number } } }).end.result;
  assert.ok(secret.length > 0);
  assert.ok(!Buffer.from(String(result.value ?? ""), "base64").includes(SECRET), "the record carries host memory from the Buffer pool");
  assert.equal(result.bytes, 2, `the record claims ${result.bytes} bytes for a 2-byte Buffer`);
});

test("a Buffer nested in a crossing input with its own byteOffset and byteLength leaks nothing from the pool", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink] });
  const { handed } = pooledPair();
  const ex = m.execution.start({ program: "callTool('upload', { data: buf })" });
  const upload = ex.instrument((_name: string, _args: unknown) => "done");
  upload("upload", { data: widen(handed) });
  const crossing = JSON.parse(sink.lines.at(-1) as string) as { input: { value?: { data?: unknown } } };
  assert.ok(!Buffer.from(String(crossing.input.value?.data ?? ""), "base64").includes(SECRET), "the crossing input carries host memory from the Buffer pool");
});

/* ------------------------------------------------------------------ */

const FORGED_LENGTH = 4e7;
/** The same forged value, ten times as long. A capture that believed the length would cost ten times as much. */
const FORGED_LENGTH_10X = 4e8;
/** Ratio bound for a cost that must not follow the size of the value. The steady state is about one. */
const SIZE_BLIND = 5;

test("a thrown object from node:vm that names itself ArrayBuffer is not binary and costs the same whatever length it claims", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink] });
  const forge = (length: number): unknown => runInNewContext(`({ [Symbol.toStringTag]: "ArrayBuffer", length: ${length} })`);
  const fail = (thrown: unknown): number => {
    const ex = m.execution.start({ program: "throw fake", notice: false });
    const began = performance.now();
    ex.fail(thrown);
    return performance.now() - began;
  };
  const claimed = forge(FORGED_LENGTH);
  fail(claimed);
  const line = JSON.parse(sink.lines.at(-1) as string) as { end: { error: { value?: { bytes?: number } } } };
  assert.notEqual(line.end.error.value?.bytes, FORGED_LENGTH, "the record claims the program's made-up length as binary bytes");
  const ten = forge(FORGED_LENGTH_10X);
  const short = least(() => fail(claimed));
  const long = least(() => fail(ten));
  assert.ok(long <= short * SIZE_BLIND, `fail() took ${long.toFixed(3)} ms for a ${FORGED_LENGTH_10X}-element forged ArrayBuffer against ${short.toFixed(3)} ms for a ${FORGED_LENGTH}-element one`);
});

test("a nested class instance that names itself SharedArrayBuffer costs the same whatever length it claims", () => {
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [memorySink()] });
  class Fake {
    constructor(private readonly claimed: number) {}
    get [Symbol.toStringTag](): string {
      return "SharedArrayBuffer";
    }
    get length(): number {
      return this.claimed;
    }
  }
  const complete = (value: unknown): number => {
    const ex = m.execution.start({ program: "return fake", notice: false });
    const began = performance.now();
    ex.complete({ result: { data: value } });
    return performance.now() - began;
  };
  const short = least(() => complete(new Fake(FORGED_LENGTH)));
  const long = least(() => complete(new Fake(FORGED_LENGTH_10X)));
  assert.ok(long <= short * SIZE_BLIND, `complete() took ${long.toFixed(3)} ms for a nested ${FORGED_LENGTH_10X}-element forged SharedArrayBuffer against ${short.toFixed(3)} ms for a ${FORGED_LENGTH}-element one`);
});

test("a crossing input that names itself ArrayBuffer costs the same whatever length it claims", () => {
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [memorySink()] });
  const ex = m.execution.start({ program: "callTool(fake)", notice: false });
  const tool = ex.instrument((_name: string, _args: unknown) => 1);
  const forge = (length: number): unknown => runInNewContext(`({ [Symbol.toStringTag]: "ArrayBuffer", length: ${length} })`);
  const claimed = forge(FORGED_LENGTH);
  const ten = forge(FORGED_LENGTH_10X);
  const call = (input: unknown): number => {
    const began = performance.now();
    tool("t", input);
    return performance.now() - began;
  };
  const short = least(() => call(claimed));
  const long = least(() => call(ten));
  assert.ok(long <= short * SIZE_BLIND, `a crossing took ${long.toFixed(3)} ms for a ${FORGED_LENGTH_10X}-element forged ArrayBuffer input against ${short.toFixed(3)} ms for a ${FORGED_LENGTH}-element one`);
});

/* ------------------------------------------------------------------ */

const CAP = 1 << 12;

function captureMs(value: unknown): { ms: number; output: Rec } {
  const h = harness({ capture: { caps: { "crossing.output": CAP } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: null });
  const t0 = performance.now();
  c.output(value);
  const ms = performance.now() - t0;
  return { ms, output: (h.last("crossing")["end"] as Rec)["output"] as Rec };
}

/** A control character escapes to six characters, the worst case for JSON.stringify. */
const ESCAPED = String.fromCharCode(1);

test("a key that carries the walk past the cap does not make the next string value cost O(size)", () => {
  const pad = "x".repeat(CAP - 16);
  const longKey = "k".repeat(48);
  // `{"a":"xxx…` stops just under the cap; the 48-character key then pushes the output past it before the big string is read.
  const oneMB = ESCAPED.repeat(1_000_000);
  const fourMB = ESCAPED.repeat(4_000_000);
  assert.equal(captureMs({ a: pad, [longKey]: fourMB }).output["truncated"], true);
  const small = least(() => captureMs({ a: pad, [longKey]: oneMB }).ms, 5);
  const large = least(() => captureMs({ a: pad, [longKey]: fourMB }).ms, 5);
  assert.ok(large <= small * SIZE_BLIND, `a 4 MB string read after the cap was passed cost ${large.toFixed(3)} ms against ${small.toFixed(3)} ms for a 1 MB one`);
});

test("a key longer than the cap is not escaped in full", () => {
  const oneMB = ESCAPED.repeat(1_000_000);
  const fourMB = ESCAPED.repeat(4_000_000);
  assert.equal(captureMs({ [fourMB]: 1 }).output["truncated"], true);
  const small = least(() => captureMs({ [oneMB]: 1 }).ms, 5);
  const large = least(() => captureMs({ [fourMB]: 1 }).ms, 5);
  assert.ok(large <= small * SIZE_BLIND, `a 4 MB key cost ${large.toFixed(3)} ms against ${small.toFixed(3)} ms for a 1 MB one`);
});

test("a result object with one 60 M character key costs what one of 15 M costs", () => {
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [{ write() {} }] });
  const quarter = { [ESCAPED.repeat(1.5e7)]: 1 };
  const whole = { [ESCAPED.repeat(6e7)]: 1 };
  const time = (value: unknown): number => {
    const ex = m.execution.start({ program: "return value", notice: false });
    const began = performance.now();
    ex.complete({ result: value });
    return performance.now() - began;
  };
  const small = least(() => time(quarter), 5);
  const large = least(() => time(whole), 5);
  assert.ok(large <= small * SIZE_BLIND, `a 60 M character key took ${large.toFixed(3)} ms against ${small.toFixed(3)} ms for a 15 M character one`);
});

/* ------------------------------------------------------------------ */

/** `s + s` twenty-six times: 134 million characters, kept by V8 as a rope until a character is read, which flattens all of it. */
function rope(doublings: number): string {
  let s = "ab";
  for (let i = 0; i < doublings; i++) s = s + s;
  return s;
}

test("a program-built rope of 134 million characters costs a crossing output about what a 5 MB string costs", () => {
  const timeOutput = (make: () => unknown): { ms: number; output: Rec } => {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const value = make();
    const c = ex.crossing.start({ target: "t", input: null });
    const t0 = performance.now();
    c.output(value);
    const ms = performance.now() - t0;
    return { ms, output: (h.last("crossing")["end"] as Rec)["output"] as Rec };
  };
  assert.equal(timeOutput(() => rope(26)).output["truncated"], true);
  const baseline = least(() => timeOutput(() => "x".repeat(5 << 20)).ms, 5);
  const ms = least(() => timeOutput(() => rope(26)).ms, 5);
  assert.ok(ms <= baseline * SIZE_BLIND, `the rope cost ${ms.toFixed(3)} ms against ${baseline.toFixed(3)} ms for a 5 MB string`);
});

test("a program-built rope used as a crossing target costs about what a 5 MB target costs", () => {
  const time = (target: () => string): number => {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const call = ex.instrument((_name: string) => 1);
    const name = target();
    const t0 = performance.now();
    call(name);
    return performance.now() - t0;
  };
  const baseline = least(() => time(() => "x".repeat(5 << 20)), 5);
  const ms = least(() => time(() => rope(26)), 5);
  assert.ok(ms <= baseline * SIZE_BLIND, `the rope target cost ${ms.toFixed(3)} ms against ${baseline.toFixed(3)} ms for a 5 MB target`);
});

/* ------------------------------------------------------------------ */

function outputOf(value: unknown): Rec {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: null }).output(value);
  return (h.last("crossing")["end"] as Rec)["output"] as Rec;
}

const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

test("a JSON.rawJSON value is serialized as JSON.stringify serializes it", { skip: typeof rawJSON !== "function" }, () => {
  const value = { n: rawJSON!("12345678901234567890") };
  const expected = JSON.stringify(value);
  const output = outputOf(value);
  assert.equal(output["bytes"], Buffer.byteLength(expected), `JSON.stringify gives ${expected}; the Payload holds ${JSON.stringify(output["value"])}`);
});

test("a boxed number with its own valueOf is serialized as JSON.stringify serializes it", () => {
  const value = { n: Object.assign(new Number(5), { valueOf: () => 7 }) };
  const expected = JSON.stringify(value);
  assert.deepEqual(outputOf(value)["value"], JSON.parse(expected), `JSON.stringify gives ${expected}`);
});

test("a class instance's Symbol.toStringTag getter never runs, as JSON.stringify never reads it", () => {
  let reads = 0;
  class Tagged {
    a = 1;
    get [Symbol.toStringTag](): string {
      reads++;
      return "Tagged";
    }
  }
  outputOf(new Tagged());
  assert.equal(reads, 0, `the getter ran ${reads} times`);
});

test("an array's length is read once, as JSON.stringify reads it, so an array that grows while it is captured is written as it was", () => {
  let reads = 0;
  const proxy = new Proxy([1, 2, 3, 4, 5], {
    get(target, key, receiver) {
      if (key === "length") reads++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  outputOf(proxy);
  assert.equal(reads, 1, `length was read ${reads} times`);

  const build = (): { list: unknown[]; calls: () => number } => {
    const list: unknown[] = [];
    let calls = 0;
    const item = {
      toJSON() {
        calls++;
        if (calls < 1_000_000) list.push(item);
        return 1;
      },
    };
    list.push(item);
    return { list, calls: () => calls };
  };
  const reference = build();
  const expected = JSON.stringify(reference.list);
  assert.equal(expected, "[1]");
  const probe = build();
  assert.deepEqual(outputOf(probe.list)["value"], JSON.parse(expected));
  assert.equal(probe.calls(), reference.calls(), `toJSON ran ${probe.calls()} times; JSON.stringify ran it ${reference.calls()} time`);
});

/* ------------------------------------------------------------------ */

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

test("the line of a crossing whose input the program nested 5000 deep parses and serializes again with recursive JSON code", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: nested(5000), notice: true });
  const line = h.sink.lines.at(-1) as string;
  assert.doesNotThrow(() => JSON.stringify(JSON.parse(line)));
});

/* ------------------------------------------------------------------ */

test("binary nested in a crossing input is base64 with a note in ext", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "upload", input: { name: "a.bin", data: new Uint8Array([1, 2, 3]) } }).output({ ok: true });
  const rec = h.last("crossing");
  assert.deepEqual((rec["input"] as Rec)["value"], { name: "a.bin", data: "AQID" });
  assert.deepEqual(rec["ext"], { "mocon.encoding": { input: "base64" } });
});

test("binary nested in an execution result is base64 with a note in ext", () => {
  const h = harness();
  h.m.execution.start({ program: "p", notice: false }).complete({ result: { image: Buffer.from("png") } });
  assert.deepEqual(h.last("execution")["ext"], { "mocon.encoding": { result: "base64" } });
});

/* ------------------------------------------------------------------ */
/* Members that serialize to nothing                                   */
/* ------------------------------------------------------------------ */

const MEMBERS = 100_000;
const EMPTY_CAP = 1024;

test("members whose getters return undefined are read O(cap) times, not once per member", () => {
  const h = harness({ capture: { caps: { "crossing.input": EMPTY_CAP } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  let reads = 0;
  const value: Record<string, unknown> = {};
  for (let i = 0; i < MEMBERS; i++) {
    Object.defineProperty(value, "k" + i, {
      enumerable: true,
      get() {
        reads++;
        return undefined;
      },
    });
  }
  ex.crossing.start({ target: "t", input: value });
  assert.ok(reads <= 4 * EMPTY_CAP, `${reads} getters ran for a ${EMPTY_CAP}-byte cap`);
});

test("members whose toJSON returns undefined run O(cap) toJSON calls, not one per member", () => {
  const h = harness({ capture: { caps: { "crossing.output": EMPTY_CAP } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  let calls = 0;
  const member = {
    toJSON(): undefined {
      calls++;
      return undefined;
    },
  };
  const value: Record<string, unknown> = {};
  for (let i = 0; i < MEMBERS; i++) value["k" + i] = member;
  ex.crossing.start({ target: "t", input: null }).output(value);
  assert.ok(calls <= 4 * EMPTY_CAP, `${calls} toJSON calls ran for a ${EMPTY_CAP}-byte cap`);
});

/* ------------------------------------------------------------------ */
/* Nothing retained per execution                                      */
/* ------------------------------------------------------------------ */

const isObject = (v: unknown): v is object => v !== null && (typeof v === "object" || typeof v === "function");

/**
 * Every object reachable from `root` by its own data properties, and
 * through the entries of a `Map` or a `Set`. A getter is not run and a
 * buffer's bytes are not walked, so the count is what the capture holds,
 * not what it is looking at.
 */
function reachable(root: object): number {
  const seen = new Set<object>();
  const stack = [root];
  while (stack.length > 0) {
    const o = stack.pop() as object;
    if (seen.has(o)) continue;
    seen.add(o);
    if (o instanceof ArrayBuffer || ArrayBuffer.isView(o)) continue;
    if (o instanceof Map) for (const entry of o) for (const v of entry) if (isObject(v)) stack.push(v);
    if (o instanceof Set) for (const v of o) if (isObject(v)) stack.push(v);
    for (const key of Reflect.ownKeys(o)) {
      const d = Reflect.getOwnPropertyDescriptor(o, key);
      if (d === undefined || d.get !== undefined) continue;
      if (isObject(d.value)) stack.push(d.value as object);
    }
  }
  return seen.size;
}

test("the capture holds nothing per execution, however many distinct line budgets the executions leave behind", () => {
  const h = harness();
  const capture = (h.m.execution.start({ program: "p", notice: false }) as unknown as { inst: { capture: object } }).inst.capture;
  const channel = "y".repeat(60_000);
  // Each execution leaves a different number of bytes for its last slots, because its program is a different length.
  const run = (from: number, count: number): void => {
    for (let i = from; i < from + count; i++) {
      const outputs: Record<string, string> = { tail: "z".repeat(10 + (i % 997)), tail2: "w" };
      for (let c = 0; c < 17; c++) outputs["c" + c] = channel;
      h.m.execution.start({ program: "p".repeat(1000 + i * 7), notice: false }).complete({ outputs });
    }
  };
  run(0, 50);
  const early = reachable(capture);
  run(50, 500);
  assert.equal(reachable(capture), early, `the capture reached ${early} objects after 50 executions and ${reachable(capture)} after 550`);
});

/* ------------------------------------------------------------------ */
/* What a program reaches outside a payload: the envelope, the option  */
/* containers, and the target coercion.                                */
/* ------------------------------------------------------------------ */

/** Installs `toJSON` on `Object.prototype`, the way a program that escaped its sandbox reaches the host realm. */
function polluteObjectPrototype(): () => void {
  Object.defineProperty(Object.prototype, "toJSON", { value: () => "PWNED", configurable: true, writable: true });
  return () => void delete (Object.prototype as { toJSON?: unknown }).toJSON;
}

test("Object.prototype.toJSON reaches no line: the declaration refuses to be built, and every later line is still a JSON object", () => {
  let clean = (): void => undefined;
  try {
    clean = polluteObjectPrototype();
    assert.throws(
      () => mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [memorySink()] }),
      TypeError,
      "core.md 5.1 wants a host record on every stream, so a declaration that would not be an object refuses construction",
    );
    clean();

    const h = harness();
    const ex = h.m.execution.start({ program: "p", context: { session: "s", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }, ext: { "h.k": 1 } });
    clean = polluteObjectPrototype();
    const settled = ex.crossing.start({ target: "t", input: { a: 1 }, notice: true, ext: { "c.k": 1 } });
    settled.output({ ok: true });
    const open = ex.crossing.start({ target: "u", input: new Uint8Array([1, 2, 3]) });
    ex.complete({ result: { r: 1 }, outputs: { stdout: "out" }, ext: { "e.k": 2 } });
    open.output("after the end");
    clean();

    assertValidStream(h.sink.lines);
    for (const record of h.records()) {
      for (const field of ["ext", "context"]) {
        const value = record[field];
        assert.ok(value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value)), `${field} is ${JSON.stringify(value)}`);
      }
    }
    assert.deepEqual(h.last("execution")["context"], { session: "s", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    assert.equal(h.ofKind("event").length, 1, "the late settlement is still one event");
  } finally {
    clean();
  }
});

test("a hostile outputs container answers with mocon's own TypeError, and the handle is left as it was", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "open", input: 1 });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile: Array<[string, unknown]> = [
    [
      "a getter that throws",
      {
        get stdout(): string {
          throw new Error("program getter in outputs");
        },
      },
    ],
    [
      "an ownKeys trap that throws",
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("program ownKeys in outputs");
          },
        },
      ),
    ],
    ["a revoked proxy", revoked.proxy],
  ];
  for (const [what, outputs] of hostile) {
    assert.throws(() => ex.complete({ outputs: outputs as Record<string, unknown> }), TypeError, `outputs: ${what}`);
  }
  assert.equal(h.ofKind("execution").length, 0, "a rejected call writes nothing");

  ex.complete({ outputs: { stdout: "ok" } });
  assert.deepEqual(
    h.records().map((r) => [r["kind"], (r["end"] as Rec | undefined)?.["outcome"] ?? (r["end"] as Rec | undefined)?.["disposition"]]),
    [
      ["host", undefined],
      ["crossing", "abandoned"],
      ["execution", "completed"],
    ],
  );
  assertValidStream(h.sink.lines);
});

test("a crossing target is never coerced through the value's own code, so a value cannot choose what the target step costs", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: unknown) => 1);
  const read: string[] = [];
  // A proxy over three elements claiming a length of 1e8: O(1) for the program, and Array.prototype.join
  // for the whole claimed length if anything coerces it.
  const lying = new Proxy([1, 2, 3], {
    get: (t, k, r) => {
      read.push(String(k));
      return k === "length" ? 1e8 : (Reflect.get(t, k, r) as unknown);
    },
  });
  let ran = false;
  const named = {
    toString: () => {
      ran = true;
      return "named";
    },
  };
  call(lying as unknown as string);
  call(named as unknown as string);
  ex.complete();
  assert.deepEqual(read, [], "the target step reads nothing from the value");
  assert.equal(ran, false, "the value's own toString never runs");
  assert.deepEqual(
    h.ofKind("crossing").map((c) => c["target"]),
    ["[object]", "[object]"],
  );
  assertValidStream(h.sink.lines);
});
