import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { runAsk, type AskEvent } from "@/server/agent/ask";
import { checkNumbers, collectNumbers, extractNumbers, fallbackAnswer } from "@/server/agent/guard";
import { resolvePeriod, todaySgt } from "@/server/agent/period";
import { runTool, TOOLS } from "@/server/agent/tools";
import { loadFixtureStatements, seedDemoWorkspace } from "@/server/demo/seed";
import { dataSpan, spendTotals } from "@/server/finance/spend";
import { sql } from "drizzle-orm";
import { sqlRows } from "@/db/rows";
import { mockLlm } from "@/server/llm/mock";
import { runDetectors } from "@/server/detect/run";
import { budgetBlock } from "@/server/llm/usage";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const TODAY = "2026-10-03";
const keys = { current: { id: 1, key: randomBytes(32) } };
// What the demo statements cover (resolve_period tests); the tool tests use the real span.
const coverage = { from: "2025-08-15", to: "2026-08-14" };
let realCoverage: { from: string; to: string } | null = null;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "alex");
  await createUser(db, "other");
  await seedDemoWorkspace(db, "alex", keys);
  realCoverage = await withUser(db, "alex", (tx) => dataSpan(tx));
  await runDetectors(db, "alex", keys, TODAY);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

describe("resolve_period (ASK-5)", () => {
  const r = (e: string, today = TODAY) => resolvePeriod(e, today, coverage);
  it("resolves quarters: this year's if it has ended, else the last complete one", () => {
    expect(r("Q3")).toMatchObject({
      from: "2026-07-01",
      to: "2026-09-30",
      label: "Q3 2026 (1 Jul – 30 Sep)",
    });
    expect(r("Q4")).toMatchObject({ from: "2025-10-01", to: "2025-12-31" });
    expect(r("q3", "2026-09-15")).toMatchObject({ from: "2025-07-01" });
    expect(r("Q1 2026")).toMatchObject({ from: "2026-01-01", to: "2026-03-31", partial: false });
  });
  it("resolves months, years and relative ranges", () => {
    expect(r("last month")).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
      label: "September 2026",
    });
    expect(r("March")).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(r("november")).toMatchObject({ from: "2025-11-01" });
    expect(r("Feb 2028")).toMatchObject({ to: "2028-02-29" });
    expect(r("last 3 months")).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(r("2025")).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
    expect(r("2026-03-31 to 2026-01-01")).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
  });
  it("flags periods the statements only partly cover, and refuses nonsense", () => {
    const q3 = r("Q3");
    expect(q3).toMatchObject({ partial: true });
    expect("note" in q3 && q3.note).toContain("14 Aug 2026");
    expect(r("next tuesday")).toMatchObject({ error: "unrecognised_period" });
    expect(r("2026-02-30 to 2026-03-01")).toMatchObject({ error: "unrecognised_period" });
  });
  it("uses Singapore time for today", () => {
    expect(todaySgt(new Date("2026-10-02T17:30:00Z"))).toBe("2026-10-03");
  });
});

describe("numbers guard (ASK-3)", () => {
  const allowed = collectNumbers({
    spent_sgd: "1234.56",
    transactions: 47,
    change_pct: "12.5",
    from: "2026-07-01",
  });
  it("accepts figures quoted from tool results, in common formats", () => {
    expect(
      checkNumbers(
        "You spent S$1,234.56 across 47 transactions, up 12.5% since 1 Jul 2026.",
        allowed,
      ),
    ).toEqual({ ok: true });
    expect(checkNumbers("About S$1,235 (12%).", allowed)).toEqual({
      ok: false,
      unsupported: ["12"],
    });
    expect(checkNumbers("Roughly S$1.2k.", allowed)).toEqual({ ok: true });
  });
  it("rejects figures no tool produced", () => {
    expect(checkNumbers("You spent S$1,300.00 over 50 transactions.", allowed)).toEqual({
      ok: false,
      unsupported: ["S$1,300.00", "50"],
    });
  });
  it("extracts money, percentages and k-suffixes", () => {
    expect(extractNumbers("S$12,345.60, 7.5% and 3k").map((n) => n.value)).toEqual([
      12345.6, 7.5, 3000,
    ]);
  });
  it("renders a deterministic fallback from the last data result", () => {
    expect(
      fallbackAnswer([
        { name: "resolve_period", result: { label: "x" } },
        {
          name: "spend_summary",
          result: {
            from: "2026-03-01",
            to: "2026-03-31",
            category: "Dining",
            merchant: "all",
            spent_sgd: "1234.50",
            transactions: 9,
          },
        },
      ]),
    ).toBe("Spend on Dining from 2026-03-01 to 2026-03-31: S$1,234.50 across 9 transactions.");
  });
});

