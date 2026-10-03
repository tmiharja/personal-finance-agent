import type { z } from "zod";
import { ZERO_USAGE } from "./pricing";
import type { ClassifyItem, ClassifyResponse, Llm } from "./types";
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
  turn: mockTurn,
};
