/**
 * Test support shared by the packages that drive an MCP server: a server
 * and a client on the two ends of an in-memory transport, the text of a
 * tool result, a poll, and the one complete execution record in a stream.
 */

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export type Rec = Record<string, any>;

export interface Paired {
  client: Client;
  close(): Promise<void>;
}

/** `server` and a fresh client on the two ends of a linked in-memory pair. */
export async function pair(
  server: { connect(transport: InMemoryTransport): Promise<void>; close(): Promise<void> },
  name = "test",
  sessionId?: string,
): Promise<Paired> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (sessionId !== undefined) serverTransport.sessionId = sessionId;
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The first text block of a tool result, or "". */
export function text(result: unknown): string {
  const first = (result as { content?: { type?: string; text?: string }[] }).content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** Polls until `predicate` holds. Throws after `ms`. */
export async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The one complete execution record among `records`. Fails unless there is exactly one. */
export function completeExecution(records: Rec[]): Rec {
  const done = records.filter((r) => r["kind"] === "execution" && r["end"] !== undefined);
  assert.equal(done.length, 1, "exactly one complete execution record");
  return done[0]!;
}
