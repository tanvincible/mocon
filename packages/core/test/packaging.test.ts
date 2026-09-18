/**
 * What `npm publish` of this package would actually ship. `files` is the
 * whole contract, and `dist` is not in the repository: a manifest that
 * does not build before it packs produces a tarball holding package.json
 * and README.md and nothing else, which npm reports as a success and the
 * first `import` finds as ERR_MODULE_NOT_FOUND. Every rule here is one a
 * publisher cannot check by reading the tarball's size.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

interface Manifest {
  name: string;
  types?: string;
  exports: Record<string, string | Record<string, string>>;
  files: string[];
  scripts: Record<string, string>;
  publishConfig?: { access?: string };
}

const manifest = JSON.parse(readFileSync(packageDir + "package.json", "utf8")) as Manifest;

/** Every `./...` target the exports map names, at any depth. */
function exportTargets(): string[] {
  const out: string[] = [];
  for (const entry of Object.values(manifest.exports)) {
    if (typeof entry === "string") out.push(entry);
    else out.push(...Object.values(entry));
  }
  return [...new Set(out)];
}

/** The paths `npm pack` would put in the tarball, prepack included, as it publishes them. */
function packedPaths(): string[] {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir, encoding: "utf8" });
  assert.equal(run.status, 0, `npm pack failed: ${run.stderr}`);
  const json = run.stdout.slice(run.stdout.indexOf("["));
  const [packed] = JSON.parse(json) as Array<{ files: Array<{ path: string }> }>;
  return (packed as { files: Array<{ path: string }> }).files.map((f) => f.path);
}

test("npm publish ships the code: the tarball carries every entry point the exports map names", () => {
  const paths = new Set(packedPaths());
  for (const target of exportTargets()) {
    assert.ok(paths.has(target.replace(/^\.\//, "")), `${target} is named by exports and is not in the tarball`);
  }
  assert.ok(paths.has("package.json"), "a package with no manifest installs nothing");
  assert.ok(manifest.scripts["prepack"]?.includes("build") === true, "dist is not in the repository, so packing must build first");
  assert.equal(manifest.publishConfig?.access, "public", "a scoped package publishes restricted unless it says otherwise");
});

test("a TypeScript consumer resolves the package under every moduleResolution: types at the top level and package.json in the exports map", () => {
  assert.equal(manifest.types, "./dist/index.d.ts", "node10 reads types, not the exports map");
  assert.equal(manifest.exports["./package.json"], "./package.json", "tooling that reads a dependency's manifest resolves it through exports");
});

test("every source map the tarball ships resolves: the sources it names travel with it", () => {
  const paths = new Set(packedPaths());
  const missing: string[] = [];
  for (const path of paths) {
    if (!path.endsWith(".map")) continue;
    const map = JSON.parse(readFileSync(packageDir + path, "utf8")) as { sources: string[]; sourcesContent?: string[] };
    if (map.sourcesContent !== undefined) continue;
    for (const source of map.sources) {
      const resolved = posix.normalize(posix.join(posix.dirname(path), source));
      if (!paths.has(resolved)) missing.push(`${path} -> ${resolved}`);
    }
  }
  assert.deepEqual(missing, [], "a map whose sources are absent sends a stack trace and a Go-to-Definition to a path that does not exist");
});
