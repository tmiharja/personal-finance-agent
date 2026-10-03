import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  categoriseRows,
  needsReview,
  resolveDeterministic,
  type CategoriseRow,
  type UserRule,
} from "@/server/categorise/categorise";
import { describeRow } from "@/server/finance/ledger";
import { mockLlm } from "@/server/llm/mock";
import type { Llm } from "@/server/llm/types";
import { loadFixtureStatements } from "@/server/demo/seed";

const CATS = [
  "Dining",
  "Groceries",
  "Transport",
  "Shopping",
  "Health",
  "Travel",
  "Education",
  "Subscriptions",
  "Home",
  "Entertainment",
  "Uncategorised",
];
const ALLOWED = new Set([...CATS, "Transfers", "Fees & Charges", "Cashback & Rewards"]);

const row = (raw: string, over: Partial<CategoriseRow> = {}): CategoriseRow => ({
  ...describeRow(raw),
  kind: "charge",
  amountCents: 1000,
  fx: null,
  ...over,
});

const ctx = (llm: Llm | null, over = {}) => ({
  rules: [] as UserRule[],
  history: new Map(),
  categories: CATS,
  llm,
  model: "claude-haiku-4-5",
  ...over,
});

describe("deterministic resolution", () => {
  it("uses the row kind for system rows", () => {
    expect(
      resolveDeterministic(row("AUTOPAY", { kind: "card_payment" }), [], ALLOWED),
    ).toMatchObject({
      categoryName: "Transfers",
      source: "system",
    });
    expect(
      resolveDeterministic(row("ANNUAL FEE", { kind: "fee" }), [], ALLOWED)?.categoryName,
    ).toBe("Fees & Charges");
  });

  it("applies the user's rules before the map, lowest priority number first", () => {
    const rules: UserRule[] = [
      { match: "descriptor_contains", pattern: "grab", categoryName: "Shopping", priority: 200 },
      { match: "merchant", pattern: "Grab", categoryName: "Dining", priority: 100 },
    ];
    expect(resolveDeterministic(row("GRAB* A-ABC123"), rules, ALLOWED)).toMatchObject({
      categoryName: "Dining",
      source: "rule",
      confidence: 1,
    });
  });

  it("uses the curated map, then generic keywords", () => {
    expect(
      resolveDeterministic(row("FAIRPRICE XTRA - SAMPLE SINGAPORE"), [], ALLOWED),
    ).toMatchObject({
      categoryName: "Groceries",
      source: "map",
    });
    expect(
      resolveDeterministic(row("SAMPLE FAMILY CLINIC SINGAPORE"), [], ALLOWED)?.categoryName,
    ).toBe("Health");
    expect(resolveDeterministic(row("GRABFOOD SINGAPORE"), [], ALLOWED)?.categoryName).toBe(
      "Dining",
    );
    expect(resolveDeterministic(row("ZZ UNKNOWN TRADING"), [], ALLOWED)).toBeNull();
  });

  it("ignores a rule whose category is hidden or gone", () => {
    const rules: UserRule[] = [
      { match: "merchant", pattern: "Grab", categoryName: "Old", priority: 1 },
    ];
    expect(resolveDeterministic(row("GRAB* A-1"), rules, ALLOWED)?.source).toBe("map");
  });
});

