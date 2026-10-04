import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aiStatementSchema,
  extractWithAi,
  redactForAi,
  statementLines,
  toParseResult,
  type AiStatement,
} from "@/server/ingest/fallback";
import { parseStatementFile, ParseError } from "@/server/ingest/parsers";
import { mockLlm } from "@/server/llm/mock";
import type { Llm } from "@/server/llm/types";
import { scanForPii } from "@/server/pii/firewall";

const DIR = join(process.cwd(), "evals", "fixtures", "synthetic", "sample-bank");
const files = readdirSync(DIR).filter((f) => f.endsWith(".pdf"));
const load = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
const expected = (f: string) =>
  JSON.parse(readFileSync(join(DIR, f.replace(/\.pdf$/, ".expected.json")), "utf8")) as {
    statementDate: string;
    cards: {
      productName: string;
      previousBalanceCents: number;
      totalCents: number;
      rows: { txnDate: string; amountCents: number; rawDescriptor: string; kind: string }[];
    }[];
  };

describe("AI fallback extractor (IMP-5)", () => {
  it("the Sample Bank layout is one no deterministic parser reads", async () => {
    expect(files).toHaveLength(3);
    for (const f of files)
      await expect(parseStatementFile(load(f))).rejects.toMatchObject({
        code: "unsupported_format",
      });
  });

  it("removes the name and address block and masks numbers before anything is sent", async () => {
    const raw = await statementLines(load(files[1]!));
    const { lines, names } = redactForAi(raw);
    expect(names).toEqual(["ALEX TAN"]);
    const text = lines.join("\n");
    expect(text).not.toMatch(/ALEX|EXAMPLE AVENUE|SAMPLE RESIDENCES|000000|5105/);
    expect(text).toContain("[CARD]");
    expect(lines.every((l) => scanForPii(l, { names }).length === 0)).toBe(true);
    // The statement content itself survives.
    expect(text).toMatch(/Statement Date\s+20 Aug 2026/);
    expect(text).toMatch(/SAMPLE MART SINGAPORE/);
  });

  it.each(files)(
    "%s: extracted rows and balances match the fixture, and it reconciles",
    async (f) => {
      let sent = "";
      const spy: Llm = {
        ...mockLlm,
        extract: (req) => {
          sent = req.prompt;
          return mockLlm.extract(req);
        },
      };
      const { result } = await extractWithAi(spy, "claude-haiku-4-5", load(f));
      expect(sent).not.toMatch(/ALEX|EXAMPLE AVENUE|5105 1051/);
      const want = expected(f);
      const card = result.statement.cards[0]!;
      expect(result.statement).toMatchObject({
        bank: "OTHER",
        kind: "card",
        parserVersion: "ai-fallback@1",
        statementDate: want.statementDate,
      });
      expect(result.statement.warnings).toContain("ai_extracted");
      expect(card).toMatchObject({
        productName: want.cards[0]!.productName,
        previousBalanceCents: want.cards[0]!.previousBalanceCents,
        totalCents: want.cards[0]!.totalCents,
        reconciled: true,
      });
      expect(card.rows.map((r) => [r.txnDate, r.amountCents, r.rawDescriptor, r.kind])).toEqual(
        want.cards[0]!.rows.map((r) => [r.txnDate, r.amountCents, r.rawDescriptor, r.kind]),
      );
      expect(result.names).toEqual(["ALEX TAN"]);
      // The card number (in memory only) identifies the card, as a parser's would.
      expect(result.accountRefs).toHaveLength(1);
      expect(result.accountRefs?.[0]).toMatch(/^\d{16}$/);
    },
  );

  const base: AiStatement = {
    is_statement: true,
    bank: "OCBC",
    kind: "card",
    statement_date: "2026-08-20",
    due_date: null,
    minimum_payment: null,
    accounts: [
      {
        product_name: "SAMPLE CARD",
        opening_balance: "100.00",
        opening_balance_is_credit: false,
        closing_balance: "150.00",
        closing_balance_is_credit: false,
        rows: [
          {
            date: "2026-08-01",
            post_date: null,
            description: "SHOP",
            amount: "60.00",
            direction: "debit",
            type: "purchase",
          },
          {
            date: "2026-08-02",
            post_date: null,
            description: "SHOP REFUND",
            amount: "10.00",
            direction: "credit",
            type: "refund",
          },
        ],
      },
    ],
  };

  it("the server, not the model, signs amounts and decides whether it reconciles", () => {
    expect(aiStatementSchema.parse(base)).toBeTruthy();
    const ok = toParseResult(base, []);
    expect(ok.statement.cards[0]).toMatchObject({ reconciled: true, previousBalanceCents: 10000 });
    expect(ok.statement.cards[0]!.rows.map((r) => r.amountCents)).toEqual([6000, -1000]);
    const off = toParseResult(
      { ...base, accounts: [{ ...base.accounts[0]!, closing_balance: "149.00" }] },
      [],
    );
    expect(off.statement.cards[0]!.reconciled).toBe(false);
    expect(off.statement.warnings).toEqual(["ai_extracted", "reconciliation_failed"]);
    // A bank account's balances are money held: stored negative, like the parsers.
    const deposit = toParseResult(
      {
        ...base,
        kind: "deposit",
        accounts: [
          {
            ...base.accounts[0]!,
            opening_balance: "1000.00",
            closing_balance: "950.00",
          },
        ],
      },
      [],
    );
    expect(deposit.statement.cards[0]).toMatchObject({
      previousBalanceCents: -100000,
      totalCents: -95000,
      reconciled: true,
    });
  });

  it("refuses output it can't trust", () => {
    const bad = (patch: Partial<AiStatement["accounts"][number]["rows"][number]>) =>
      toParseResult(
        {
          ...base,
          accounts: [{ ...base.accounts[0]!, rows: [{ ...base.accounts[0]!.rows[0]!, ...patch }] }],
        },
        [],
      );
    expect(() => bad({ amount: "12,3.4.5" })).toThrow(ParseError);
    expect(() => bad({ date: "20/08/2026" })).toThrow(ParseError);
    // An impossible date is refused, not rolled into the next month.
    expect(() => bad({ date: "2026-02-30" })).toThrow(ParseError);
    expect(() => bad({ post_date: "2026-13-01" })).toThrow(ParseError);
    // A name the firewall knows is refused in a product name.
    expect(() =>
      toParseResult(
        { ...base, accounts: [{ ...base.accounts[0]!, product_name: "ALEX TAN CARD" }] },
        ["ALEX TAN"],
      ),
    ).toThrow(ParseError);
    expect(() => toParseResult({ ...base, is_statement: false, accounts: [] }, [])).toThrow(
      expect.objectContaining({ code: "not_a_statement" }),
    );
  });

  it("never keeps a number in a product name", () => {
    const product = (name: string) =>
      toParseResult({ ...base, accounts: [{ ...base.accounts[0]!, product_name: name }] }, [])
        .statement.cards[0]!.productName;
    expect(product("CARD 4111 1111 1111 1111")).toBe("CARD");
    expect(product("Sample Savings Account ending 1234")).toBe("SAMPLE SAVINGS ACCOUNT");
    expect(product("REWARDS CARD XXXX-XXXX-XXXX-1234")).toBe("REWARDS CARD");
    expect(product("SAMPLE ACCOUNT NO. 123-45678-9")).toBe("SAMPLE ACCOUNT");
    expect(product("SAMPLE ACCOUNT #0123")).toBe("SAMPLE ACCOUNT");
    expect(product("SAMPLE 365 CARD")).toBe("SAMPLE 365 CARD"); // a product number stays
  });

  it("bank statements: card bills aren't spending, and people's names are dropped", () => {
    const row = base.accounts[0]!.rows[0]!;
    const r = toParseResult(
      {
        ...base,
        kind: "deposit",
        accounts: [
          {
            ...base.accounts[0]!,
            opening_balance: "1000.00",
            closing_balance: "250.00",
            rows: [
              {
                ...row,
                description: "BILL PAYMENT DBS CARD CENTRE",
                amount: "500.00",
                type: "card_bill",
              },
              { ...row, description: "PAYNOW TO JORDAN LIM", amount: "100.00", type: "transfer" },
              {
                ...row,
                description: "FAST PAYMENT SAMPLE RENOVATION PTE LTD",
                amount: "150.00",
                type: "payment",
              },
            ],
          },
        ],
      },
      [],
    );
    const rows = r.statement.cards[0]!.rows;
    expect(rows.map((x) => x.kind)).toEqual(["card_payment", "charge", "charge"]);
    expect(rows[0]!.rawDescriptor).toBe("CARD PAYMENT DBS CARD");
    expect(rows[1]!.rawDescriptor).toBe("PAYNOW TRANSFER OUT");
    expect(rows[2]!.rawDescriptor).toContain("SAMPLE RENOVATION PTE LTD");
    expect(JSON.stringify(r)).not.toContain("JORDAN");
  });

  it("drops the holder's name even with no address under it, and transfer payees", () => {
    const { lines, names } = redactForAi([
      "Sample Bank",
      "Mr Alex Tan",
      "Statement of Account   Statement Date 20 Aug 2026",
      "01 Aug  PAYNOW TO JORDAN LIM  100.00",
      "02 Aug  FAST PAYMENT  50.00",
      "  Jordan Lim",
      "03 Aug  NETS QR  12.30",
      "  SAMPLE MART SINGAPORE",
      "04 Aug  PAYNOW FROM SAMPLE PROPERTY PTE LTD  80.00",
    ]);
    const text = lines.join("\n");
    expect(names).toEqual(["Alex Tan"]);
    expect(text).not.toMatch(/Alex|Tan\b|JORDAN|Jordan/);
    expect(text).toContain("PAYNOW TO [NAME]  100.00");
    expect(text).toContain("SAMPLE MART SINGAPORE"); // a purchase's merchant stays
    expect(text).toContain("SAMPLE PROPERTY PTE LTD"); // so does a business payee
    expect(text).toContain("Statement Date 20 Aug 2026");
  });

  it("records what the call cost even when its answer is refused", async () => {
    const used: number[] = [];
    const truncated: Llm = {
      ...mockLlm,
      extract: async (req) => ({ ...(await mockLlm.extract(req)), stopReason: "max_tokens" }),
    };
    await expect(
      extractWithAi(truncated, "claude-haiku-4-5", load(files[0]!), {
        onUsage: async (u) => void used.push(u.outputTokens),
      }),
    ).rejects.toMatchObject({ code: "too_long_for_ai" });
    expect(used).toHaveLength(1);
    expect(used[0]).toBeGreaterThan(0);
  });
});
