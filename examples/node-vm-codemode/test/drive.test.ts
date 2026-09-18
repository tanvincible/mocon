/**
 * End to end, the way `npm run example` runs: the built driver starts the
 * built server, and the stream it leaves behind goes through the `mocon`
 * command as a child process.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertHostRules, cliEntry, completeExecution, crossingsOf, driveEntry, DRIVER_PROGRAM, packageDir } from "./helpers.js";

function run(entry: string, args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: packageDir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("the driver leaves a stream that mocon validate accepts and mocon view shows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-example-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stream = join(dir, "run.jsonl");
  writeFileSync(stream, "left over from an earlier run\n");

  const driven = run(driveEntry, [], { MOCON_FILE: stream });
  assert.equal(driven.status, 0, driven.stderr);
  assert.match(driven.stdout, /^result: \[\{"type":"text","text":"\{\\"company\\":\\"Acme Example Co\\"/);
  assert.ok(driven.stdout.includes(readFileSync(stream, "utf8").trimEnd()), "the driver prints the stream it read");

  const lines = readFileSync(stream, "utf8").split("\n").filter((l) => l !== "");
  const records = assertHostRules(lines);
  assert.ok(!lines.some((l) => l.includes("left over")), "each run starts the stream afresh");
  const done = completeExecution(records);
  assert.equal(done["end"]["disposition"], "completed");
  assert.equal(done["program"]["value"], DRIVER_PROGRAM, "the in-process tests exercise the program the driver sends");
  assert.deepEqual(
    crossingsOf(records).map((c) => [c["target"], c["end"]["outcome"]]),
    [
      ["company_lookup", "output"],
      ["person_search", "output"],
      ["company_lookup", "error"],
    ],
  );

  const validated = run(cliEntry, ["validate", stream]);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);

  const viewed = run(cliEntry, ["view", stream]);
  assert.equal(viewed.status, 0, viewed.stderr);
  for (const name of ["mocon/example-node-vm", "company_lookup", "person_search", "completed"]) assert.ok(viewed.stdout.includes(name), `view shows ${name}`);
});
