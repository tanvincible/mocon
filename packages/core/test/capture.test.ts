/**
 * Capture: caps, truncation, redaction, hashing, binary, the single-pass
 * bounded walker against JSON.stringify, and what a program-controlled
 * value cannot do to the capture: run code twice, answer differently to
 * a second read, escape the cap, or reach a sink.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { CaptureContext, Payload } from "../src/index.js";
import { DEFAULT_CAPS, Encoder } from "../src/payload.js";
import { assertValidStream, harness, NO_PREVIEW, type Rec } from "./helpers.js";

const sha = (s: string | Uint8Array): string => "sha256:" + createHash("sha256").update(s).digest("hex");
/** The default encoder on its own; a value that serializes to nothing is written as `null`, as the capture writes it. */
const encode = (value: unknown, cap: number): ReturnType<Encoder["encode"]> => {
  const encoder = new Encoder(cap);
  const e = encoder.encode(value, cap, true);
  return e.omitted ? encoder.known("null", cap, true) : e;
};
/** The prefix a truncated `valueText` holds. */
const prefixOf = (valueText: string | undefined): string => (valueText === undefined ? "" : (JSON.parse(valueText) as string));

/** One crossing with `value` as its output; returns the output Payload. */
function outputOf(h: ReturnType<typeof harness>, target: string, value: unknown): Rec {
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target, input: null }).output(value);
  ex.complete();
  return (h.last("crossing")["end"] as Rec)["output"] as Rec;
}

/** One crossing with `value` as its input; returns the crossing line. */
function inputLine(h: ReturnType<typeof harness>, value: unknown): Rec {
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: value }).output(1);
  ex.complete();
  return h.last("crossing");
}

test("a 3 MB string output is cut so its value fills the cap on the wire, with a true prefix and no claim about bytes it did not read", () => {
  const big = "a".repeat(3 * 1024 * 1024);
  const out = outputOf(harness({ capture: NO_PREVIEW }), "big", big);
  assert.equal(out["truncated"], true);
  const value = out["value"] as string;
  assert.ok(JSON.stringify(big).startsWith(value));
  const wire = Buffer.byteLength(JSON.stringify(value));
  assert.ok(wire <= DEFAULT_CAPS["crossing.output"]);
  assert.ok(wire > DEFAULT_CAPS["crossing.output"] - 6, "the prefix fills the cap up to a code point boundary");
  assert.equal("bytes" in out, false);
  assert.equal("hash" in out, false);
});

test("a string longer than 64 times the cap is recorded as truncated without reading a character of it", () => {
  const out = outputOf(harness({ capture: { caps: { "crossing.output": 1024 } } }), "big", "a".repeat(64 * 1024 + 1));
  assert.deepEqual(out, { truncated: true });
});

test("bytes and hash always describe the original, never the prefix", () => {
  const big = "b".repeat(5 * 1024 * 1024);
  const full = JSON.stringify(big);
  // A program is hashed in full even when its value is cut.
  const h = harness();
  h.m.execution.start({ program: big, notice: false }).complete();
  const program = h.last("execution")["program"] as Rec;
  assert.equal(program["truncated"], true);
  assert.ok(big.startsWith(program["value"] as string));
  assert.ok(Buffer.byteLength(JSON.stringify(program["value"])) <= DEFAULT_CAPS.program);
  assert.equal(program["bytes"], big.length);
  assert.equal(program["hash"], sha(big));
  // hash-only reads the original in full by request.
  const h2 = harness({ capture: { rules: { "crossing.output": "hash-only" } } });
  assert.deepEqual(outputOf(h2, "big", big), { redacted: true, bytes: full.length, hash: sha(full) });
  // A value the encoder did read in full, but whose escapes push it past the cap, keeps both.
  const h3 = harness({ capture: { caps: { "crossing.output": 64 } } });
  const escaped = "\n".repeat(40);
  const out = outputOf(h3, "esc", escaped);
  assert.equal(out["truncated"], true);
  assert.equal(out["bytes"], JSON.stringify(escaped).length);
  assert.equal(out["hash"], sha(JSON.stringify(escaped)));
  assert.ok(JSON.stringify(escaped).startsWith(out["value"] as string));
});

