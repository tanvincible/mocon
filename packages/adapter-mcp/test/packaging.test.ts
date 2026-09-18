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

interface Manifest {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(packageDir + "package.json", "utf8")) as Manifest;

/** Whether `version` satisfies a range of the form `>=MAJOR.MINOR <MAJOR`, which is the only form this manifest uses. */
function satisfies(version: string, range: string): boolean {
  const parts = range.split(" ");
  assert.equal(parts.length, 2, `this test reads only ">=x.y <z" ranges, not ${range}`);
  const [floor, ceiling] = parts as [string, string];
  const key = (v: string): number[] => v.split(".").map(Number);
  const cmp = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  return cmp(key(version), key(floor.slice(">=".length))) >= 0 && cmp(key(version), key(ceiling.slice("<".length))) < 0;
}

test("the peer range admits every SDK version this package compiles against, not only the newest published one", () => {
  const range = manifest.peerDependencies[SDK];
  assert.equal(range, ">=1.12 <2", "the floor is the oldest SDK whose types this source compiles against, not today's latest");
  // 1.11 is where `RequestHandlerExtra` gained `_meta`, and 1.9 is where it became generic. Both are read
  // by src/context.ts, so they are the floor; everything above is admitted sight unseen, as a peer range does.
  for (const version of ["1.12.0", "1.17.0", "1.30.0", "1.99.7"]) assert.ok(satisfies(version, range), `${version} must install`);
  for (const version of ["1.10.0", "2.0.0", "0.9.0"]) assert.ok(!satisfies(version, range), `${version} must not install`);
});

test("the SDK is a peer the installed version satisfies, so the suite runs on a version a host may also install", () => {
  const installed = (JSON.parse(readFileSync(`${packageDir}../../node_modules/${SDK}/package.json`, "utf8")) as { version: string }).version;
  assert.ok(satisfies(installed, manifest.peerDependencies[SDK] as string), `the installed SDK ${installed} is outside the peer range`);
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
