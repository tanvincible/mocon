/**
 * The one SHA-256 in this repository: `program.hash`, every Payload hash, and the derived ids of `@mocon/otel`
 * (otel-mapping.md 4). `crypto.hash` is present from Node 20.12; `createHash` is the fallback on an older 20.x.
 */

import * as nodeCrypto from "node:crypto";

const oneShot = (nodeCrypto as { hash?: (algorithm: string, data: string | Uint8Array, encoding: "hex") => string }).hash;

/** Lowercase hex SHA-256 of the UTF-8 bytes of a string, or of the bytes themselves. */
export const sha256: (data: string | Uint8Array) => string =
  typeof oneShot === "function" ? (data) => oneShot("sha256", data, "hex") : (data) => nodeCrypto.createHash("sha256").update(data).digest("hex");
