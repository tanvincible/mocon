/**
 * The readings this sink commits to where otel-mapping.md leaves room, so
 * a second implementation can be checked against them rather than against
 * a prose sentence that supports two answers. Each test names the rule and
 * says where the room is; packages/otel/README.md states the same answers
 * for a reader who is not running the suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { attrs, crossing, declared, execution, HOST, mapped, spanOf } from "./helpers.js";

test("mocon.provenance.ext.p holds the bare ext key, in the order the line carried it: not the attribute name and not the field name", () => {
  // otel-mapping.md 10 gives the formula as `[<key>, ...]`, the prose as "every mocon.ext.<key> name" and
  // the naming rule as "the attribute name with the leading mocon. removed": three spellings of one array.
  // This is the first, which the spec's own OTLP fixtures carry.
  const line = crossing({ ext: { "example.credits_used": 3, "vendor.b": "x", "vendor.a": true } }, { outcome: "output", output: { value: 1 } });
  const span = attrs(spanOf(mapped(line).request));
  assert.deepEqual(span["mocon.provenance.ext.p"], ["example.credits_used", "vendor.b", "vendor.a"]);
  assert.equal(span["mocon.ext.example.credits_used"], "3", "the attribute keeps the mocon.ext. prefix the array drops");
});

test("a leap second is a timestamp: it maps to the first instant of the next minute rather than making the line unusable", () => {
  // RFC 3339 5.6 allows second 60, so a sink that rejects it and one that accepts it both read the document
  // as written and disagree about whether a span exists at all. This sink accepts it, through the one
  // validator @mocon/core applies everywhere, and the instant it lands on is stated here.
  const leap = mapped(execution({ start: "2026-12-31T23:59:60Z" }, { time: "2027-01-01T00:00:01Z", disposition: "completed" }));
  assert.equal(leap.skipped, undefined, "the line is mapped, not skipped");
  const next = mapped(execution({ start: "2027-01-01T00:00:00Z" }, { time: "2027-01-01T00:00:01Z", disposition: "completed" }));
  assert.equal(spanOf(leap.request).startTimeUnixNano, spanOf(next.request).startTimeUnixNano, "second 60 is the first instant of the next minute");
});

test("a date or a time that names no instant is a bad timestamp, however well it matches the shape of one", () => {
  for (const start of ["2026-02-30T10:00:00Z", "2026-09-16T25:00:00Z", "2026-09-16T10:60:00Z", "2026-13-01T10:00:00Z"]) {
    const m = mapped(execution({ start }, { time: "2026-09-16T10:00:01Z", disposition: "completed" }));
    assert.equal(m.skipped, "bad_timestamp", start);
  }
});

test("an UNSET status is written as an explicit code 0, so two sinks compare equal key for key", () => {
  // spec/conformance/otlp's comparison is structural, so `{}` and `{"code":0}` — the same message in proto3
  // — fail each other's check. This sink always writes the code.
  const terminated = execution({}, { time: "2026-09-16T10:00:01Z", disposition: "terminated", error: { class: "cancelled" } });
  assert.deepEqual(spanOf(mapped(terminated).request).status, { code: 0 });
  const abandoned = crossing({}, { outcome: "abandoned" });
  assert.deepEqual(spanOf(mapped(abandoned).request).status, { code: 0 });
});

test("a stream with no complete execution line exports no mocon.host.*: the declaration's five fields ride on execution spans only", () => {
  // otel-mapping.md 6.2 puts them there, so a stream of crossings alone carries neither `observes_crossings`
  // nor `unmediated_egress` into the export, and a backend reading it cannot reach the conclusion core.md 12
  // needs those two fields for. It is a real loss, stated here so it is not mistaken for an accident.
  const declaration = declared(["crossing.target"], { unmediated_egress: false });
  const span = attrs(spanOf(mapped(crossing({}, { outcome: "output", output: { value: 1 } }), declaration).request));
  assert.equal(span["mocon.host"], HOST, "the host string is on every span");
  assert.deepEqual(
    Object.keys(span).filter((k) => k.startsWith("mocon.host.")),
    [],
    "a crossing span carries no field of the declaration",
  );
  assert.equal(span["mocon.provenance.crossing.target"], undefined, "the declaration is still applied to the labels");
});

test("an attested entry this version does not know is ignored twice over: it reaches neither mocon.host.attested nor any label", () => {
  const declaration = { ...declared(["crossing.target"]), attested: ["crossing.target", "crossing.everything"] } as never;
  const span = attrs(spanOf(mapped(execution(), declaration).request));
  assert.deepEqual(span["mocon.host.attested"], ["crossing.target"], "the unknown entry is not copied into the attribute");
  const crossingSpan = attrs(spanOf(mapped(crossing({}, { outcome: "output", output: { value: 1 } }), declaration).request));
  assert.equal(crossingSpan["mocon.provenance.crossing.target"], undefined, "the entry it does know still lifts its own label");
  assert.equal(crossingSpan["mocon.provenance.crossing.output.value"], "P", "the unknown entry lifts nothing");
});

test("with a cap, the truncation flag for an ext key collides with an ext key of that name plus .truncated", () => {
  // otel-mapping.md 9 names the flag `<key>.truncated`, and ext keys are an open `vendor.key` namespace, so
  // a stream can name a key that reads as another key's flag. Both attributes are written, in line order,
  // and a reader cannot tell them apart. Pinned here because a sink that "fixed" it would diverge from the
  // document, and from every other sink, on a stream that does not do this.
  const line = crossing({ ext: { "v.k": "0123456789", "v.k.truncated": "kept" } }, { outcome: "output", output: { value: 1 } });
  const written = spanOf(mapped(line, undefined, { cap: 4 }).request).attributes.filter((a) => a.key === "mocon.ext.v.k.truncated");
  assert.equal(written.length, 2, "the cap flag and the real key are two attributes of one name");
  assert.deepEqual(written[0]?.value, { boolValue: true }, "the flag for v.k comes first, where the cut happened");
  assert.deepEqual(written[1]?.value, { stringValue: "kept" }, "the stream's own key follows, cut to the cap like any other value");
});

test("a declaration governs the records that follow it: a span mapped without one carries no mocon.host.* and labels every field P", () => {
  // The same stream split, rotated or tailed from the middle can present the host line after the records it
  // governs, which core.md 4.4 allows. A sink maps a line when it arrives, so the export depends on where
  // the declaration sat. This is the shape of that dependence, not a claim that it is desirable.
  const withDeclaration = attrs(spanOf(mapped(crossing({}, { outcome: "output", output: { value: 1 } }), declared(["crossing.target", "crossing.output"])).request));
  const without = attrs(spanOf(mapped(crossing({}, { outcome: "output", output: { value: 1 } })).request));
  assert.equal(withDeclaration["mocon.provenance.crossing.target"], undefined);
  assert.equal(withDeclaration["mocon.provenance.crossing.output.value"], "T");
  assert.equal(without["mocon.provenance.crossing.target"], "P", "an unseen declaration reads as attesting nothing");
  assert.equal(without["mocon.provenance.crossing.output.value"], "P");
  assert.deepEqual(
    Object.keys(without).filter((k) => k.startsWith("mocon.host.")),
    [],
  );
});

test("a flag that is false is copied, not omitted: otel-mapping.md 8.1 allows either, and this sink writes it", () => {
  // The document lets a sink leave out a false flag, so two conforming sinks differ on every span carrying
  // one. This is the choice here, and it is the one that lets a reader tell "the host said false" from
  // "the host said nothing".
  const line = crossing({}, { outcome: "output", output: { value: "v", truncated: false, redacted: false } });
  const span = attrs(spanOf(mapped(line).request));
  assert.equal(span["mocon.crossing.output.truncated"], false);
  assert.equal(span["mocon.crossing.output.redacted"], false);
});
