import type { BetaMessage, TurnParams } from "./types";

/** Scripted Ask turns for LLM_MOCK=1 (filled in with the Ask tools). */
export async function mockTurn(
  _params: TurnParams,
  _onText: (d: string) => void,
): Promise<BetaMessage> {
  throw new Error("mock agent not implemented");
}