describe("tools (ASK-2)", () => {
  const ctx = (tx: Parameters<Parameters<typeof withUser>[2]>[0]) => ({
    tx,
    userId: "alex",
    today: TODAY,
    coverage: realCoverage,
    categories: ["Dining", "Groceries", "Transport", "Uncategorised"],
  });

  it("declares strict schemas in a fixed order, without the user id", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "resolve_period",
      "spend_summary",
      "spend_by_category",
      "compare_periods",
      "top_merchants",
      "monthly_spend",
      "find_transactions",
      "list_categories",
      "get_subscriptions",
      "get_bills",
      "get_alerts",
      "propose_recategorise",
      "propose_rule",
      "propose_mark_transfer",
      "propose_tag",
      "propose_budget",
      "propose_alert_decision",
      "propose_ignore_subscription",
      "propose_bill",
    ]);
    expect(TOOLS.every((t) => t.strict && t.input_schema.additionalProperties === false)).toBe(
      true,
    );
    expect(JSON.stringify(TOOLS)).not.toMatch(/user_?id/i);
  });

  it("spend_summary matches the shared spend definition and links to its rows", async () => {
    const out = await withUser(db, "alex", (tx) =>
      runTool(ctx(tx), "spend_summary", {
        from: "2026-03-01",
        to: "2026-03-31",
        category: "dining",
        merchant: null,
      }),
    );
    const truth = await withUser(db, "alex", (tx) =>
      spendTotals(tx, { from: "2026-03-01", to: "2026-03-31" }, { category: "Dining" }),
    );
    expect(out.result).toMatchObject({
      category: "Dining",
      spent_sgd: (truth.spentCents / 100).toFixed(2),
      transactions: truth.count,
    });
    expect(out.view).toEqual({
      href: "/app/transactions?from=2026-03-01&to=2026-03-31&category=Dining&spend=1",
      count: truth.count,
    });
  });

  it("spend_summary reports income and leaves out transfers between your own accounts", async () => {
    const out = await withUser(db, "alex", (tx) =>
      runTool(ctx(tx), "spend_summary", {
        from: "2026-03-01",
        to: "2026-03-31",
        category: null,
        merchant: null,
      }),
    );
    const truth = await withUser(db, "alex", (tx) =>
      spendTotals(tx, { from: "2026-03-01", to: "2026-03-31" }),
    );
    expect(out.result).toMatchObject({
      spent_sgd: (truth.spentCents / 100).toFixed(2),
      income_sgd: (truth.incomeCents / 100).toFixed(2),
      own_account_transfers_excluded: 2,
    });
    expect(truth.incomeCents).toBeGreaterThanOrEqual(680000);
    expect(out.excluded).toMatchObject({ transfers: 2 });
  });

  it("compare_periods does the arithmetic so the model doesn't", async () => {
    const out = await withUser(db, "alex", (tx) =>
      runTool(ctx(tx), "compare_periods", {
        first_from: "2026-01-01",
        first_to: "2026-01-31",
        second_from: "2026-02-01",
        second_to: "2026-02-28",
        category: null,
        merchant: null,
      }),
    );
    const a = Number((out.result.first as { spent_sgd: string }).spent_sgd);
    const b = Number((out.result.second as { spent_sgd: string }).spent_sgd);
    expect(Number(out.result.second_minus_first_sgd)).toBeCloseTo(b - a, 2);
    expect(out.figure?.points).toHaveLength(2);
  });

  it("returns errors the model can act on, never exceptions", async () => {
    const run = (name: string, input: unknown) =>
      withUser(db, "alex", (tx) => runTool(ctx(tx), name, input));
    expect(
      (
        await run("spend_summary", {
          from: "2026-03-01",
          to: "2026-03-31",
          category: "Yachts",
          merchant: null,
        })
      ).result,
    ).toMatchObject({ error: "unknown_category" });
    expect(
      (
        await run("spend_summary", {
          from: "2026-03-31",
          to: "2026-03-01",
          category: null,
          merchant: null,
        })
      ).result,
    ).toMatchObject({ error: "invalid_input" });
    expect((await run("drop_table", {})).result).toMatchObject({ error: "unknown_tool" });
    // "View N transactions" counts every row the link opens, not just the top merchants'.
    const top = await run("top_merchants", {
      from: "2026-03-01",
      to: "2026-03-31",
      category: null,
      limit: 2,
    });
    const all = await run("spend_summary", {
      from: "2026-03-01",
      to: "2026-03-31",
      category: null,
      merchant: null,
    });
    expect(top.view).toEqual(all.view);
    expect(
      (
        await run("find_transactions", {
          from: null,
          to: null,
          category: null,
          merchant: "netfl",
          sort: "largest",
          limit: 50,
        })
      ).result,
    ).toMatchObject({ error: "invalid_input" });
    const fuzzy = await run("find_transactions", {
      from: null,
      to: null,
      category: null,
      merchant: "netfl",
      sort: "largest",
      limit: 3,
    });
    expect(fuzzy.result).toMatchObject({ total_matching: 12, shown: 3 });
  });

  it("reads subscriptions, bills and alerts from the detectors", async () => {
    const run = (name: string, input: unknown) =>
      withUser(db, "alex", (tx) => runTool(ctx(tx), name, input));
    const subs = await run("get_subscriptions", {});
    expect(subs.result).toMatchObject({ running: expect.any(Number) });
    expect((subs.result.subscriptions as { merchant: string }[]).map((x) => x.merchant)).toContain(
      "Netflix",
    );
    expect(subs.result.subscriptions).toContainEqual(
      expect.objectContaining({
        merchant: "Netflix",
        previous_price_sgd: "17.98",
        price_sgd: "19.98",
      }),
    );
    expect(subs.view).toMatchObject({ href: "/app/subscriptions", label: "Open Subscriptions" });
    const bills = await run("get_bills", {});
    expect((bills.result.card_payments as unknown[]).length).toBe(4);
    const alerts = await run("get_alerts", { include_closed: false });
    expect((alerts.result.alerts as { type: string }[]).map((a) => a.type)).toContain(
      "duplicate_charge",
    );
  });

  it("propose tools create a pending proposal as the agent, and change nothing", async () => {
    const out = await withUser(db, "alex", (tx) =>
      runTool(ctx(tx), "propose_recategorise", {
        merchant: "grab",
        category: "dining",
        from: "2026-03-01",
        to: "2026-03-31",
      }),
    );
    expect(out.result).toMatchObject({
      proposed: true,
      title: expect.stringMatching(/to Dining$/),
    });
    expect(out.proposal?.preview.lines[0]).toBe(
      "Transactions from Grab (2026-03-01 to 2026-03-31).",
    );
    const travel = await withUser(db, "alex", (tx) =>
      spendTotals(
        tx,
        { from: "2026-03-01", to: "2026-03-31" },
        { category: "Dining", merchant: "Grab" },
      ),
    );
    expect(travel.count).toBe(0);
    // A refusal comes back as a code the model can explain, and the turn goes on.
    const refused = await withUser(db, "alex", (tx) =>
      runTool(ctx(tx), "propose_budget", { category: "Uncategorised", monthly_amount_sgd: 10 }),
    );
    expect(refused).toEqual({ result: { error: "invalid_category" } });
  });

  it("reads only the signed-in user's rows", async () => {
    const out = await withUser(db, "other", (tx) =>
      runTool(ctx(tx), "spend_summary", {
        from: "2025-01-01",
        to: "2026-12-31",
        category: null,
        merchant: null,
      }),
    );
    expect(out.result).toMatchObject({ spent_sgd: "0.00", transactions: 0 });
  });
});

