/**
 * Every TypeScript block in the README type-checks against the source as
 * written. Each block is its own module. The names the prose introduces as
 * the host's own (a sandbox, a client, a store) are declared ahead of a
 * block that uses them and does not declare them itself, and so is `m`,
 * the instance the first block builds.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

const PLACEHOLDERS: Record<string, string> = {
  m: 'declare const m: import("@mocon/core").Mocon;',
  crmClient: 'declare const crmClient: import("@modelcontextprotocol/sdk/client/index.js").Client;',
  runInSandbox:
    "declare function runInSandbox(code: string, bridge: { callTool: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown> }): Promise<unknown>;",
  rawCallTool: "declare function rawCallTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown>;",
  rpc: "declare const rpc: { callTool(call: Record<string, unknown>): Promise<unknown> };",
  far: 'declare const far: import("@mocon/core").Mocon;',
  runTool: "declare function runTool(name: string, args: unknown): Promise<unknown>;",
  runInContainer: "declare function runInContainer(code: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;",
  store: "declare const store: { get(key: string): Promise<string>; set(key: string, value: string): Promise<void> };",
};

function blocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1]!);
}

function declares(code: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function|class|interface|type)\\s+${name}\\b|^import\\b[^;]*\\b${name}\\b`, "m").test(code);
}

test("every TypeScript block in the README type-checks against the source", { timeout: 60_000 }, () => {
  const sources = blocks(readFileSync(new URL("README.md", new URL("../", import.meta.url)), "utf8"));
  assert.ok(sources.length >= 6, `found ${sources.length} blocks`);
  const files = new Map<string, string>();
  sources.forEach((code, i) => {
    const prelude = Object.entries(PLACEHOLDERS)
      .filter(([name]) => new RegExp(`\\b${name}\\b`).test(code) && !declares(code, name))
      .map(([, declaration]) => declaration);
    files.set(`${packageDir}test/readme-block-${i + 1}.ts`, [...prelude, code, "export {};"].join("\n"));
  });

  const config = ts.getParsedCommandLineOfConfigFile(`${packageDir}test/tsconfig.json`, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  assert.ok(config !== undefined);
  const options: ts.CompilerOptions = { ...config.options, noEmit: true, baseUrl: packageDir, paths: { "@mocon/adapter-mcp": ["src/index.ts"] } };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => files.has(name) || fileExists.call(host, name);
  host.readFile = (name) => files.get(name) ?? readFile.call(host, name);
  host.getSourceFile = (name, language, ...rest) => {
    const text = files.get(name);
    return text === undefined ? getSourceFile.call(host, name, language, ...rest) : ts.createSourceFile(name, text, language);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const problems = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file === undefined || files.has(d.file.fileName))
    .map((d) => {
      const where = d.file === undefined || d.start === undefined ? "" : `${d.file.fileName.slice(packageDir.length)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `;
      return where + ts.flattenDiagnosticMessageText(d.messageText, "\n");
    });
  assert.deepEqual(problems, []);
});
