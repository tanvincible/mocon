/**
 * Declared dimensions to metrics, otel-mapping.md 14, and the provenance
 * they move: a declared key under both of provenance.md 4's gates is
 * host-observed, so it leaves `mocon.provenance.ext.p` and it, alone, may
 * become a metric point. A stream that declares nothing produces exactly
 * what it produced in 1.0, which the three OTLP fixtures already pin;
 * here it is the points that stay empty.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostLine } from "@mocon/core";
import { otlpSink } from "../src/index.js";
import { buildMetricsRequest, type ExportMetricsServiceRequest } from "../src/metrics.js";
import { attrs, convertStream, crossing, declared, execution, fakeFetch, mapped, readStreamLines, spanOf, streamNames, type Rec } from "./helpers.js";

/** A timestamp as the mapping writes it, for the millisecond precision every fixture uses. */
const N = (iso: string): string => (BigInt(Date.parse(iso)) * 1000000n).toString();
const s = (stringValue: string): { stringValue: string } => ({ stringValue });

/** A 1.1 declaration of `dimensions`, attesting `ext.declared` unless told otherwise. */
const declaring = (dimensions: Rec, attested: string[] = ["ext.declared"]) => declared(attested, { spec_version: "1.1", dimensions });

test("the worked declaration: credits spent become a delta sum and credits left a gauge, each with the unit the host declared", () => {
  const { points } = convertStream(readStreamLines("declared-dimensions"));
  const host = { key: "mocon.host", value: s("example/metered") };
  const crossingAttributes = (target: string, guard: string) => [
    host,
    { key: "mocon.crossing.target", value: s(target) },
    { key: "mocon.crossing.outcome", value: s("output") },
    // A declared `none` key with `card: "low"` that is host-observed: the per-target breakdown, and the whole of it.
    { key: "mocon.ext.metered.guard", value: s(guard) },
  ];

  assert.deepEqual(buildMetricsRequest(points), {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: s("example/metered") }] },
        scopeMetrics: [
          {
            scope: { name: "mocon/example/metered" },
            metrics: [
              {
                name: "mocon.ext.metered.credits_used",
                unit: "{credit}",
                sum: {
                  dataPoints: [
                    { attributes: crossingAttributes("records_search", "allow"), startTimeUnixNano: N("2026-09-18T08:00:00.140Z"), timeUnixNano: N("2026-09-18T08:00:00.612Z"), asInt: "12" },
                    { attributes: crossingAttributes("records_get", "review"), startTimeUnixNano: N("2026-09-18T08:00:00.618Z"), timeUnixNano: N("2026-09-18T08:00:01.004Z"), asInt: "24" },
                  ],
                  aggregationTemporality: 1,
                  isMonotonic: false,
                },
              },
              {
                name: "mocon.ext.metered.credits_remaining",
                unit: "{credit}",
                gauge: {
                  dataPoints: [
                    {
                      // `metered.model` is declared but not observed, and `metered.sandbox_id` is observed but not low-cardinality: neither keys the metric.
                      attributes: [host, { key: "mocon.execution.disposition", value: s("completed") }],
                      startTimeUnixNano: N("2026-09-18T08:00:00.000Z"),
                      timeUnixNano: N("2026-09-18T08:00:01.060Z"),
                      asInt: "9964",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
});

test("the same stream's spans: a declared observed key drops out of mocon.provenance.ext.p and still carries its value", () => {
  const lines = readStreamLines("declared-dimensions");
  const a = attrs(spanOf(mapped(lines[3] as string, JSON.parse(lines[0] as string) as HostLine).request));
  assert.equal(a["mocon.ext.metered.credits_remaining"], "9964");
  assert.equal(a["mocon.ext.metered.model"], "planner-2");
  assert.deepEqual(a["mocon.provenance.ext.p"], ["metered.model"], "the one declared key the host did not claim to observe");
});

test("a stream that declares no dimensions produces no metric points at all", () => {
  const declaring: string[] = [];
  for (const name of streamNames()) {
    const lines = readStreamLines(name);
    const { points } = convertStream(lines);
    if (lines.some((l) => (JSON.parse(l) as Rec)["dimensions"] !== undefined)) declaring.push(name);
    else assert.deepEqual(points, [], `${name}: nothing to export`);
  }
  assert.deepEqual(declaring, ["declared-dimensions", "dimension-mismatch", "undeclared-ext-key"]);
  for (const name of declaring) assert.ok(convertStream(readStreamLines(name)).points.length > 0, `${name}: its declared numbers do export`);
});

test("a mismatch and a null export nothing, and both still ride the span", () => {
  const lines = readStreamLines("dimension-mismatch");
  const { points } = convertStream(lines);
  assert.deepEqual(
    points.map((p) => [p.name, p.unit, p.agg, p.value]),
    [
      ["mocon.ext.runner.memory", "KiBy", "last", { asInt: "9840" }],
      ["mocon.ext.runner.wall_time_ms", "ms", "sum", { asInt: "4009" }],
    ],
    "only the record whose values are finite numbers",
  );
  const declaration = JSON.parse(lines[0] as string) as HostLine;
  const second = attrs(spanOf(mapped(lines[2] as string, declaration).request));
  assert.equal(second["mocon.ext.runner.memory"], "null", "a null is no value, not zero, and is still displayed");
  assert.equal(second["mocon.ext.runner.wall_time_ms"], "3.812", "the mismatch is displayed verbatim and never parsed");
});

test("both gates or no metric: observed alone and ext.declared alone each export nothing", () => {
  const dimensions = { "v.spend": { agg: "sum", unit: "USD", observed: true } };
  const line = execution({ ext: { "v.spend": 3 } });

  const neither = mapped(line, declaring({ "v.spend": { agg: "sum", unit: "USD" } }));
  assert.deepEqual(neither.points, [], "attested, but the entry does not claim the host observed it");
  assert.deepEqual(attrs(spanOf(neither.request))["mocon.provenance.ext.p"], ["v.spend"]);

  const unattested = mapped(line, declaring(dimensions, ["crossing.target"]));
  assert.deepEqual(unattested.points, [], "observed, but the host attested nothing");
  assert.deepEqual(attrs(spanOf(unattested.request))["mocon.provenance.ext.p"], ["v.spend"]);

  const both = mapped(line, declaring(dimensions));
  assert.equal(both.points.length, 1);
  assert.ok(!("mocon.provenance.ext.p" in attrs(spanOf(both.request))), "host-observed, so nothing is left to label P");
});

test("point attributes are the closed list: mocon.host, the record's own two, and the low-cardinality observed keys, never an id or a session", () => {
  const line = crossing({
    ext: {
      "v.spend": 1.5,
      "v.guard": "allow",
      "v.model": "planner-2",
      "v.sandbox_id": "sbx-1",
      "v.region": "eu-west",
    },
    context: { session: "s-1" },
  });
  const { points } = mapped(
    line,
    declaring({
      "v.spend": { agg: "sum", unit: "{credit}", observed: true },
      "v.guard": { agg: "none", card: "low", observed: true },
      "v.model": { agg: "none", card: "low" },
      "v.sandbox_id": { agg: "none", observed: true },
      "v.region": { agg: "none", card: "high", observed: true },
    }),
  );
  assert.equal(points.length, 1);
  assert.deepEqual(points[0]?.value, { asDouble: 1.5 }, "a number that is not an integer is a double");
  assert.deepEqual(
    points[0]?.attributes.map((kv) => kv.key),
    ["mocon.host", "mocon.crossing.target", "mocon.crossing.outcome", "mocon.ext.v.guard"],
    "no unobserved key, no card-absent key, no card-high key, no id, no session",
  );
});

test("an absent unit reads as 1, and name, unit and agg together key the instrument", () => {
  const { points } = mapped(execution({ ext: { "v.rows": 7 } }), declaring({ "v.rows": { agg: "sum", observed: true } }));
  const point = points[0];
  assert.ok(point !== undefined);
  assert.equal(point.unit, "1");
  const doc = buildMetricsRequest([point, { ...point, unit: "{row}" }]);
  assert.equal(doc.resourceMetrics[0]?.scopeMetrics[0]?.metrics.length, 2, "one name in two units is two instruments, never one mislabelled series");
});

test("a crossing's point takes the record's own window, falling back to receipt exactly where 7.3 does", () => {
  const now = Date.parse("2026-09-16T16:05:00.000Z");
  const dimensions = declaring({ "v.spend": { agg: "sum", observed: true } });
  const ext = { "v.spend": 2 };
  const receipt = (BigInt(now) * 1000000n).toString();

  const both = mapped(crossing({ ext }), dimensions, { now: () => now });
  assert.deepEqual([both.points[0]?.startTimeUnixNano, both.points[0]?.timeUnixNano], [N("2026-09-16T10:00:00.118Z"), N("2026-09-16T10:00:00.402Z")]);

  const startOnly = mapped(crossing({ ext }, { time: undefined }), dimensions, { now: () => now });
  assert.deepEqual([startOnly.points[0]?.startTimeUnixNano, startOnly.points[0]?.timeUnixNano], [N("2026-09-16T10:00:00.118Z"), receipt], "no end time: the point closes at receipt");

  const none = mapped(crossing({ ext, start: undefined }, { time: undefined }), dimensions, { now: () => now });
  assert.deepEqual([none.points[0]?.startTimeUnixNano, none.points[0]?.timeUnixNano], [receipt, receipt]);
});

test("the sink is trace-only until a metrics endpoint is configured, and the traces it posts are the same either way", async () => {
  const lines = readStreamLines("declared-dimensions");

  const traceOnly = fakeFetch();
  const one = otlpSink({ url: "https://collector.example/v1/traces", fetch: traceOnly.fetch });
  await one.write(lines);
  await one.flush();
  assert.equal(traceOnly.calls.length, 1, "one POST, and no metrics anywhere");

  const both = fakeFetch();
  const two = otlpSink({ url: "https://collector.example/v1/traces", metricsUrl: "https://collector.example/v1/metrics", fetch: both.fetch });
  await two.write(lines);
  await two.flush();
  assert.deepEqual(
    both.calls.map((c) => c.url),
    ["https://collector.example/v1/traces", "https://collector.example/v1/metrics"],
  );
  assert.equal(both.calls[0]?.init.body, traceOnly.calls[0]?.init.body, "the spans do not change because metrics are configured");

  const document = JSON.parse(both.calls[1]?.init.body as string) as ExportMetricsServiceRequest;
  assert.deepEqual(document, buildMetricsRequest(convertStream(lines).points));
  const sum = document.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.sum;
  assert.deepEqual([sum?.aggregationTemporality, sum?.isMonotonic], [1, false], "delta and not monotonic, so the sink needs no accumulator");
});

test("a batch with a metrics endpoint but nothing to export posts traces only", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", metricsUrl: "https://collector.example/v1/metrics", fetch: f.fetch });
  await sink.write([JSON.stringify(execution({ ext: { "v.rows": 7 } }))]);
  await sink.flush();
  assert.deepEqual(
    f.calls.map((c) => c.url),
    ["https://collector.example/v1/traces"],
  );
});