describe("the Ask loop (offline mock model)", () => {
  async function ask(question: string, userId = "alex") {
    const events: AskEvent[] = [];
    await runAsk({ db, userId, question, history: [], emit: (e) => events.push(e), today: TODAY });
    const text = events.reduce((s, e) => (e.t === "reset" ? "" : e.t === "text" ? s + e.d : s), "");
    return {
      events,
      text,
      done: events.find((e) => e.t === "done"),
      error: events.find((e) => e.t === "error"),
    };
  }

  it("answers with tool figures, the period label, a link and what was excluded", async () => {
    const { text, done, events } = await ask("What did I spend on dining in Q1 2026?");
    const rows = loadFixtureStatements().flatMap((s) => s.cards.flatMap((c) => c.rows));
    const truth = rows
      .filter(
        (r) =>
          r.txnDate >= "2026-01-01" &&
          r.txnDate <= "2026-03-31" &&
          r.expectedCategory === "Dining" &&
          ["charge", "fee", "refund"].includes(r.kind),
      )
      .reduce((s, r) => s + r.amountCents, 0);
    expect(text).toContain(
      `S$${(truth / 100).toLocaleString("en-SG", { minimumFractionDigits: 2 })}`,
    );
    expect(text).toContain("Q1 2026 (1 Jan – 31 Mar)");
    expect(events.filter((e) => e.t === "status").map((e) => (e as { tool: string }).tool)).toEqual(
      ["resolve_period", "spend_summary"],
    );
    expect(done).toMatchObject({ guard: "pass", period: "Q1 2026 (1 Jan – 31 Mar)" });
    expect((done as { view: { href: string } }).view.href).toContain("category=Dining");
  });

  it("retries once when the answer cites a figure no tool returned", async () => {
    const { text, done } = await ask("MOCK_BAD_NUMBER how much in March 2026?");
    expect(text).not.toContain("9,999.99");
    expect(done).toMatchObject({ guard: "retried" });
  });

  it("answers subscription questions from the detectors", async () => {
    const { text, done } = await ask("What do my subscriptions cost each month?");
    expect(text).toMatch(/running subscriptions cost S\$[\d,]+\.\d\d a month/);
    expect(done).toMatchObject({ guard: "pass", view: { href: "/app/subscriptions" } });
  });

  it("proposes a change it was asked for, and never applies it (ACT-10)", async () => {
    const budgets = () =>
      withUser(db, "alex", async (tx) =>
        sqlRows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from budgets`)),
      );
    const before = await budgets();
    const { text, done } = await ask("Set a budget of S$450 a month for Dining");
    expect(text).toMatch(/suggested it: Budget S\$450\.00 a month for Dining/);
    expect(done).toMatchObject({
      guard: "pass",
      proposals: [{ preview: { title: "Budget S$450.00 a month for Dining", affected: 1 } }],
    });
    expect(await budgets()).toEqual(before);
    const id = done!.t === "done" ? done!.proposals![0]!.id : "";
    const [p] = await withUser(db, "alex", async (tx) =>
      sqlRows<{ status: string; proposer: string }>(
        await tx.execute(sql`select status, proposer from proposed_actions where id = ${id}`),
      ),
    );
    expect(p).toEqual({ status: "pending", proposer: "agent" });
  });

  it("explains a proposal the engine refuses", async () => {
    const { text, done } = await ask("Move Grab transactions to Nonsense");
    expect(text).toMatch(/couldn't suggest that change \(unknown category\)/);
    expect(done).toMatchObject({ proposals: [] });
  });

  it("declines advice without calling tools", async () => {
    const { events, done } = await ask("Should I buy stocks with my cashback?");
    expect(events.some((e) => e.t === "status")).toBe(false);
    expect(done).toMatchObject({ guard: "pass" });
  });

  it("records one usage row per answered question, which the daily limit counts", async () => {
    const asked = sqlRows<{ n: number; model: string }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(
          sql`select count(*)::int as n, min(model) as model from usage where route = 'ask'`,
        ),
      ),
    )[0]!;
    expect(asked).toEqual({ n: 6, model: "claude-sonnet-5-5" });
    expect(await budgetBlock(db, "alex", "ask", 6)).toBe("daily_limit");
    const { error } = await (async () => {
      const events: AskEvent[] = [];
      await runAsk({
        db,
        userId: "alex",
        question: "x",
        history: [],
        emit: (e) => events.push(e),
        today: TODAY,
      });
      return { error: events.find((e) => e.t === "error") };
    })();
    // The configured limit (60) isn't reached by 6 questions.
    expect(error).toBeUndefined();
  });

  it("records the usage of a question that fails, so limits still count it", async () => {
    const { mockTurn } = await import("@/server/llm/mock-agent");
    // A model that never stops calling tools: the loop hits its step limit.
    const looping = {
      ...mockLlm,
      turn: async (params: Parameters<typeof mockLlm.turn>[0], onText: (d: string) => void) => {
        const first = await mockTurn({ ...params, messages: params.messages.slice(0, 1) }, onText);
        return {
          ...first,
          content: first.content.map((b) => ({ ...b, id: `toolu_${Math.random()}` })),
        };
      },
    };
    const spy = vi
      .spyOn(await import("@/server/llm/client"), "getLlm")
      .mockResolvedValue(looping as never);
    const count = async () =>
      sqlRows<{ n: number }>(
        await withUser(db, "other", (tx) =>
          tx.execute(sql`select count(*)::int as n from usage where route = 'ask'`),
        ),
      )[0]!.n;
    const before = await count();
    const { error } = await ask("What did I spend in March 2026?", "other");
    spy.mockRestore();
    expect(error).toEqual({ t: "error", code: "too_many_steps" });
    expect(await count()).toBe(before + 1);
  });

  it("is unavailable without a model", async () => {
    const spy = vi.spyOn(await import("@/server/llm/client"), "getLlm").mockResolvedValue(null);
    const { error } = await ask("Anything?", "other");
    spy.mockRestore();
    expect(error).toEqual({ t: "error", code: "ask_unavailable" });
    expect(mockLlm.mock).toBe(true);
  });
});
