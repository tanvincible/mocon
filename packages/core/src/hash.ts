/**
 * The one SHA-256 in this repository. `program.hash` and every Payload
 * hash come from it, and so do the derived ids of `@mocon/otel`
 * (otel-mapping.md 4), which reach it through `@mocon/core/fold`.
 *
 * `crypto.hash` is one call into the platform, and is present from Node
 * 20.12; `createHash` is the fallback on an older 20.x, and costs an
 * object per digest.
 */

import * as nodeCrypto from "node:crypto";

const oneShot = (nodeCrypto as { hash?: (algorithm: string, data: string | Uint8Array, encoding: "hex") => string }).hash;

/** Lowercase hex SHA-256 of the UTF-8 bytes of a string, or of the bytes themselves. */
export const sha256: (data: string | Uint8Array) => string =
  typeof oneShot === "function" ? (data) => oneShot("sha256", data, "hex") : (data) => nodeCrypto.createHash("sha256").update(data).digest("hex");
