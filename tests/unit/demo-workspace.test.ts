import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { user } from "@/db/schema";
import { withUser } from "@/db/with-user";
import {
  consumeDemoQuota,
  deleteExpiredDemos,
  isDemoUser,
  prepareDemoWorkspace,
  visitorKey,
} from "@/server/demo/workspace";
import { budgetBlock, recordUsage } from "@/server/llm/usage";
import { createTestDb, createUser, ownerCount } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const keys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const req = (ip: string) =>
  new Request("http://x/api/demo", {
    method: "POST",
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  });

describe("visitor keys", () => {
  it("are stable for a visitor within a day, differ across visitors and days, and hold no IP", () => {
    const ip = ["203", "0", "113", "7"].join(".");
    const a = visitorKey(req(ip), "2026-10-03");
    expect(a).toBe(visitorKey(req(ip), "2026-10-03"));
    expect(a).not.toBe(visitorKey(req(ip), "2026-10-04"));
    expect(a).not.toBe(visitorKey(req(["203", "0", "113", "8"].join(".")), "2026-10-03"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(ip);
  });
});

describe("quota", () => {
  it("allows up to the limit per key per day", async () => {
    const key = "a".repeat(64);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await consumeDemoQuota(db, key, "workspaces", 5));
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(await consumeDemoQuota(db, key, "questions", 10)).toBe(true);
    expect(await consumeDemoQuota(db, "b".repeat(64), "workspaces", 5)).toBe(true);
  });
});

describe("demo workspaces", () => {
  it("are seeded like a real import and flagged as demo", async () => {
    await createUser(db, "demo1");
    await db.update(user).set({ isAnonymous: true }).where(eq(user.id, "demo1"));
    const r = await prepareDemoWorkspace(db, "demo1", keys);
    expect(r.transactions).toBe(885);
    expect(await isDemoUser(db, "demo1")).toBe(true);
    await createUser(db, "real");
    expect(await isDemoUser(db, "real")).toBe(false);
  });

  it("are deleted after 24 hours with all their rows, and their spend still counts", async () => {
    await withUser(db, "demo1", (tx) =>
      recordUsage(tx, "demo1", "ask", "claude-sonnet-5-5", {
        inputTokens: 0,
        outputTokens: 4_100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    // Not yet 24 hours old: kept.
    expect(await deleteExpiredDemos(db)).toBe(0);
    const later = new Date(Date.now() + 25 * 3600_000);
    expect(await deleteExpiredDemos(db, later)).toBe(1);
    expect(await ownerCount(db, "transactions")).toBe(0);
    expect(await ownerCount(db, "usage")).toBe(0);
    const [archived] = sqlRows<{ usd: string }>(
      await db.execute(sql`select sum(cost_usd)::text as usd from llm_spend_archive`),
    );
    expect(Number(archived!.usd)).toBeCloseTo(41, 5);
    // The global breaker ($40) still sees the deleted demo's spend this month.
    expect(await budgetBlock(db, "real", "ask")).toBe("global_budget");
    // Real accounts are never touched.
    expect(await isDemoUser(db, "real")).toBe(false);
    expect(await ownerCount(db, "user")).toBe(1);
  });
});
