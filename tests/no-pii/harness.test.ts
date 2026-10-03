import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import { seedDemoWorkspace } from "@/server/demo/seed";
import {
  ensureDefaultCategories,
  insertCardStatement,
  upsertCardAccount,
} from "@/server/finance/ledger";
import { logError, logEvent } from "@/server/log";
import { PiiViolation } from "@/server/pii/firewall";
import { dumpDatabase, FORBIDDEN, leaks } from "../helpers/no-pii";
import { createTestDb, createUser } from "../helpers/test-db";

/**
 * The no-PII guarantee (PRD §7.1a), end to end through the real write path:
 * hostile, fully synthetic inputs go in; then the whole database and every log
 * line are searched for the identifiers. Phase 1 extends the same harness to
 * parser output, LLM request bodies and API responses.
 */

let db: AppDb;
let close: () => Promise<void>;
const keys: MasterKeys = { current: { id: 1, key: randomBytes(32) } };
const logs: string[] = [];
const persona = { names: ["ALEX TAN", "JORDAN TAN"] };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // Better Auth stores the login email; use an example.com address so the dump check stays meaningful.
  await createUser(db, "alex", "login@example.com");
  for (const level of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    );
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

const hostileRows = [
  {
    rawDescriptor: "AUTOPAY AC#1234567890123456",
    kind: "card_payment" as const,
    amountCents: -1000,
  },
  { rawDescriptor: "PAYNOW TO JORDAN TAN", kind: "charge" as const, amountCents: 2500 },
  { rawDescriptor: "REFUND alex.tan@example.com", kind: "refund" as const, amountCents: -500 },
  { rawDescriptor: "BUS/MRT 911568828 SINGAPORE", kind: "charge" as const, amountCents: 182 },
  { rawDescriptor: "SAMPLE STORE 4111 1111 1111 1111", kind: "charge" as const, amountCents: 999 },
];

describe("no PII reaches storage or logs", () => {
  it("sanitises hostile descriptors on the way in", async () => {
    const result = await withUser(db, "alex", async (tx) => {
      const crypto = await getUserCrypto(tx, "alex", keys);
      const categories = await ensureDefaultCategories(tx, "alex");
      const accountId = await upsertCardAccount(tx, "alex", {
        bank: "DBS",
        productName: "DBS SAMPLE VISA SIGNATURE",
      });
      return insertCardStatement(
        tx,
        crypto,
        {
          bank: "DBS",
          accountId,
          productName: "DBS SAMPLE VISA SIGNATURE",
          ordinal: 1,
          statementDate: "2026-03-14",
          dueDate: "2026-04-08",
          minimumPaymentCents: 5000,
          previousBalanceCents: 1000,
          totalCents: 1000 + hostileRows.reduce((s, r) => s + r.amountCents, 0),
          rows: hostileRows.map((r) => ({
            ...r,
            txnDate: "2026-03-01",
            postDate: null,
            fx: null,
            refNo: "00000000000000000000001",
          })),
        },
        categories,
        persona,
      );
    });
    expect(result).toMatchObject({ inserted: 5, reconciled: true });
    logEvent("import.committed", { rows: result.inserted });
  });

  it("refuses a card product name that carries an identifier", async () => {
    await expect(
      withUser(db, "alex", (tx) =>
        upsertCardAccount(tx, "alex", { bank: "UOB", productName: "CARD 4111 1111 1111 1111" }),
      ),
    ).rejects.toBeInstanceOf(PiiViolation);
  });

  it("seeds the synthetic demo data through the same path", async () => {
    const r = await seedDemoWorkspace(db, "alex", keys);
    expect(r.transactions).toBe(885);
    logEvent("demo.seeded", { ...r });
    logError("import", new Error(`failed on ${FORBIDDEN[0]} for ALEX TAN`));
  });

  it("the database dump contains none of the identifiers", async () => {
    const dump = await dumpDatabase(db);
    expect(dump.length).toBeGreaterThan(10_000);
    expect(leaks(dump), "indexes into FORBIDDEN").toEqual([]);
    // Raw descriptors are encrypted; only normalised merchant names ("Grab",
    // "SimplyGo / Transit") are plaintext. Descriptor-only text never shows up.
    expect(dump).toContain('"merchant_name":"grab"');
    expect(dump).not.toContain("grab* a-");
    expect(dump).not.toContain("bus/mrt");
  });

  it("the logs contain none of the identifiers", () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(leaks(logs.join("\n"))).toEqual([]);
  });
});

describe("no PII reaches the categoriser", () => {
  it("masks names, card numbers and contact details in every request body", async () => {
    const { categoriseRows } = await import("@/server/categorise/categorise");
    const { describeRow } = await import("@/server/finance/ledger");
    const { mockLlm } = await import("@/server/llm/mock");
    const bodies: string[] = [];
    const classify: typeof mockLlm.classify = (req) => {
      bodies.push(req.system, req.prompt, JSON.stringify(req.items));
      return mockLlm.classify(req);
    };
    const llm = { ...mockLlm, classify };
    const rows = hostileRows.map((r) => ({
      ...describeRow(r.rawDescriptor, persona),
      kind: r.kind,
      amountCents: r.amountCents,
      fx: null,
    }));
    const res = await categoriseRows(rows, {
      rules: [],
      history: new Map(),
      categories: ["Shopping", "Dining", "Uncategorised"],
      llm,
      model: "claude-haiku-4-5",
      pii: persona,
    });
    expect(bodies.length).toBeGreaterThan(0);
    expect(leaks(bodies.join("\n"), persona.names)).toEqual([]);
    expect(res.warnings).toEqual([]);
  });
});
