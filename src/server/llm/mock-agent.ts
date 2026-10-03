import type { BetaMessage, BetaMessageParam, TurnParams } from "./types";

/**
 * LLM_MOCK=1: a scripted Ask agent. It follows the same protocol as the real
 * model (resolve_period → a data tool → an answer quoting the tool's figures),
 * so the loop, tools, guard and UI run end to end offline. Questions containing
 * "MOCK_BAD_NUMBER" make the first answer cite a figure no tool returned, to
 * exercise the numbers guard.
 */

const CATEGORIES = [
  "Dining",
  "Groceries",
  "Transport",
  "Shopping",
  "Health",
  "Travel",
  "Education",
  "Subscriptions",
  "Entertainment",
  "Home",
];

const textOf = (m: BetaMessageParam) =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("");

const sgd = (x: string) =>
  `S$${Number(x).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function message(
  content: BetaMessage["content"],
  stop: BetaMessage["stop_reason"],
  model: string,
): BetaMessage {
  return {
    id: `msg_mock_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 900,
      output_tokens: 60,
      cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

let seq = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use" as const,
  id: `toolu_mock_${++seq}`,
  name,
  input,
});

export async function mockTurn(
  params: TurnParams,
  onText: (d: string) => void,
): Promise<BetaMessage> {
  const msgs = params.messages;
  // The question is the last user turn that isn't tool results or a guard note.
  const qIndex = msgs.findLastIndex(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      !m.content.startsWith("[Numbers check]"),
  );
  const question = textOf(msgs[qIndex]!);
  const guarded = msgs
    .slice(qIndex)
    .some((m) => m.role === "user" && textOf(m).startsWith("[Numbers check]"));
  const results: { name: string; data: Record<string, unknown> }[] = [];
  const names = new Map<string, string>();
  for (const m of msgs.slice(qIndex)) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, b.name);
      if (b.type === "tool_result" && typeof b.content === "string") {
        results.push({
          name: names.get(b.tool_use_id) ?? "",
          data: JSON.parse(b.content) as Record<string, unknown>,
        });
      }
    }
  }
  const model = String(params.model);
  const say = (text: string) => {
    for (const chunk of text.match(/.{1,24}/gs) ?? []) onText(chunk);
    return message(
      [{ type: "text", text, citations: null }] as BetaMessage["content"],
      "end_turn",
      model,
    );
  };

  if (/\b(invest|stocks?|should i buy)\b/i.test(question)) {
    return say("I can't give investment advice, but I can tell you what you've spent and where.");
  }
  // Changes: the mock proposes (never applies), like the real model must.
  const budget = /budget of S?\$?([\d,.]+) (?:a month )?for ([\w &]+?)\??$/i.exec(question);
  const move = /(?:move|recategori[sz]e) ([\w &]+?) (?:transactions )?to ([\w &]+?)\??$/i.exec(
    question,
  );
  if (budget || move) {
    const proposed = results.find((r) => r.name.startsWith("propose_"))?.data;
    if (!proposed) {
      const call = budget
        ? toolUse("propose_budget", {
            category: budget[2]!.trim(),
            monthly_amount_sgd: Number(budget[1]!.replace(/,/g, "")),
          })
        : toolUse("propose_recategorise", {
            merchant: move![1]!.trim(),
            category: move![2]!.trim(),
            from: null,
            to: null,
          });
      return message([call] as BetaMessage["content"], "tool_use", model);
    }
    if (typeof proposed.error === "string") {
      return say(`I couldn't suggest that change (${proposed.error.replace(/_/g, " ")}).`);
    }
    return say(`I've suggested it: ${String(proposed.title)}. Check the card below to approve it.`);
  }
  if (/waive|waiver/i.test(question)) {
    const alerts = results.find((r) => r.name === "get_alerts")?.data;
    if (!alerts)
      return message(
        [toolUse("get_alerts", { include_closed: false })] as BetaMessage["content"],
        "tool_use",
        model,
      );
    const draft = results.find((r) => r.name === "get_draft")?.data;
    if (!draft) {
      const fee = (alerts.alerts as { id: string; type: string }[]).find(
        (a) => a.type === "card_fee",
      );
      if (!fee) return say("You have no open card fee alerts.");
      return message(
        [
          toolUse("get_draft", { kind: "fee_waiver", alert_id: fee.id, merchant: null }),
        ] as BetaMessage["content"],
        "tool_use",
        model,
      );
    }
    return say(
      "I've put a draft waiver request below. Fill in the blanks and send it to your bank.",
    );
  }
  if (/on track|my budgets?\b/i.test(question)) {
    const b = results.find((r) => r.name === "get_budgets")?.data;
    if (!b)
      return message(
        [toolUse("get_budgets", { month: null })] as BetaMessage["content"],
        "tool_use",
        model,
      );
    const lines = (b.budgets ?? []) as {
      category: string;
      spent_sgd: string;
      budget_sgd: string;
      status: string;
    }[];
    if (!lines.length) return say("You haven't set any budgets yet.");
    return say(
      lines
        .map(
          (l) =>
            `${l.category}: ${sgd(l.spent_sgd)} of ${sgd(l.budget_sgd)} (${l.status.replace("_", " ")})`,
        )
        .join("; ") + ".",
    );
  }
  if (/subscription/i.test(question)) {
    const subs = results.find((r) => r.name === "get_subscriptions")?.data;
    if (!subs)
      return message(
        [toolUse("get_subscriptions", {})] as BetaMessage["content"],
        "tool_use",
        model,
      );
    const list = subs.subscriptions as { merchant: string; monthly_equivalent_sgd: string }[];
    return say(
      `Your ${subs.running} running subscriptions cost ${sgd(String(subs.monthly_total_sgd))} a month; the largest is ${list[0]?.merchant ?? "none"} at ${sgd(list[0]?.monthly_equivalent_sgd ?? "0")}.`,
    );
  }
  const period = results.find((r) => r.name === "resolve_period")?.data;
  if (!period) {
    const expr =
      question.match(
        /\b(q[1-4](?: \d{4})?|last month|this month|this year|last year|last \d+ months|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?: \d{4})?)\b/i,
      )?.[0] ?? "last 3 months";
    return message(
      [toolUse("resolve_period", { expression: expr })] as BetaMessage["content"],
      "tool_use",
      model,
    );
  }
  const category = CATEGORIES.find((c) => question.toLowerCase().includes(c.toLowerCase())) ?? null;
  const data = results.filter((r) => r.name !== "resolve_period").at(-1);
  if (!data) {
    const { from, to } = period as { from: string; to: string };
    if (/merchant|where/i.test(question)) {
      return message(
        [toolUse("top_merchants", { from, to, category, limit: 3 })] as BetaMessage["content"],
        "tool_use",
        model,
      );
    }
    if (/categor|breakdown/i.test(question)) {
      return message(
        [toolUse("spend_by_category", { from, to })] as BetaMessage["content"],
        "tool_use",
        model,
      );
    }
    return message(
      [toolUse("spend_summary", { from, to, category, merchant: null })] as BetaMessage["content"],
      "tool_use",
      model,
    );
  }
  const label = String(period.label);
  const d = data.data;
  if (/MOCK_BAD_NUMBER/.test(question) && !guarded) {
    return say(`You spent S$9,999.99 in ${label}.`);
  }
  if (data.name === "top_merchants") {
    const ms = d.merchants as { merchant: string; spent_sgd: string }[];
    return say(
      `In ${label}, your top merchants were ${ms.map((m) => `${m.merchant} (${sgd(m.spent_sgd)})`).join(", ")}.`,
    );
  }
  if (data.name === "spend_by_category") {
    const cs = d.categories as { category: string; spent_sgd: string }[];
    return say(
      `In ${label} you spent ${sgd(String(d.total_spent_sgd))}; the largest category was ${cs[0]?.category ?? "none"} at ${sgd(cs[0]?.spent_sgd ?? "0")}.`,
    );
  }
  return say(
    `You spent ${sgd(String(d.spent_sgd))}${category ? ` on ${category}` : ""} in ${label}, across ${d.transactions} transactions.`,
  );
}
