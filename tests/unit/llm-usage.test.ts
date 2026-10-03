import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { costUsd, responseCostUsd } from "@/server/llm/pricing";
import { budgetBlock, recordUsage } from "@/server/llm/usage";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "a");
  await createUser(db, "b");
});
afterAll(() => close());

const tokens = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe("pricing", () => {
  it("prices per million tokens, cache reads at the cache rate", () => {
    expect(costUsd("claude-haiku-4-5", tokens(1_000_000, 0))).toBe(1);
    expect(costUsd("claude-sonnet-5-5", tokens(0, 1_000_000))).toBe(10);
    expect(
      costUsd("claude-sonnet-5-5", { ...tokens(0, 0), cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(0.2);
  });
  it("prices each hop of a fallback response at its own model's rate", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 2_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const iterations = [
      {
        type: "message",
        model: "claude-sonnet-5-5",
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      {
        type: "fallback_message",
        model: "claude-opus-5-5",
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ];
    // Sonnet S$10/MTok out + Opus S$20/MTok out, not 2 MTok at the final model's rate.
    expect(
      responseCostUsd(
        { model: "claude-opus-5-5", usage: { ...usage, iterations } },
        "claude-sonnet-5-5",
      ),
    ).toBe(30);
    expect(responseCostUsd({ model: "claude-sonnet-5-5", usage }, "claude-sonnet-5-5")).toBe(20);
  });
  it("prices an unknown (fallback) model at the highest listed rate", () => {
    expect(costUsd("some-future-model", tokens(0, 1_000_000))).toBe(20);
  });
});

describe("guardrails", () => {
  it("allows calls under every limit", async () => {
    expect(await budgetBlock(db, "a", "ask")).toBeNull();
  });

  it("stops Ask after the daily question limit, per user", async () => {
    await withUser(db, "a", async (tx) => {
      for (let i = 0; i < 3; i++)
        await recordUsage(tx, "a", "ask", "claude-sonnet-5-5", tokens(10, 10));
    });
    expect(await budgetBlock(db, "a", "ask", 3)).toBe("daily_limit");
    expect(await budgetBlock(db, "a", "categorise", 3)).toBeNull();
    expect(await budgetBlock(db, "b", "ask", 3)).toBeNull();
  });

  it("pauses a user over the monthly soft cap ($3)", async () => {
    await withUser(db, "a", (tx) =>
      recordUsage(tx, "a", "categorise", "claude-haiku-4-5", tokens(3_000_000, 0)),
    );
    expect(await budgetBlock(db, "a", "categorise")).toBe("user_budget");
    expect(await budgetBlock(db, "b", "categorise")).toBeNull();
  });

  it("trips the global breaker ($40) for everyone", async () => {
    await withUser(db, "b", (tx) =>
      recordUsage(tx, "b", "ask", "claude-sonnet-5-5", tokens(0, 4_000_000)),
    );
    expect(await budgetBlock(db, "a", "ask")).toBe("global_budget");
  });
});
