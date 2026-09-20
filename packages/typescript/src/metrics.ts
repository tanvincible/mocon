/**
 * Metrics, emitted through the OpenTelemetry metrics API.
 *
 * Section 9 forbids a metric keyed by, or measured from, a program-determined value: a metric point
 * has no provenance channel, so a claim exported as a metric silently becomes a fact. The document
 * says a host cannot enforce that, which is true of a span-metrics connector running downstream and
 * false of the host's own instruments. Here the rule is enforced rather than stated: the target is a
 * dimension only when the host attested it, and it is dropped otherwise.
 *
 * Nothing here needs configuring. If the application registered no meter provider, the API returns a
 * no-op meter and every recording costs a function call.
 */

import { type Attributes, type Histogram, type Meter, metrics } from "@opentelemetry/api";
import type { Attestation } from "./declare.js";

const NAME = "@mocon/otel";
const VERSION = "0.1.0";

export class Meters {
  private readonly execution: Histogram;
  private readonly crossing: Histogram;
  /** The target names a dimension only where the host observed it, per section 9. */
  private readonly targetIsFact: boolean;

  constructor(attested: readonly Attestation[], meter?: Meter) {
    const m = meter ?? metrics.getMeter(NAME, VERSION);
    this.targetIsFact = attested.includes("crossing.target");
    this.execution = m.createHistogram("code_mode.execution.duration", {
      description: "How long one dispatch of one program took.",
      unit: "s",
    });
    this.crossing = m.createHistogram("code_mode.crossing.duration", {
      description: "How long one call from a program across the host boundary took.",
      unit: "s",
    });
  }

  /**
   * Always sound on every host: the disposition and the error type on an execution are host-observed
   * whatever the host attests, so neither can carry a program's claim into a metric.
   */
  recordExecution(seconds: number, disposition: string, errorType: string | undefined): void {
    const attributes: Attributes = { "code_mode.execution.disposition": disposition };
    if (errorType !== undefined) attributes["error.type"] = errorType;
    this.execution.record(seconds, attributes);
  }

  /**
   * The outcome and the error type follow the target, so on a host that did not attest it they are
   * the program's words and all three are dropped. What survives is a duration distribution with no
   * dimensions, which is worth little and is not a lie.
   */
  recordCrossing(seconds: number, target: string, outcome: string, errorType: string | undefined): void {
    const attributes: Attributes = {};
    if (this.targetIsFact) {
      attributes["gen_ai.tool.name"] = target;
      attributes["code_mode.crossing.outcome"] = outcome;
      if (errorType !== undefined) attributes["error.type"] = errorType;
    }
    this.crossing.record(seconds, attributes);
  }
}
