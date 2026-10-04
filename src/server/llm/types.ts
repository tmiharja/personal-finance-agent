import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages";
import type { z } from "zod";
import type { TokenUsage } from "./pricing";

export type { BetaMessage, BetaMessageParam, BetaTool };
export type TurnParams = BetaMessageStreamParams;

/** What the classifier sees for one merchant: masked, never a raw descriptor. */
export type ClassifyItem = {
  i: number;
  merchant: string;
  /** A sanitised descriptor sample, passed through maskForLlm. */
  example: string;
  /** Foreign currency of the charge, if any (a travel hint). */
  currency: string | null;
  credit: boolean;
};

export type ClassifyRequest<S extends z.ZodType> = {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  maxTokens: number;
  /** The same data as `prompt`, structured, for the offline mock. */
  items: ClassifyItem[];
  categories: readonly string[];
  signal?: AbortSignal;
};

export type ClassifyResponse<T> = {
  output: T | null;
  usage: TokenUsage;
  model: string;
  stopReason: string | null;
};

export type ExtractRequest<S extends z.ZodType> = {
  model: string;
  system: string;
  /** The statement text, already redacted (PII removed) and wrapped as data. */
  prompt: string;
  schema: S;
  maxTokens: number;
  /** The same redacted lines, for the offline mock. */
  lines: string[];
  signal?: AbortSignal;
};

/**
 * The ways the app calls Claude. The real implementation uses the Anthropic
 * SDK; LLM_MOCK=1 swaps in a deterministic offline one for tests and e2e.
 */
export interface Llm {
  readonly mock: boolean;
  /** One structured-output call (the categoriser). */
  classify<S extends z.ZodType>(req: ClassifyRequest<S>): Promise<ClassifyResponse<z.output<S>>>;
  /** One structured-output call reading a statement layout no parser knows (IMP-5). */
  extract<S extends z.ZodType>(req: ExtractRequest<S>): Promise<ClassifyResponse<z.output<S>>>;
  /** One streamed agent turn (Ask). Text deltas go to `onText`; resolves with the full message. */
  turn(
    params: TurnParams,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<BetaMessage>;
}
