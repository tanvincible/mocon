/**
 * The spec's line schema through ajv, compiled once for every package's
 * tests. `spec/` is language-neutral — schemas and check.py — so the
 * TypeScript side of reading it lives here instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { unixNanos } from "../core/src/time.js";

export const specDir = fileURLToPath(new URL("../../spec/", import.meta.url));

// ajv is CommonJS: the default import is `module.exports`, which is the class and also carries itself as `default`.
const Ajv2020 = Ajv2020Module.default ?? (Ajv2020Module as unknown as typeof Ajv2020Module.default);
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", { validate: (s: string) => unixNanos(s) !== undefined });
for (const file of ["line.json", "host.json", "execution.json", "crossing.json", "payload.json", "error.json", "links.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(`${specDir}schema/${file}`, "utf8")) as object);
}
const compiled = ajv.getSchema("https://github.com/tanvincible/mocon/spec/1.0/schema/line.json");
if (compiled === undefined) throw new Error("line.json did not load");

/** `spec/schema/line.json`. After it returns false, `.errors` says why. */
export const lineSchema = compiled;