describe("classifier", () => {
  it("sends each unknown merchant once, masked, and applies the answer to every row", async () => {
    const classify = vi.fn(mockLlm.classify);
    const llm: Llm = { ...mockLlm, classify: classify as Llm["classify"] };
    const rows = [
      row("SAMPLE MARKET JAKARTA IDN", { fx: { currency: "IDR" } }),
      row("SAMPLE MARKET JAKARTA IDN", { fx: { currency: "IDR" } }),
      row("ALEX TAN TRADING"),
      row("STARBUCKS@SAMPLE MALL SINGAPORE"),
    ];
    const res = await categoriseRows(rows, ctx(llm, { pii: { names: ["ALEX TAN"] } }));
    expect(classify).toHaveBeenCalledTimes(1);
    const req = classify.mock.calls[0]![0];
    expect(req.items).toHaveLength(2);
    expect(req.prompt).not.toContain("ALEX TAN");
    expect(req.prompt).toContain("<merchants>");
    expect(res.results[0]).toMatchObject({ categoryName: "Travel", source: "llm" });
    expect(res.results[1]).toEqual(res.results[0]);
    expect(res.results[3]).toMatchObject({ categoryName: "Dining", source: "map" });
    expect(res.llmCalls).toBe(1);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });

  it("reuses an earlier decision for the same merchant instead of calling the model", async () => {
    const classify = vi.fn(mockLlm.classify);
    const history = new Map([
      ["zz unknown trading", { categoryName: "Shopping", confidence: 0.9 }],
    ]);
    const res = await categoriseRows(
      [row("ZZ UNKNOWN TRADING")],
      ctx({ ...mockLlm, classify: classify as Llm["classify"] }, { history }),
    );
    expect(classify).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({
      categoryName: "Shopping",
      source: "llm",
      confidence: 0.9,
    });
  });

  it(`batches at most ${BATCH_SIZE} merchants per call`, async () => {
    const classify = vi.fn(mockLlm.classify);
    const rows = Array.from({ length: 120 }, (_, i) =>
      row(`ZZ SHOP ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`),
    );
    await categoriseRows(rows, ctx({ ...mockLlm, classify: classify as Llm["classify"] }));
    expect(classify).toHaveBeenCalledTimes(3);
    expect(classify.mock.calls.map((c) => c[0].items.length)).toEqual([50, 50, 20]);
  });

  it("drops answers outside the allowed list or for unknown indexes", async () => {
    const llm: Llm = {
      ...mockLlm,
      classify: async (req) => ({
        output: { results: [{ i: 7, category: "Dining", confidence: 0.9 }] } as never,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: req.model,
        stopReason: "end_turn",
      }),
    };
    const res = await categoriseRows([row("ZZ UNKNOWN")], ctx(llm));
    expect(res.results[0]).toMatchObject({ categoryName: "Uncategorised", source: null });
  });

  it("falls back to Uncategorised with a code when the model fails or isn't configured", async () => {
    const failing: Llm = { ...mockLlm, classify: async () => Promise.reject(new Error("boom")) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await categoriseRows([row("ZZ UNKNOWN")], ctx(failing));
    errorSpy.mockRestore();
    expect(res.results[0]!.categoryName).toBe("Uncategorised");
    expect(res.warnings).toEqual(["categoriser_failed"]);
    const none = await categoriseRows([row("ZZ UNKNOWN")], ctx(null));
    expect(none.warnings).toEqual(["categoriser_unavailable"]);
  });

  it("flags low-confidence and uncategorised rows for review", () => {
    expect(needsReview({ categoryName: "Dining", source: "llm", confidence: 0.69 })).toBe(true);
    expect(needsReview({ categoryName: "Dining", source: "llm", confidence: 0.7 })).toBe(false);
    expect(needsReview({ categoryName: "Dining", source: "map", confidence: 1 })).toBe(false);
    expect(needsReview({ categoryName: "Uncategorised", source: null, confidence: null })).toBe(
      true,
    );
  });
});

describe("golden set: synthetic statements", () => {
  it("rules + map are right whenever they decide, and decide most rows", () => {
    const rows = loadFixtureStatements().flatMap((s) => s.cards.flatMap((c) => c.rows));
    let decided = 0;
    let correct = 0;
    for (const r of rows) {
      const c = resolveDeterministic(
        { ...describeRow(r.rawDescriptor), kind: r.kind, amountCents: r.amountCents, fx: r.fx },
        [],
        ALLOWED,
      );
      if (!c) continue;
      decided++;
      if (c.categoryName === r.expectedCategory) correct++;
    }
    console.info(
      `categories: deterministic ${decided}/${rows.length}, correct ${correct}/${decided}`,
    );
    expect(correct / decided).toBeGreaterThanOrEqual(0.99);
    expect(decided / rows.length).toBeGreaterThanOrEqual(0.85);
  });
});
