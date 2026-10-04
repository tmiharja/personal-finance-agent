import type { z } from "zod";
import { ZERO_USAGE } from "./pricing";
import { parseFullDate } from "@/server/ingest/parsers/common";
import type { ClassifyItem, ClassifyResponse, ExtractRequest, Llm } from "./types";
import { mockTurn } from "./mock-agent";

/**
 * LLM_MOCK=1: deterministic offline stand-in for tests and e2e. The classifier
 * guesses from a few keywords with honest confidences, so imports show a mix of
 * confident and low-confidence categories. Ask is scripted in mock-agent.ts.
 */

const GUESSES: readonly [RegExp, string, number][] = [
  [/COURSE|ONLINE|ACADEMY/i, "Education", 0.82],
  [/MARKET|BAZAAR/i, "Shopping", 0.55],
  [/HOUSE|SQUARE/i, "Dining", 0.6],
];

function guess(item: ClassifyItem, categories: readonly string[]): [string, number] {
  if (item.currency && item.currency !== "USD" && categories.includes("Travel")) {
    return ["Travel", 0.78];
  }
  for (const [re, category, confidence] of GUESSES) {
    if (re.test(`${item.merchant} ${item.example}`) && categories.includes(category)) {
      return [category, confidence];
    }
  }
  return ["Uncategorised", 0.2];
}

export const mockLlm: Llm = {
  mock: true,
  async classify<S extends z.ZodType>(req: {
    items: ClassifyItem[];
    categories: readonly string[];
    model: string;
    schema: S;
  }): Promise<ClassifyResponse<z.output<S>>> {
    const output = {
      results: req.items.map((item) => {
        const [category, confidence] = guess(item, req.categories);
        return { i: item.i, category, confidence };
      }),
    };
    return {
      output: req.schema.parse(output) as z.output<S>,
      usage: {
        ...ZERO_USAGE,
        inputTokens: 40 * req.items.length,
        outputTokens: 12 * req.items.length,
      },
      model: req.model,
      stopReason: "end_turn",
    };
  },
  async extract<S extends z.ZodType>(
    req: ExtractRequest<S>,
  ): Promise<ClassifyResponse<z.output<S>>> {
    return {
      output: req.schema.parse(mockExtract(req.lines)) as z.output<S>,
      usage: {
        ...ZERO_USAGE,
        inputTokens: 8 * req.lines.length,
        outputTokens: 30 * req.lines.length,
      },
      model: req.model,
      stopReason: "end_turn",
    };
  },
  turn: mockTurn,
};

/**
 * The offline extractor: reads the synthetic "Sample Bank" layout (evals/fixtures/
 * synthetic/sample-bank) line by line, like a model would, so the fallback path
 * runs end to end without an API key. Anything else is "not a statement".
 */
function mockExtract(lines: readonly string[]) {
  const find = (re: RegExp) => lines.map((l) => re.exec(l)).find(Boolean) ?? null;
  const stmt = find(/Statement Date\s+(\d{1,2} [A-Za-z]{3} \d{4})/);
  const statementDate = stmt ? parseFullDate(stmt[1]!) : null;
  if (!statementDate) {
    return {
      is_statement: false,
      bank: "OTHER",
      kind: "card",
      statement_date: "2000-01-01",
      due_date: null,
      minimum_payment: null,
      accounts: [],
    };
  }
  const due = find(/Due Date\s+(\d{1,2} [A-Za-z]{3} \d{4})/);
  const money = (re: RegExp) => find(re)?.[1]?.replace(/,/g, "") ?? null;
  const product = find(/^(.+?CARD)\s+Card Number/)?.[1] ?? "CARD";
  const [sy, sm] = statementDate.split("-").map(Number) as [number, number];
  const rows = lines.flatMap((l) => {
    const m = /^(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\s+(.+?)\s+(-?)([\d,]+\.\d{2})$/.exec(l);
    if (!m) return [];
    const ymd = (dd: string, mm: string) => `${Number(mm) > sm ? sy - 1 : sy}-${mm}-${dd}`;
    const desc = m[5]!;
    return [
      {
        date: ymd(m[1]!, m[2]!),
        post_date: ymd(m[3]!, m[4]!),
        description: desc,
        amount: m[7]!.replace(/,/g, ""),
        direction: m[6] ? "credit" : "debit",
        type: /PAYMENT/.test(desc) ? "payment" : /REFUND/.test(desc) ? "refund" : "purchase",
      },
    ];
  });
  return {
    is_statement: true,
    bank: "OTHER",
    kind: "card",
    statement_date: statementDate,
    due_date: due ? parseFullDate(due[1]!) : null,
    minimum_payment: money(/Minimum Amount Due\s+S\$\s*([\d,.]+)/),
    accounts: [
      {
        product_name: product,
        opening_balance: money(/Previous Balance\s+S\$\s*([\d,.]+)/),
        opening_balance_is_credit: false,
        closing_balance: money(/New Balance\s+S\$\s*([\d,.]+)/),
        closing_balance_is_credit: false,
        rows,
      },
    ],
  };
}
