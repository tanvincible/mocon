/**
 * Proves the one thing this config exists for: a target the host observed is counted, and a target
 * the program merely claimed is not.
 *
 *   npm run build
 *   docker run -d --name mocon-col -p 4318:4318 -v "$PWD/collector:/cfg" \
 *     otel/opentelemetry-collector-contrib:latest --config=/cfg/codemode.yaml
 *   node collector/check.mjs
 *
 * Then read the collector's log with `verbosity: detailed`. `company_search` appears in both the
 * traces and the metrics; `refund_customer` appears only in the traces.
 */

import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { codeMode } from "../packages/trace/dist/index.js";

const provider = new BasicTracerProvider();
provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" })));
const tracer = provider.getTracer("e2e");

// A host that observes its own call boundary. Its targets are facts.
const observed = codeMode({ tracer, capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input", "crossing.output"] } });
observed.execution.run({ program: "p", tool: "execute", id: "obs-1" }, (e) => {
  e.instrument((n) => 1)("company_search");
});

// A host that builds its crossings from what the program printed. Its targets are claims.
const claimed = codeMode({ tracer, capabilities: { observes_crossings: "some", unmediated_egress: true, crossing_edge: "invocation" } });
claimed.execution.run({ program: "p", tool: "execute", id: "claim-1" }, (e) => {
  e.instrument((n) => 1)("refund_customer");
});

await provider.forceFlush();
console.log("emitted: one observed crossing (company_search), one claimed crossing (refund_customer)");
