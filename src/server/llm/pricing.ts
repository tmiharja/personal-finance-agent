/**
 * Anthropic API list prices in USD per million tokens (PRD §7.3). Only models
 * listed here can be configured (src/env.ts), so every call's cost is computable.
 * Opus 5.5 is listed because Sonnet 5.5's server-side refusal fallback may
 * answer on another model; any unlisted model is priced at the highest rate.
 */
export const MODEL_PRICING = {
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheRead: 0.1, output: 5 },
  "claude-sonnet-5-5": { input: 2, cacheWrite5m: 2.5, cacheRead: 0.2, output: 10 },
  "claude-opus-5-5": { input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 },
} as const satisfies Record<string, ModelPrice>;

export type ModelPrice = {
  input: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
};

export type ModelId = keyof typeof MODEL_PRICING;
export const MODEL_IDS = Object.keys(MODEL_PRICING) as [ModelId, ...ModelId[]];

export type TokenUsage = {
  /** Uncached input tokens. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

const HIGHEST = Object.values(MODEL_PRICING).reduce((a, b) => (b.output > a.output ? b : a));

/** Cost of one call in USD. A model missing from the table is priced at the highest rate. */
export function costUsd(model: string, usage: TokenUsage): number {
  const p: ModelPrice = (MODEL_PRICING as Record<string, ModelPrice>)[model] ?? HIGHEST;
  const total =
    usage.inputTokens * p.input +
    usage.cacheWriteTokens * p.cacheWrite5m +
    usage.cacheReadTokens * p.cacheRead +
    usage.outputTokens * p.output;
  return total / 1_000_000;
}

/** The API's usage block → our counters. `input_tokens` already excludes cached tokens. */
export function fromApiUsage(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

type IterationUsage = {
  type: string;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * Cost of one response. With a server-side fallback, one response can include
 * hops on different models; `usage.iterations` lists each with its model, so
 * each is priced at its own rate. Otherwise the response's model prices it all.
 */
export function responseCostUsd(
  response: {
    model: string;
    usage: Parameters<typeof fromApiUsage>[0] & { iterations?: readonly IterationUsage[] | null };
  },
  requestedModel: string,
): number {
  const iterations = response.usage.iterations?.filter(
    (i) => i.type === "message" || i.type === "fallback_message",
  );
  if (!iterations?.length) return costUsd(response.model, fromApiUsage(response.usage));
  return iterations.reduce(
    (sum, i) => sum + costUsd(i.model ?? requestedModel, fromApiUsage(i)),
    0,
  );
}
