import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { user } from "@/db/schema";
import { getAdminStats, isAdmin } from "@/server/admin/stats";
import { seedDemoWorkspace } from "@/server/demo/seed";
import { runEvals } from "@/server/evals/run";
import { reconcileOutcome } from "@/server/ingest/stats";
import type { ParsedStatement } from "@/server/ingest/parsers";
import { mockLlm } from "@/server/llm/mock";
import { leaks } from "../helpers/no-pii";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const keys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "owner", "owner@example.com");
  await createUser(db, "demo");
  await db.update(user).set({ isAnonymous: true }).where(eq(user.id, "demo"));
  await seedDemoWorkspace(db, "demo", keys);
  await db.execute(sql`insert into parse_stats (day, bank, method, outcome, n) values
    (current_date, 'DBS', 'parser', 'reconciled', 7),
    (current_date, 'unknown', 'parser', 'unsupported_format', 2),
    (current_date, 'OTHER', 'ai', 'reconciled', 1)`);
  await db.execute(sql`insert into usage (user_id, route, model, input_tokens, output_tokens, cost_usd)
    values ('owner', 'extract', 'claude-haiku-4-5', 1000, 500, 0.0035)`);
});
afterAll(() => close());

describe("admin (OPS-3)", () => {
  it("only listed, signed-in, non-demo emails are the owner", () => {
    const list = "Owner@Example.com, second@example.com";
    expect(isAdmin({ email: "owner@example.com", isDemo: false }, list)).toBe(true);
    expect(isAdmin({ email: "someone@example.com", isDemo: false }, list)).toBe(false);
    expect(isAdmin({ email: "owner@example.com", isDemo: true }, list)).toBe(false);
    expect(isAdmin({ email: "owner@example.com", isDemo: false }, undefined)).toBe(false);
  });

  it("counts and costs only: demos are left out, and no one's data appears", async () => {
    const s = await getAdminStats(db);
    expect(s.users).toEqual({ total: 1, last30: 1, demos: 1 });
    expect(s.imports).toEqual([]); // the demo's statements aren't real imports
    expect(s.reconciliation).toEqual({ reconciled: 0, unreconciled: 0, unchecked: 0 });
    expect(s.parsing).toContainEqual({ method: "parser", outcome: "unsupported_format", n: 2 });
    expect(s.cost.byRoute).toEqual([{ route: "extract", usd: 0.0035, calls: 1 }]);
    const blob = JSON.stringify(s);
    expect(leaks(blob)).toEqual([]);
    expect(blob).not.toMatch(/owner@example\.com|Grab|Shopee/);
  });
});

describe("parse outcomes", () => {
  it("a statement whose card totals don't match its printed total isn't reconciled", () => {
    const card = {
      productName: "CARD",
      ordinal: 1,
      previousBalanceCents: 0,
      totalCents: 0,
      rows: [],
    };
    const st = (totalsMatch: boolean | null, reconciled: boolean | null) =>
      ({
        kind: "card",
        totalsMatch,
        cards: [{ ...card, reconciled }],
      }) as unknown as ParsedStatement;
    expect(reconcileOutcome(st(true, true))).toBe("reconciled");
    expect(reconcileOutcome(st(false, true))).toBe("unreconciled");
    expect(reconcileOutcome(st(true, false))).toBe("unreconciled");
    expect(reconcileOutcome(st(null, null))).toBe("no_balance");
  });
});

describe("eval scoreboard", () => {
  it("evals/results.json is current: every suite passes, as committed", async () => {
    await createUser(db, "eval");
    const now = await runEvals({ db, keys, llm: mockLlm, model: "claude-haiku-4-5" });
    const committed = JSON.parse(readFileSync("evals/results.json", "utf8")) as typeof now;
    expect(now.suites.every((s) => s.ok)).toBe(true);
    // Re-run `npm run eval` and commit the file when a measure changes.
    expect({ ai: committed.ai, suites: committed.suites }).toEqual(now);
  });
});