test("the default program cap keeps an execution line under 1 MiB (core.md 3)", () => {
  const h = harness();
  h.m.execution.start({ program: "a".repeat(1 << 20), notice: false }).complete();
  const line = h.sink.lines[1] as string;
  assert.ok(Buffer.byteLength(line) < 1 << 20, `line is ${Buffer.byteLength(line)} bytes`);
  assertValidStream(h.sink.lines);
});

test("a redact rule replaces the value and sets redacted without bytes or hash", () => {
  const h = harness({
    capture: {
      rules: {
        "crossing.input": (v, ctx) => (ctx.target?.startsWith("crm.update_") === true ? ctx.capture({ ...(v as Rec), ssn: "***" }, { redacted: true }) : ctx.capture(v)),
      },
    },
  });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "crm.update_contact", input: { id: 1, ssn: "123-45-6789" } }).output({ ok: true });
  ex.crossing.start({ target: "crm.lookup", input: { id: 1, ssn: "123-45-6789" } }).output({ ok: true });
  ex.complete();
  const [masked, plain] = h.ofKind("crossing") as [Rec, Rec];
  assert.deepEqual(masked["input"], { value: { id: 1, ssn: "***" }, redacted: true });
  assert.deepEqual((plain["input"] as Rec)["value"], { id: 1, ssn: "123-45-6789" });
  assert.equal(typeof (plain["input"] as Rec)["hash"], "string");
  assert.equal(h.sink.lines[1]?.includes("6789"), false, "the redacted line never carried the original");
});

test("drop and hash-only directives, as rules and as function results, one rule per slot telling targets and channels apart", () => {
  const value = { token: "secret", n: [1, 2, 3] };
  const text = JSON.stringify(value);
  const h = harness({
    capture: {
      rules: {
        "crossing.input": (_v, ctx) => (ctx.target === "fn.hash" ? "hash-only" : "drop"),
        "crossing.output": (v, ctx) => (ctx.target === "auth.login" ? "hash-only" : ctx.capture(v)),
        result: "hash-only",
        outputs: (_v, ctx) => (ctx.channel === "stderr" ? "drop" : "hash-only"),
        error: "drop",
      },
    },
  });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "auth.login", input: value }).output(value);
  ex.crossing.start({ target: "fn.drop", input: value }).output(value);
  ex.crossing.start({ target: "fn.hash", input: value }).error({ code: 7 });
  ex.fail(new Error("x"), { result: value, outputs: { stdout: "out", stderr: "err" } });
  const [auth, fnDrop, fnHash] = h.ofKind("crossing") as [Rec, Rec, Rec];
  assert.deepEqual(auth["input"], { redacted: true });
  assert.deepEqual((auth["end"] as Rec)["output"], { redacted: true, bytes: text.length, hash: sha(text) });
  assert.deepEqual(fnDrop["input"], { redacted: true });
  assert.deepEqual((fnDrop["end"] as Rec)["output"], { value, bytes: text.length, hash: sha(text) }, "ctx.capture writes what the default encoder writes");
  assert.deepEqual(fnHash["input"], { redacted: true, bytes: text.length, hash: sha(text) });
  assert.deepEqual((fnHash["end"] as Rec)["error"], { class: "capability_error", value: { value: { code: 7 }, bytes: 10, hash: sha('{"code":7}') } });
  const end = h.last("execution")["end"] as Rec;
  assert.deepEqual(end["result"], { redacted: true, bytes: text.length, hash: sha(text) });
  assert.deepEqual((end["outputs"] as Rec)["stderr"], { redacted: true });
  assert.deepEqual((end["outputs"] as Rec)["stdout"], { redacted: true, bytes: 5, hash: sha('"out"') });
  assert.deepEqual(end["error"], { class: "runtime", value: { redacted: true } }, "a rule on the error slot withholds the message with the value");
});

test("a rule that throws counts as drop, and the policy refuses an unknown slot or a rule that is not a directive or a function", () => {
  const h = harness({
    capture: {
      rules: {
        "crossing.input": () => {
          throw new Error("rule broke");
        },
      },
    },
  });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "boom", input: 1 }).output(2);
  ex.complete();
  assert.deepEqual(h.last("crossing")["input"], { redacted: true });
  assert.throws(() => harness({ capture: { rules: { "crossing.target": "drop" } as never } }), RangeError);
  assert.throws(() => harness({ capture: { rules: { toString: "drop" } as never } }), RangeError);
  assert.throws(() => harness({ capture: { rules: { result: "keep" as never } } }), TypeError);
});

