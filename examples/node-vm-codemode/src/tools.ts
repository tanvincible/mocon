/**
 * Two fake tools with fictional data at acme.example. Each waits a little
 * before it answers, so concurrent calls overlap in the record, and each
 * answers with a fresh copy, so nothing a program does to an answer
 * reaches a later call or a later execution. `company_lookup` fails for
 * any other domain, which gives the driver's program a crossing that ends
 * in an error.
 */

import { setTimeout as sleep } from "node:timers/promises";

const COMPANY = Object.freeze({ domain: "acme.example", name: "Acme Example Co", industry: "Widgets", headcount: 42 });

const PEOPLE = Object.freeze(
  [
    { name: "Avery Sample", title: "Founder", domain: "acme.example" },
    { name: "Riley Fixture", title: "Head of Widgets", domain: "acme.example" },
    { name: "Sam Placeholder", title: "Engineer", domain: "acme.example" },
    { name: "Jules Stub", title: "Engineer", domain: "acme.example" },
    { name: "Kit Mockery", title: "Support", domain: "acme.example" },
  ].map((p) => Object.freeze(p)),
);

/** A tool call as the host dispatches it: a tool name and its arguments, a value or a rejection back. */
export const callTool = async (name: string, args: unknown): Promise<unknown> => {
  const input: Record<string, unknown> = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  switch (name) {
    case "company_lookup": {
      await sleep(60);
      if (input["domain"] !== COMPANY.domain) throw new Error(`company_lookup: no company at ${String(input["domain"])}`);
      return { ...COMPANY };
    }
    case "person_search": {
      const limit = input["limit"] ?? PEOPLE.length;
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) throw new RangeError("person_search: limit must be a non-negative integer");
      await sleep(90);
      return PEOPLE.filter((p) => p.domain === input["domain"])
        .slice(0, limit as number)
        .map((p) => ({ ...p }));
    }
    default:
      throw new Error(`no tool named ${name}`);
  }
};
