/**
 * The metric points of one write batch as one OTLP/JSON
 * `ExportMetricsServiceRequest` (otel-mapping.md 14).
 *
 * Nothing accumulates: a `sum` is DELTA, so each point is the value its own
 * record carried and the backend does the adding. That is what lets a sink
 * required to be stateless (core.md 4 rule 7) export a metric at all.
 */

import type { KeyValue, MetricPoint } from "./map.js";

export interface NumberDataPoint {
  attributes: KeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}

/** `aggregationTemporality` 1 is DELTA. A `last` dimension is a level, which is a gauge. */
export interface Metric {
  name: string;
  unit: string;
  sum?: { dataPoints: NumberDataPoint[]; aggregationTemporality: 1; isMonotonic: false };
  gauge?: { dataPoints: NumberDataPoint[] };
}

export interface ScopeMetrics {
  scope: { name: string };
  metrics: Metric[];
}

export interface ResourceMetrics {
  resource: { attributes: KeyValue[] };
  scopeMetrics: ScopeMetrics[];
}

export interface ExportMetricsServiceRequest {
  resourceMetrics: ResourceMetrics[];
}

const DELTA = 1;

/** Groups points by host string, then by instrument, the same grouping `buildRequest` gives spans (otel-mapping.md 11). */
export function buildMetricsRequest(points: readonly MetricPoint[]): ExportMetricsServiceRequest {
  const byHost = new Map<string, Map<string, Metric>>();
  for (const p of points) {
    let instruments = byHost.get(p.host);
    if (instruments === undefined) byHost.set(p.host, (instruments = new Map()));
    // The unit and the aggregation key the instrument alongside the name, so two declarations that disagree produce two instruments rather than one mislabelled series.
    const key = p.name + "\0" + p.unit + "\0" + p.agg;
    let metric = instruments.get(key);
    if (metric === undefined) {
      metric =
        p.agg === "sum"
          ? { name: p.name, unit: p.unit, sum: { dataPoints: [], aggregationTemporality: DELTA, isMonotonic: false } }
          : { name: p.name, unit: p.unit, gauge: { dataPoints: [] } };
      instruments.set(key, metric);
    }
    const dataPoints = metric.sum?.dataPoints ?? (metric.gauge as { dataPoints: NumberDataPoint[] }).dataPoints;
    dataPoints.push({ attributes: p.attributes, startTimeUnixNano: p.startTimeUnixNano, timeUnixNano: p.timeUnixNano, ...p.value });
  }
  const resourceMetrics: ResourceMetrics[] = [];
  for (const [host, instruments] of byHost) {
    resourceMetrics.push({
      resource: { attributes: [{ key: "service.name", value: { stringValue: host } }] },
      scopeMetrics: [{ scope: { name: "mocon/" + host }, metrics: [...instruments.values()] }],
    });
  }
  return { resourceMetrics };
}
