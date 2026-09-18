/**
 * What the manifest promises a host. The peer range is the one thing in it
 * a host cannot work around: an install that fails on the range never gets
 * as far as running the code, so a range narrower than the code's real
 * requirement is a refusal for no reason.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const SDK = "@modelcontextprotocol/sdk";

const manifest = JSON.parse(readFileSync(packageDir + "package.json", "utf8")) as { peerDependencies: Record<string, string> };

/** The only range shape this package publishes: every 1.x from the floor. */
const PEER_RANGE = ">=1.12 <2";

test("the peer range admits every SDK version this package compiles against, not only the newest published one", () => {
  // 1.11 is where `RequestHandlerExtra` gained `_meta`, and 1.9 is where it became generic. Both are read
  // by src/context.ts, so they are the floor; everything above is admitted sight unseen, as a peer range does.
  assert.equal(manifest.peerDependencies[SDK], PEER_RANGE, "the floor is the oldest SDK whose types this source compiles against, not today's latest");
});

test("the SDK is a peer the installed version satisfies, so the suite runs on a version a host may also install", () => {
  const installed = (JSON.parse(readFileSync(`${packageDir}../../node_modules/${SDK}/package.json`, "utf8")) as { version: string }).version;
  const [major, minor] = installed.split(".").map(Number) as [number, number];
  assert.ok(major === 1 && minor >= 12, `the installed SDK ${installed} is outside the peer range ${PEER_RANGE}`);
});

test("the built module imports nothing from the SDK at runtime, which is what makes it a types-only peer", () => {
  const dist = `${packageDir}dist/`;
  const files = readdirSync(dist).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "build first: dist holds no JavaScript");
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const file of files) {
    const source = readFileSync(dist + file, "utf8");
    for (const [, target] of source.matchAll(specifier)) {
      assert.ok(target?.startsWith(SDK) !== true, `${file} imports ${target} at runtime, so the peer is not types-only`);
    }
  }
});
