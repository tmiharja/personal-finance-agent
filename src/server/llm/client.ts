import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getEnv } from "@/env";
import { fromApiUsage } from "./pricing";
import type { Llm } from "./types";

/** Sonnet 5.5 refusals are retried server-side on a model picked by refusal category. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function realLlm(apiKey: string): Llm {
  // SDK retries cover 408/409/429/5xx and connection errors.
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    mock: false,
    async classify(req) {
      const response = await client.messages.parse(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
          output_config: { format: zodOutputFormat(req.schema) },
        },
        { signal: req.signal },
      );
      return {
        output: response.parsed_output ?? null,
        usage: fromApiUsage(response.usage),
        model: response.model,
        stopReason: response.stop_reason,
      };
    },
    async turn(params, onText, signal) {
      const stream = client.beta.messages.stream(params, { signal });
      stream.on("text", onText);
      return stream.finalMessage();
    },
  };
}

let cached: { key: string; llm: Llm } | undefined;

/** The configured LLM, the offline mock (LLM_MOCK=1), or null when no API key is set. */
export async function getLlm(): Promise<Llm | null> {
  const env = getEnv();
  if (env.LLM_MOCK) {
    const { mockLlm } = await import("./mock");
    return mockLlm;
  }
  if (!env.ANTHROPIC_API_KEY) return null;
  if (cached?.key !== env.ANTHROPIC_API_KEY) {
    cached = { key: env.ANTHROPIC_API_KEY, llm: realLlm(env.ANTHROPIC_API_KEY) };
  }
  return cached.llm;
}