test("a rule's return is checked before it is written: undefined, {} and a Payload the serialization rejects become redacted and never throw into the caller or into end()", async () => {
  // Keyed by target; the result slot has no target and gets the BigInt Payload.
  const bad: Record<string, unknown> = { u: undefined, e: {}, b: { value: { n: 10n } } };
  const rule = (_v: unknown, ctx: CaptureContext): Payload => bad[ctx.target ?? "b"] as Payload;
  const h = harness({ capture: { rules: { "crossing.input": rule, "crossing.output": rule, result: rule } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument(async (_target: string, args: unknown) => args);
  for (const target of ["u", "e", "b"]) assert.equal(await call(target, 1), 1, "the sandbox caller receives its value");
  ex.crossing.start({ target: "u", input: 1 });
  ex.complete({ result: 1 });
  assertValidStream(h.sink.lines);
  const crossings = h.ofKind("crossing");
  assert.equal(crossings.length, 4);
  for (const c of crossings) assert.deepEqual(c["input"], { redacted: true });
  for (const c of crossings.slice(0, 3)) assert.deepEqual((c["end"] as Rec)["output"], { redacted: true });
  assert.equal(((crossings[3] as Rec)["end"] as Rec)["outcome"], "abandoned", "the open crossing is abandoned before the execution ends");
  const complete = h.last("execution");
  assert.equal((complete["end"] as Rec)["disposition"], "completed");
  assert.deepEqual((complete["end"] as Rec)["result"], { redacted: true });
});

test("caps are per slot and validated, including names that are Object.prototype members", () => {
  const h = harness({ capture: { caps: { "crossing.input": 10, result: 12 } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: { key: "value-that-is-long" } }).output("fits under the default cap");
  ex.complete({ result: "twelve bytes plus" });
  const c = h.last("crossing");
  assert.equal((c["input"] as Rec)["truncated"], true);
  assert.equal((c["input"] as Rec)["value"], '{"key"', "the value as written, quotes and escapes included, fills the 10-byte cap");
  assert.equal("truncated" in ((c["end"] as Rec)["output"] as Rec), false);
  const result = (h.last("execution")["end"] as Rec)["result"] as Rec;
  assert.equal(result["truncated"], true);
  assert.equal(result["value"], '"twelve b');
  assert.throws(() => harness({ capture: { caps: { nope: 1 } as never } }), RangeError);
  assert.throws(() => harness({ capture: { caps: { result: 0 } } }), RangeError);
  assert.throws(() => harness({ capture: { caps: { toString: 5 } as never } }), RangeError);
  assert.throws(() => harness({ capture: { caps: { constructor: 5 } as never } }), RangeError);
});

test("an output channel named constructor, toString or hasOwnProperty reaches the outputs rule as a name like any other", () => {
  const h = harness({ capture: { rules: { outputs: (v, ctx) => (ctx.channel === "stderr" ? "drop" : ctx.capture(v)) } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.complete({ outputs: { constructor: "a", toString: "b", hasOwnProperty: "c", stdout: "d", stderr: "e" } });
  const outputs = (h.last("execution")["end"] as Rec)["outputs"] as Rec;
  for (const channel of ["constructor", "toString", "hasOwnProperty", "stdout"]) {
    const p = outputs[channel] as Rec;
    assert.equal(p["redacted"], undefined, `channel ${channel} was written as ${JSON.stringify(p)}`);
    assert.equal(typeof p["hash"], "string");
  }
  assert.deepEqual(outputs["stderr"], { redacted: true });
});

test("a whole-slot binary value travels as base64 with bytes and hash over the raw bytes, and the record's ext says so", () => {
  const raw = new Uint8Array(300);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) & 0xff;
  const h = harness({ capture: { caps: { "crossing.output": 100 } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: raw.subarray(0, 30) });
  c.output(raw.buffer);
  ex.complete({ result: new Uint8Array([1]), outputs: { blob: new Uint8Array([2]) }, ext: { "v.k": 1 } });
  const line = h.last("crossing");
  const b64 = Buffer.from(raw.subarray(0, 30)).toString("base64");
  assert.deepEqual(line["input"], { value: b64, bytes: 30, hash: sha(raw.subarray(0, 30)) });
  const out = (line["end"] as Rec)["output"] as Rec;
  assert.equal(out["truncated"], true);
  assert.equal(out["bytes"], 300, "the raw length is known without reading the bytes");
  assert.equal("hash" in out, false);
  assert.ok(('"' + Buffer.from(raw).toString("base64")).startsWith(out["value"] as string));
  assert.ok((out["value"] as string).length <= 100);
  assert.deepEqual(line["ext"], { "mocon.encoding": { input: "base64", output: "base64" } });
  assert.deepEqual(h.last("execution")["ext"], { "v.k": 1, "mocon.encoding": { result: "base64", "outputs.blob": "base64" } });
  assertValidStream(h.sink.lines);
});

test("an ArrayBuffer from another realm (node:vm) is recognised as binary like one from this realm", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "local", input: new Uint8Array([1, 2, 3]).buffer }).output(1);
  ex.crossing.start({ target: "remote", input: runInNewContext("new Uint8Array([1, 2, 3]).buffer", {}) }).output(1);
  ex.complete();
  const [local, remote] = h.ofKind("crossing").map((c) => c["input"]) as [Rec, Rec];
  assert.deepEqual(remote, local);
  assert.equal(local["value"], "AQID");
});

test("binary nested inside a value is written as a base64 string, bounded by the cap, for Buffer and typed arrays alike", () => {
  const h = harness({ capture: { caps: { "crossing.input": 200 } } });
  const bytes = new Uint8Array(30);
  const small = inputLine(h, { data: bytes, buf: Buffer.from("hi") });
  assert.deepEqual((small["input"] as Rec)["value"], { data: Buffer.from(bytes).toString("base64"), buf: "aGk=" });
  assert.equal((small["input"] as Rec)["bytes"], JSON.stringify({ data: Buffer.from(bytes).toString("base64"), buf: "aGk=" }).length);
  const big = inputLine(h, { data: new Uint8Array(5 * 1024 * 1024) });
  const p = big["input"] as Rec;
  assert.equal(p["truncated"], true);
  assert.ok((p["value"] as string).startsWith('{"data":"AAAA'));
  assert.ok(Buffer.byteLength(JSON.stringify(p["value"])) <= 200);
  assert.deepEqual(big["ext"], { "mocon.encoding": { input: "base64" } }, "binary inside a value is noted like a whole binary value");
});

test("a value the serialization rejects is written as redacted", () => {
  const h = harness();
  const cyc: Rec = {};
  cyc["self"] = cyc;
  assert.deepEqual(outputOf(h, "bigint", { n: 10n }), { redacted: true });
  assert.deepEqual(outputOf(h, "cycle", cyc), { redacted: true });
  assert.deepEqual(outputOf(h, "boxed-bigint", { n: Object(10n) }), { redacted: true });
});

test("undefined is null where a Payload is required and omitted where it is optional", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: undefined });
  c.output(undefined);
  ex.complete({ result: undefined, outputs: { stdout: undefined } });
  const line = h.last("crossing");
  assert.deepEqual(line["input"], { value: null, bytes: 4, hash: sha("null") });
  assert.deepEqual(line["end"], { time: (line["end"] as Rec)["time"], outcome: "output" });
  const end = h.last("execution")["end"] as Rec;
  assert.equal("result" in end, false);
  assert.equal("outputs" in end, false);
});

/* ------------------------------------------------------------------ */
/* The walker against JSON.stringify                                   */
/* ------------------------------------------------------------------ */

class Custom {
  constructor(public a: number) {}
  toJSON(): unknown {
    return { custom: this.a, nested: new Date(0) };
  }
}

const sparse: unknown[] = [];
sparse[3] = "x";

export const corpus: unknown[] = [
  "",
  "plain",
  'quotes " and \\ backslashes \n newlines \t tabs  control  del',
  "café 中文 😀 emoji \ud800 lone high \udc00 lone low",
  "😀".repeat(20),
  0,
  -0,
  1.5,
  -1e-7,
  1e21,
  NaN,
  Infinity,
  true,
  false,
  null,
  undefined,
  () => 1,
  Symbol("s"),
  [],
  {},
  [1, "two", null, undefined, () => 3, Symbol("x"), [4, [5, [6]]]],
  sparse,
  { b: 1, "2": "two", a: [3], "1": "one", u: undefined, f: () => 0, [Symbol("k")]: 1 },
  { "": 0, 'key with "quotes"': { é: "é" } },
  { date: new Date(0), custom: new Custom(7), boxed: [new Number(3), new String("s"), new Boolean(false)] },
  { text: "x".repeat(50), list: Array.from({ length: 30 }, (_, i) => ({ i, name: `n${i}`, tags: ["a", "b"] })) },
  new Map([["k", 1]]),
  Object.create(null),
  { deep: { deeper: { deepest: { value: "é".repeat(40) } } } },
  { fn: Object.assign(() => 1, { toJSON: () => "hi" }), big: "x".repeat(200) },
  runInNewContext('({ n: new Number(3), s: new String("ab"), b: new Boolean(false), o: { k: [1] } })') as object,
  Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
];

test("the bounded walker mirrors JSON.stringify byte for byte at every cap, and a cut value fills the cap on the wire", () => {
  const caps = [1, 2, 3, 4, 5, 7, 8, 11, 13, 16, 21, 32, 50, 64, 100, 127, 200, 1000];
  let checks = 0;
  for (const value of corpus) {
    const full = JSON.stringify(value) ?? "null";
    const fullBytes = Buffer.byteLength(full);
    const whole = inputLine(harness({ capture: { rules: { "crossing.input": "hash-only" } } }), value)["input"] as Rec;
    assert.deepEqual(whole, { redacted: true, bytes: fullBytes, hash: sha(full) }, "hash-only reads the whole serialization, which is JSON.stringify's");
    for (const cap of caps) {
      const e = encode(value, cap);
      const label = `${full.slice(0, 40)} @ ${cap}`;
      if (fullBytes <= cap) {
        assert.equal(e.truncated, false, label);
        assert.equal(e.valueText, full, label);
        assert.equal(e.bytes, fullBytes, label);
        assert.equal("sha256:" + e.hash, sha(full), label);
      } else {
        assert.equal(e.truncated, true, label);
        const prefix = prefixOf(e.valueText);
        assert.ok(full.startsWith(prefix), `${label}: ${JSON.stringify(prefix)} is not a prefix of ${JSON.stringify(full)}`);
        const wire = e.valueText === undefined ? 0 : Buffer.byteLength(e.valueText);
        assert.ok(wire <= cap, label);
        assert.ok(wire > cap - 6, `${label}: a value of ${wire} bytes on the wire stopped short of the cap`);
        if (e.bytes !== undefined) {
          assert.equal(e.bytes, fullBytes, label);
          assert.equal("sha256:" + e.hash, sha(full), label);
        }
      }
      checks++;
    }
  }
  assert.ok(checks > 500);
});

test("the walker throws where JSON.stringify throws, and never reads past the cap", () => {
  const cyc: Rec = {};
  cyc["self"] = cyc;
  assert.throws(() => encode({ n: 1n, big: "x".repeat(100) }, 10), TypeError);
  assert.throws(() => encode({ c: cyc, big: "x".repeat(100) }, 1000), TypeError);
  assert.throws(() => encode({ n: 1n }, 1000), TypeError);
  // Past the cap the value is not read, so a BigInt or a cycle there is never reached.
  const e = encode({ big: "x".repeat(100), n: 1n, c: cyc }, 10);
  assert.equal(e.truncated, true);
  assert.equal(prefixOf(e.valueText), '{"big"');
});

test("a truncated output from another realm is a prefix of the same serialization hash-only would hash", () => {
  const boxed = runInNewContext('({ n: new Number(3), s: new String("ab") })') as Rec;
  const value = { ...boxed, big: "x".repeat(200) };
  const out = outputOf(harness({ capture: { caps: { "crossing.output": 48 } } }), "t", value);
  assert.equal(out["truncated"], true);
  assert.ok(JSON.stringify(value).startsWith(out["value"] as string));
  const hashed = outputOf(harness({ capture: { rules: { "crossing.output": "hash-only" } } }), "t", value);
  assert.equal(hashed["hash"], sha(JSON.stringify(value)));
});

test("a value nested deeper than 256 levels is cut there, so the line that carries it survives recursive JSON code", () => {
  let v: unknown = 0;
  for (let i = 0; i < 5000; i++) v = [v];
  const h = harness({ capture: NO_PREVIEW });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: v, notice: true });
  const input = h.last("crossing")["input"] as Rec;
  assert.equal(input["truncated"], true);
  assert.equal(input["value"], "[".repeat(256));
  assert.doesNotThrow(() => JSON.stringify(JSON.parse(h.sink.lines.at(-1) as string)));
  assertValidStream(h.sink.lines);
});

