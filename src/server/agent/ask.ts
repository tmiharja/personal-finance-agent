import { eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { categories } from "@/db/schema";
import { withUser } from "@/db/with-user";
import { getEnv } from "@/env";
import { dataSpan, type Range } from "@/server/finance/spend";
import { FALLBACK_BETA, getLlm } from "@/server/llm/client";
import { addUsage, fromApiUsage, responseCostUsd, ZERO_USAGE } from "@/server/llm/pricing";
import type { BetaMessage, BetaMessageParam, TurnParams } from "@/server/llm/types";
import { budgetBlock, recordUsage, type BudgetBlock } from "@/server/llm/usage";
import { logError, logEvent } from "@/server/log";
import { maskForLlm } from "@/server/pii/firewall";
import { checkNumbers, collectNumbers, extractNumbers, fallbackAnswer } from "./guard";
import { todaySgt } from "./period";
import { ASK_SYSTEM, GUARD_NOTE } from "./prompt";
import type { Draft } from "@/lib/drafts";
import type { ProposedCard } from "./proposals";
import { runTool, TOOLS, type Figure, type ToolOutcome, type View } from "./tools";

/**
 * Ask (PRD §6.5): a tool loop on Claude Sonnet 5.5, streamed. The model
 * reads through typed tools and never does arithmetic; the numbers guard
 * checks the final answer against tool results. It can propose changes
 * (ACT-10) but never apply them: each proposal waits for the person's approval.
 */

export const MAX_STEPS = 8;
const MAX_HISTORY_TURNS = 6;
const TIMEOUT_MS = 60_000;

export type AskTurn = { role: "user" | "assistant"; content: string };

export type AskEvent =
  | { t: "text"; d: string }
  | { t: "status"; tool: string }
  | { t: "reset" }
  | {
      t: "done";
      guard: "pass" | "retried" | "fallback" | "skipped";
      view?: View;
      figure?: Figure;
      excludes?: string;
      period?: string;
      /** Changes Ask proposed this turn, each waiting for the person's approval. */
      proposals?: ProposedCard[];
      /** Drafts to copy (ACT-2). */
      drafts?: Draft[];
    }
  | { t: "error"; code: AskErrorCode };

export type AskErrorCode = BudgetBlock | "ask_unavailable" | "ask_failed" | "too_many_steps";

/** Fallbacks are the "default" form: Claude API only, Sonnet 5.5 / Opus 5.5. */
const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);

