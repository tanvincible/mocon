/**
 * The capture primitive as its own entry point, for `@mocon/trace`. That package needs what the
 * encoder produces — a bounded JSON text plus the size and hash of the whole — without the Payload
 * envelope the record format wraps it in. It is a separate entry point rather than an addition to
 * the index so the envelope's own helpers stay private.
 */

export { DEFAULT_CAPS, DEFAULT_PREVIEW, Encoder, type Encoded } from "./payload.js";