test("a value nested deeper than JSON.stringify allows is still captured, because the walker's stack is on the heap", () => {
  let v: unknown = 0;
  for (let i = 0; i < 200_000; i++) v = [v];
  assert.throws(() => JSON.stringify(v), RangeError, "precondition: the native serializer overflows");
  const out = outputOf(harness(), "deep", v);
  assert.equal(out["truncated"], true);
  assert.ok((out["value"] as string).startsWith("[[[["));
});

/* ------------------------------------------------------------------ */
/* Program-controlled values run once and stay bounded                 */
/* ------------------------------------------------------------------ */

test("every property, getter and toJSON of a value runs exactly once per capture, under and over the cap", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  let reads = 0;
  let calls = 0;
  const underCap = {
    get a() {
      reads++;
      return "small";
    },
    j: { toJSON: () => (++calls, "tiny") },
  };
  ex.crossing.start({ target: "t", input: underCap }).output(1);
  assert.equal(reads, 1, `a value under the cap: getter read ${reads} times`);
  assert.equal(calls, 1, `toJSON called ${calls} times`);
  reads = 0;
  const overCap = {
    get a() {
      reads++;
      return "small";
    },
    big: "x".repeat(1 << 17),
  };
  ex.crossing.start({ target: "t", input: overCap }).output(1);
  assert.equal(reads, 1, `a value over the cap: getter read ${reads} times`);
  ex.complete();
});