function excludesNote(outcomes: ToolOutcome[]): string | undefined {
  const last = [...outcomes].reverse().find((o) => o.excluded)?.excluded;
  if (!last || (last.cardPayments === 0 && last.cashback === 0 && !last.transfers))
    return undefined;
  const parts = [
    last.cardPayments
      ? `${last.cardPayments} card ${last.cardPayments === 1 ? "payment" : "payments"}`
      : "",
    last.transfers
      ? `${last.transfers} ${last.transfers === 1 ? "transfer" : "transfers"} between your accounts`
      : "",
    last.cashback ? `${last.cashback} cashback ${last.cashback === 1 ? "credit" : "credits"}` : "",
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Excludes ${list}.`;
}

const textOf = (m: BetaMessage) =>
  m.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

export async function runAsk(opts: {
  db: AppDb;
  userId: string;
  question: string;
  history: AskTurn[];
  emit: (e: AskEvent) => void;
  signal?: AbortSignal;
  today?: string;
}): Promise<void> {
  const { db, userId, emit } = opts;
  const env = getEnv();
  const blocked = await budgetBlock(db, userId, "ask");
  if (blocked) return emit({ t: "error", code: blocked });
  const llm = await getLlm();
  if (!llm) return emit({ t: "error", code: "ask_unavailable" });

  const today = opts.today ?? todaySgt();
  const ctxData = await withUser(db, userId, async (tx) => ({
    coverage: await dataSpan(tx),
    categories: (
      await tx
        .select({ name: categories.name })
        .from(categories)
        .where(eq(categories.hidden, false))
        .orderBy(categories.sort)
    ).map((c) => c.name),
  }));

  const question = maskForLlm(opts.question.slice(0, 1000));
  const messages: BetaMessageParam[] = [
    ...opts.history
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((t) => ({ role: t.role, content: maskForLlm(t.content.slice(0, 2000)) })),
    { role: "user", content: question },
  ];
  const model = env.MODEL_ASK;
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  const outcomes: ToolOutcome[] = [];
  const toolLog: { name: string; result: Record<string, unknown> }[] = [];
  const allowed: number[] = [0, 100, ...extractNumbers(question).map((f) => f.value)];
  let usage = ZERO_USAGE;
  let cost = 0;
  let calls = 0;
  let servedBy: string = model;
  let retried = false;
  let period: string | undefined;

  // One usage row per question, on every exit after a model call (answers,
  // failures and step limits alike), priced per turn: a fallback hop costs its own rate.
  let recorded = false;
  const record = async () => {
    if (recorded || calls === 0) return;
    recorded = true;
    await withUser(db, userId, (tx) => recordUsage(tx, userId, "ask", servedBy, usage, cost));
  };

  const finish = async (guard: "pass" | "retried" | "fallback" | "skipped") => {
    await record();
    logEvent("ask.answered", { tools: toolLog.length, guard, model: servedBy });
    emit({
      t: "done",
      guard,
      view: [...outcomes].reverse().find((o) => o.view)?.view,
      figure:
        guard === "skipped" ? undefined : [...outcomes].reverse().find((o) => o.figure)?.figure,
      excludes: excludesNote(outcomes),
      period,
      proposals: outcomes.flatMap((o) => (o.proposal ? [o.proposal] : [])),
      drafts: outcomes.flatMap((o) => (o.draft ? [o.draft] : [])),
    });
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const params: TurnParams = {
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: ASK_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        // Chat: low effort keeps thinking short and time-to-first-token low.
        output_config: { effort: "low" },
        ...(FALLBACK_MODELS.has(model)
          ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
          : {}),
      };
      let streamed = false;
      const message = await llm.turn(
        params,
        (d) => {
          streamed = true;
          emit({ t: "text", d });
        },
        signal,
      );
      calls++;
      usage = addUsage(usage, fromApiUsage(message.usage));
      cost += responseCostUsd(message, model);
      servedBy = message.model;

      if (message.stop_reason === "refusal") {
        if (streamed) emit({ t: "reset" });
        emit({
          t: "text",
          d: "I can't help with that one. Try asking about your spending, for example by category or month.",
        });
        return await finish("skipped");
      }

      const toolUses = message.content.filter(
        (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (message.stop_reason === "tool_use" && toolUses.length) {
        if (streamed) emit({ t: "reset" });
        messages.push({ role: "assistant", content: message.content });
        // Each tool call reads in its own short transaction under the user's RLS scope.
        const results = await withUser(db, userId, async (tx) => {
          const out = [];
          for (const use of toolUses) {
            emit({ t: "status", tool: use.name });
            const o = await runTool(
              {
                tx,
                userId,
                today,
                coverage: ctxData.coverage as Range | null,
                categories: ctxData.categories,
              },
              use.name,
              use.input,
            );
            out.push({ use, o });
          }
          return out;
        });
        for (const { use, o } of results) {
          outcomes.push(o);
          toolLog.push({ name: use.name, result: o.result });
          collectNumbers(o.result, allowed);
          if (use.name === "resolve_period" && typeof o.result.label === "string")
            period = o.result.label;
        }
        messages.push({
          role: "user",
          content: results.map(({ use, o }) => ({
            type: "tool_result" as const,
            tool_use_id: use.id,
            content: JSON.stringify(o.result),
            ...("error" in o.result ? { is_error: true } : {}),
          })),
        });
        continue;
      }

      const answer = textOf(message);
      if (!answer) {
        await record();
        emit({ t: "error", code: "ask_failed" });
        return;
      }
      const check = checkNumbers(answer, allowed);
      if (check.ok) return await finish(retried ? "retried" : "pass");
      logEvent("ask.guard_failed", { unsupported: check.unsupported.length, retried });
      emit({ t: "reset" });
      if (!retried) {
        retried = true;
        messages.push({ role: "assistant", content: message.content });
        messages.push({ role: "user", content: GUARD_NOTE(check.unsupported) });
        continue;
      }
      emit({ t: "text", d: fallbackAnswer(toolLog) });
      return await finish("fallback");
    }
    await record();
    emit({ t: "error", code: "too_many_steps" });
  } catch (e) {
    logError("ask", e);
    await record().catch(() => undefined);
    emit({ t: "error", code: "ask_failed" });
  }
}
