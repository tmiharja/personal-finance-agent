"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AskEvent, AskTurn } from "@/server/agent/ask";
import type { Figure, View } from "@/server/agent/tools";
import AskFigure from "./ask-figure";
import { OPEN_ASK } from "./ask-button";

type Answer = {
  question: string;
  text: string;
  status: string | null;
  done: boolean;
  view?: View;
  figure?: Figure;
  excludes?: string;
  period?: string;
  guard?: string;
  error?: string;
};

/** The API accepts at most 24 earlier turns; the agent itself uses fewer. */
const MAX_HISTORY = 24;

const STARTERS = [
  "What did I spend on dining last month?",
  "Where did I spend the most in the last 3 months?",
  "Show my spending by category for Q1",
  "How did last month compare with the month before?",
  "What do my subscriptions cost each month?",
];

const TOOL_STATUS: Record<string, string> = {
  resolve_period: "Working out the dates…",
  spend_summary: "Adding up your spending…",
  spend_by_category: "Grouping by category…",
  compare_periods: "Comparing periods…",
  top_merchants: "Finding top merchants…",
  monthly_spend: "Looking month by month…",
  find_transactions: "Finding transactions…",
  get_subscriptions: "Checking subscriptions…",
  get_bills: "Checking bills…",
  get_alerts: "Checking alerts…",
  list_categories: "Checking your categories…",
};

const ERRORS: Record<string, string> = {
  daily_limit: "You've reached today's question limit. Ask again tomorrow.",
  user_budget: "Ask is paused for this month: your AI usage limit is reached.",
  global_budget: "Ask is at capacity for this month. Your data is unaffected.",
  ask_unavailable: "Ask isn't available right now.",
  too_many_steps: "That question needed too many steps. Try something more specific.",
  unauthenticated: "Your session ended. Sign in again.",
};

/**
 * Ask (PRD ASK-1): a slide-over on desktop, full screen on mobile. The chat
 * lives only in this tab's memory; nothing is stored.
 */
export default function AskPanel() {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = () => {
      opener.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener(OPEN_ASK, show);
    return () => window.removeEventListener(OPEN_ASK, show);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [answers]);

  const update = (patch: (a: Answer) => Answer) =>
    setAnswers((all) => [...all.slice(0, -1), patch(all.at(-1)!)]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history: AskTurn[] = answers
      .filter((a) => a.done && !a.error)
      .flatMap((a) => [
        { role: "user" as const, content: a.question },
        { role: "assistant" as const, content: a.text },
      ])
      .slice(-MAX_HISTORY);
    setAnswers((all) => [...all, { question: q, text: "", status: null, done: false }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        update((a) => ({
          ...a,
          done: true,
          error: ERRORS[body.error ?? ""] ?? "Something went wrong. Try again.",
        }));
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AskEvent;
          update((a) => {
            switch (e.t) {
              case "text":
                return { ...a, text: a.text + e.d, status: null };
              case "reset":
                return { ...a, text: "" };
              case "status":
                return { ...a, status: TOOL_STATUS[e.tool] ?? "Looking…" };
              case "done":
                return {
                  ...a,
                  done: true,
                  status: null,
                  view: e.view,
                  figure: e.figure,
                  excludes: e.excludes,
                  period: e.period,
                  guard: e.guard,
                };
              case "error":
                return {
                  ...a,
                  done: true,
                  status: null,
                  error: ERRORS[e.code] ?? "Something went wrong. Try again.",
                };
            }
          });
        }
      }
      update((a) => (a.done ? a : { ...a, done: true }));
    } catch {
      update((a) => ({ ...a, done: true, status: null, error: "Connection lost. Try again." }));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <button
        type="button"
        aria-label="Close Ask"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 hidden bg-foreground/10 md:block"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        className="relative flex h-full w-full flex-col border-l border-rule bg-background md:w-[440px]"
      >
        <header className="flex items-center justify-between border-b border-rule px-5 py-4">
          <h2 id="ask-title" className="text-[17px] font-semibold">
            Ask about your spending
          </h2>
          <button type="button" onClick={close} className="link text-[13px]">
            Close
          </button>
        </header>

        <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-4" aria-live="polite">
          {answers.length === 0 ? (
            <div>
              <p className="text-[15px] text-muted">
                Answers come only from your imported statements, and every figure is checked against
                them.
              </p>
              <ul className="mt-4 space-y-2">
                {STARTERS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => ask(s)}
                      className="w-full rounded-lg border border-rule px-3 py-2 text-left text-[14px] hover:bg-accent-soft"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol className="space-y-6">
              {answers.map((a, i) => (
                <li key={i}>
                  <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-accent-soft px-3 py-2 text-[14px]">
                    {a.question}
                  </p>
                  <div className="mt-3 text-[15px] leading-relaxed">
                    {a.error ? (
                      <p role="alert" className="text-danger">
                        {a.error}
                      </p>
                    ) : (
                      <>
                        {a.text && <p className="whitespace-pre-line">{a.text}</p>}
                        {!a.done && (
                          <p className="text-[13px] text-muted">
                            {a.status ?? (a.text ? "" : "Thinking…")}
                          </p>
                        )}
                        {a.done && a.figure && <AskFigure figure={a.figure} />}
                        {a.done && (a.excludes || a.guard === "fallback") && (
                          <p className="mt-2 text-[12px] text-muted">
                            {a.guard === "fallback" && "Shown straight from your data. "}
                            {a.excludes}
                          </p>
                        )}
                        {a.done && a.view && a.view.count > 0 && (
                          <Link
                            href={a.view.href}
                            onClick={close}
                            className="link mt-2 inline-block text-[13px]"
                          >
                            {a.view.label ??
                              `View ${a.view.count} ${a.view.count === 1 ? "transaction" : "transactions"}`}
                          </Link>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <form
          className="border-t border-rule px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <label htmlFor="ask-input" className="sr-only">
            Your question
          </label>
          <textarea
            id="ask-input"
            ref={inputRef}
            rows={2}
            value={input}
            maxLength={1000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            placeholder="e.g. What did I spend on groceries in March?"
            className="w-full resize-none rounded-lg border border-rule bg-background px-3 py-2 text-[15px]"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted">Read-only. Not financial advice. Not saved.</p>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !input.trim()}
              className={cn(busy && "opacity-60")}
            >
              {busy ? "Answering…" : "Ask"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