test("a getter or toJSON that answers small first and 50 MB next cannot make the capture O(size): there is no second read", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const huge = "x".repeat(50 << 20);
  let reads = 0;
  const liar = {
    get a() {
      return reads++ % 2 === 0 ? "small" : huge;
    },
  };
  let calls = 0;
  const liarJson = { a: { toJSON: () => (++calls === 1 ? "tiny" : huge) } };
  ex.crossing.start({ target: "t", input: liar }).output(liarJson);
  const line = h.last("crossing");
  assert.deepEqual((line["input"] as Rec)["value"], { a: "small" });
  assert.deepEqual(((line["end"] as Rec)["output"] as Rec)["value"], { a: "tiny" });
  assert.ok(((line["end"] as Rec)["output"] as Rec)["bytes"] as number < 1 << 16, "bytes describe the one serialization that was read");
  ex.complete();
});

test("a getter that opens a crossing during a capture neither disturbs the outer capture nor runs twice", () => {
  const h = harness({ capture: NO_PREVIEW });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const result = {
    get inner() {
      ex.crossing.start({ target: "inner", input: { q: 1 } }).output(undefined);
      return "y";
    },
    big: "x".repeat(20_000),
  };
  ex.complete({ result });
  const payload = (h.last("execution")["end"] as Rec)["result"] as Rec;
  assert.equal(payload["truncated"], undefined, "20 KB is under the 64 KiB result cap");
  assert.equal(typeof payload["bytes"], "number");
  assert.equal(typeof payload["hash"], "string");
  assert.equal(h.ofKind("crossing").length, 1, "one access, one crossing");
});

