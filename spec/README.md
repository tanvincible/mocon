# mocon specification

- `otel-code-mode.md` — semantic conventions for code-mode execution in OpenTelemetry. Two spans, a
  capability declaration saying what a host can and cannot observe, per-field provenance separating
  what the host saw from what the program claimed, and two closed vocabularies. Appendix A carries
  the invariants the whole design rests on, derived by profiling nineteen implementations.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC
2119.

Everything here is Development and may change. A JSON Lines record format previously lived beside
this document and was retired; section 14 records what the move gave up and git has the rest.