test("a Proxy's traps cannot reach past the capture: get runs at most once per key the walk reads and a throwing trap redacts the slot", () => {
  const h = harness();
  const gets = new Map<string, number>();
  const target = { a: 1, b: 2 };
  const proxy = new Proxy(target, {
    get: (t, k) => {
      if (typeof k === "string") gets.set(k, (gets.get(k) ?? 0) + 1);
      return Reflect.get(t, k);
    },
  });
  const line = inputLine(h, proxy);
  assert.deepEqual((line["input"] as Rec)["value"], { a: 1, b: 2 });
  assert.equal(gets.get("a"), 1);
  assert.equal(gets.get("b"), 1);
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("no keys for you");
      },
    },
  );
  assert.deepEqual(inputLine(h, hostile)["input"], { redacted: true });
});

test("the crossing target is capped like every other program-determined field, with a note in ext, before the policy sees it", () => {
  const seen: string[] = [];
  const h = harness({ capture: { caps: { "crossing.target": 16 }, rules: { "crossing.input": (_v, ctx) => (seen.push(ctx.target ?? ""), "drop") } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: string, v: unknown) => v);
  call("short", 1);
  call("é".repeat(20), 1);
  ex.complete();
  const [short, long] = h.ofKind("crossing") as [Rec, Rec];
  assert.equal(short["target"], "short");
  assert.equal("ext" in short, false);
  assert.equal(long["target"], "é".repeat(7), "cut at 16 bytes as written, quotes included, on a code point boundary");
  assert.deepEqual(long["ext"], { "mocon.target": { truncated: true } });
  assert.deepEqual(seen, ["short", "é".repeat(7)], "rules see the target as recorded");
  const wide = harness();
  const ex2 = wide.m.execution.start({ program: "p", notice: false });
  wide.m.execution.start({ program: "p", notice: false });
  ex2.instrument((_name: string) => 1)("t".repeat(8 << 20));
  ex2.complete();
  const line = wide.sink.lines.find((l) => l.includes('"kind":"crossing"')) as string;
  assert.ok(Buffer.byteLength(line) < DEFAULT_CAPS["crossing.target"] + 1024, `crossing line is ${Buffer.byteLength(line)} bytes`);
  assertValidStream(wide.sink.lines);
});

test("no program-controlled value can run code or change a record after its capture: getters, toJSON, Proxy traps, __proto__ keys, later mutation", async () => {
  interface Case {
    value: unknown;
    /** How many times program code in the value has run. */
    runs(): number;
    /** What the program does to the value after handing it over. */
    mutate(): void;
    /** The value's JSON as it stood when the crossing started. */
    expected: unknown;
  }
  const cases: Array<[string, () => Case]> = [
    [
      "getter",
      () => {
        let n = 0;
        let answer = "first";
        return {
          value: {
            get a() {
              n++;
              return answer;
            },
          },
          runs: () => n,
          mutate: () => void (answer = "forged"),
          expected: { a: "first" },
        };
      },
    ],
    [
      "toJSON",
      () => {
        let n = 0;
        const state = { q: 1 };
        return { value: { toJSON: () => (n++, { ...state }) }, runs: () => n, mutate: () => void (state.q = 2), expected: { q: 1 } };
      },
    ],
    [
      "Proxy traps",
      () => {
        let n = 0;
        const target: Rec = { a: 1, b: [2] };
        const count = <T>(v: T): T => (n++, v);
        const proxy = new Proxy(target, {
          get: (t, k) => count(Reflect.get(t, k)),
          ownKeys: (t) => count(Reflect.ownKeys(t)),
          getOwnPropertyDescriptor: (t, k) => count(Reflect.getOwnPropertyDescriptor(t, k)),
          getPrototypeOf: (t) => count(Reflect.getPrototypeOf(t)),
        });
        return { value: proxy, runs: () => n, mutate: () => void (target["a"] = "forged"), expected: { a: 1, b: [2] } };
      },
    ],
    [
      "__proto__ key",
      () => {
        const value = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Rec;
        return { value, runs: () => 0, mutate: () => void (value["a"] = 2), expected: JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Rec };
      },
    ],
    [
      "nested mutation",
      () => {
        const inner = { list: [1, 2] };
        return { value: { inner, when: new Date(0) }, runs: () => 0, mutate: () => void inner.list.push(3), expected: { inner: { list: [1, 2] }, when: "1970-01-01T00:00:00.000Z" } };
      },
    ],
  ];
  for (const [name, make] of cases) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const { value, runs, mutate, expected } = make();
    const c = ex.crossing.start({ target: "t", input: value, notice: true });
    const captured = runs();
    mutate();
    const notice = h.last("crossing");
    assert.deepEqual((notice["input"] as Rec)["value"], expected, `${name}: the line carries the value as it stood at capture`);
    c.output(value);
    const afterOutput = runs();
    mutate();
    ex.complete({ result: 1 });
    await h.m.flush();
    const complete = h.last("crossing");
    assert.deepEqual(complete["input"], notice["input"], `${name}: the complete record repeats the notice's input`);
    assert.ok(afterOutput >= captured);
    assert.equal(runs(), afterOutput, `${name}: no program code ran after the last capture`);
    assert.equal(({} as Rec)["polluted"], undefined, `${name}: nothing reached Object.prototype`);
    assertValidStream(h.sink.lines);
  }
});
