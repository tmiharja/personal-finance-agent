import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alerts, bills, subscriptions } from "@/db/schema";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { resolveDeterministic } from "@/server/categorise/categorise";
import type { MasterKeys } from "@/server/crypto/envelope";
import { loadFixtureStatements, seedDemoWorkspace } from "@/server/demo/seed";
import { runDetectors } from "@/server/detect/run";
import { DEFAULT_CATEGORIES, describeRow } from "@/server/finance/ledger";
import { extractWithAi } from "@/server/ingest/fallback";
import { parseStatementFile } from "@/server/ingest/parsers";
import type { Llm } from "@/server/llm/types";

/**
 * The eval scoreboard (PRD G7, OPS-3): every measure the app is held to, run
 * over the synthetic household in evals/fixtures. Codes and counts only.
 * `npm run eval` writes evals/results.json, which the admin page shows; a unit
 * test checks that file is current.
 */

export type Suite = {
  id: string;
  label: string;
  pass: number;
  total: number;
  /** The share of `total` that must pass. */
  target: number;
  ok: boolean;
  note?: string;
};

export type EvalResults = {
  /** "mock": the offline extractor stands in for Claude; "live": the real model ran. */
  ai: "mock" | "live";
  suites: Suite[];
};

const DIR = join(process.cwd(), "evals", "fixtures", "synthetic");
const suite = (s: Omit<Suite, "ok">): Suite => ({
  ...s,
  ok: s.total > 0 && s.pass / s.total >= s.target,
});

type ExpectedFile = {
  cards: {
    previousBalanceCents: number | null;
    totalCents: number | null;
    rows: {
      txnDate: string;
      amountCents: number;
      rawDescriptor: string;
      kind: string;
      transferLeg?: string;
    }[];
  }[];
};
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as ExpectedFile;
const key = (
  rows: { txnDate: string; amountCents: number; rawDescriptor: string; kind: string }[],
) => JSON.stringify(rows.map((r) => [r.txnDate, r.amountCents, r.rawDescriptor, r.kind]));

/** Every fixture file parses to exactly its expected rows and balances. */
async function parsers(): Promise<Suite[]> {
  let pass = 0;
  let total = 0;
  let reconciled = 0;
  let checkable = 0;
  for (const dir of ["dbs", "uob", "posb", "uob-one"]) {
    for (const f of readdirSync(join(DIR, dir))
      .filter((n) => /\.(pdf|csv)$/.test(n))
      .sort()) {
      total++;
      const want = read(
        join(
          DIR,
          dir,
          f.endsWith(".csv") ? `${f}.expected.json` : f.replace(/\.pdf$/, ".expected.json"),
        ),
      );
      try {
        const { statement } = await parseStatementFile(
          new Uint8Array(readFileSync(join(DIR, dir, f))),
        );
        const same =
          statement.cards.length === want.cards.length &&
          statement.cards.every(
            (c, i) =>
              key(c.rows) === key(want.cards[i]!.rows) &&
              c.totalCents === want.cards[i]!.totalCents,
          );
        if (same) pass++;
        for (const c of statement.cards) {
          if (c.reconciled === null) continue;
          checkable++;
          if (c.reconciled) reconciled++;
        }
      } catch {
        // A file that fails to parse simply doesn't pass.
      }
    }
  }
  return [
    suite({
      id: "parsers",
      label: "Statements parsed exactly (DBS/POSB and UOB, PDF and CSV)",
      pass,
      total,
      target: 1,
    }),
    suite({
      id: "reconciliation",
      label: "Card and account sections that reconcile",
      pass: reconciled,
      total: checkable,
      target: 1,
    }),
  ];
}

/** The AI fallback reads the unknown-layout fixtures exactly, and they reconcile. */
async function aiFallback(llm: Llm, model: string): Promise<Suite> {
  let pass = 0;
  const files = readdirSync(join(DIR, "sample-bank"))
    .filter((n) => n.endsWith(".pdf"))
    .sort();
  for (const f of files) {
    const want = read(join(DIR, "sample-bank", f.replace(/\.pdf$/, ".expected.json")));
    try {
      const { result } = await extractWithAi(
        llm,
        model,
        new Uint8Array(readFileSync(join(DIR, "sample-bank", f))),
      );
      const c = result.statement.cards[0];
      if (c && c.reconciled && key(c.rows) === key(want.cards[0]!.rows)) pass++;
    } catch {
      // Counted as a miss.
    }
  }
  return suite({
    id: "ai_fallback",
    label: "Unknown layouts read exactly by the AI fallback, and reconciled",
    pass,
    total: files.length,
    target: 1,
  });
}

/** Rules + merchant map: right whenever they decide, and they decide most rows. */
function categoriesSuites(): Suite[] {
  const allowed = new Set(DEFAULT_CATEGORIES.map((c) => c.name));
  const rows = loadFixtureStatements()
    .flatMap((s) => s.cards.flatMap((c) => c.rows))
    .filter((r) => !("transferLeg" in r));
  let decided = 0;
  let correct = 0;
  for (const r of rows) {
    const c = resolveDeterministic(
      { ...describeRow(r.rawDescriptor), kind: r.kind, amountCents: r.amountCents, fx: r.fx },
      [],
      allowed,
    );
    if (!c) continue;
    decided++;
    if (c.categoryName === r.expectedCategory) correct++;
  }
  return [
    suite({
      id: "categories_correct",
      label: "Categories right when rules and the merchant map decide",
      pass: correct,
      total: decided,
      target: 0.99,
    }),
    suite({
      id: "categories_coverage",
      label: "Rows categorised without the AI classifier",
      pass: decided,
      total: rows.length,
      target: 0.85,
    }),
  ];
}

type Planted = {
  type: string;
  merchant?: string;
  payee?: string;
  currency?: string;
  expect?: string[];
};

/** Detectors over the seeded household: every planted event found, little else. */
async function detectorsAndPairing(db: AppDb, keys: MasterKeys): Promise<Suite[]> {
  const seeded = await seedDemoWorkspace(db, "eval", keys);
  await runDetectors(db, "eval", keys, "2026-10-03");
  const [subs, found, raised] = await withUser(db, "eval", (tx) =>
    Promise.all([
      tx.select().from(subscriptions),
      tx.select().from(bills),
      tx.select().from(alerts),
    ]),
  );
  const name = (raw: string) => describeRow(raw).merchantName.toLowerCase();
  const planted = (
    JSON.parse(readFileSync(join(DIR, "ledger.json"), "utf8")) as { planted: Planted[] }
  ).planted;
  const expected = new Set<string>();
  for (const p of planted) {
    if (p.type === "subscription") expected.add(`subscription|${name(p.merchant!)}`);
    if (p.type === "trial_conversion") {
      expected.add(`subscription|${name(p.merchant!)}`);
      expected.add(`trial_conversion|${name(p.merchant!)}`);
    }
    for (const e of p.expect ?? [])
      if (e.startsWith("price_increase")) expected.add(`price_increase|${name(p.merchant!)}`);
    if (p.type === "bill") expected.add(`bill|${name(p.payee!)}`);
    if (p.type === "fee") expected.add("card_fee|dbs sample visa signature");
    if (p.type === "unusual_first_time_merchant")
      expected.add(`first_time_merchant|${name(p.merchant!)}`);
    if (p.type === "duplicate") expected.add(`duplicate_charge|${name(p.merchant!)}`);
    if (p.type === "unusual_amount") expected.add(`unusual_amount|${name(p.merchant!)}`);
    if (p.type === "foreign_charge" || p.type === "fx_trip")
      expected.add(`foreign_charge|${p.currency!.toLowerCase()}`);
  }
  const detected = [
    ...subs.map((s) => `subscription|${s.merchantName.toLowerCase()}`),
    ...found.map((b) => `bill|${b.payee.toLowerCase()}`),
    ...raised.map((a) => `${a.type}|${(a.subject ?? "").toLowerCase()}`),
  ];
  const hits = new Set(detected.filter((d) => expected.has(d)));

  // Planted pairs: each card bill paid from a bank account, and each own transfer.
  const bankPdfs = ["posb", "uob-one"].flatMap((dir) =>
    readdirSync(join(DIR, dir))
      .filter((n) => n.endsWith(".expected.json") && !n.endsWith(".csv.expected.json"))
      .map((n) => read(join(DIR, dir, n))),
  );
  const bankRows = bankPdfs.flatMap((s) => s.cards.flatMap((c) => c.rows));
  const plantedPairs =
    bankRows.filter((r) => r.kind === "card_payment").length +
    bankRows.filter((r) => r.transferLeg && r.amountCents > 0).length;

  return [
    suite({
      id: "detector_recall",
      label: "Planted events found (subscriptions, bills, alerts)",
      pass: hits.size,
      total: expected.size,
      target: 0.8,
    }),
    suite({
      id: "detector_precision",
      label: "Detections that are planted events",
      pass: detected.filter((d) => expected.has(d)).length,
      total: detected.length,
      target: 0.9,
      note: "The others are correct overdue-payment alerts for cards due with no payment in the data.",
    }),
    suite({
      id: "pairing",
      label: "Card payments and own transfers paired across accounts",
      pass: seeded.paired,
      total: plantedPairs,
      target: 1,
    }),
  ];
}

export async function runEvals(opts: {
  db: AppDb;
  keys: MasterKeys;
  llm: Llm;
  model: string;
}): Promise<EvalResults> {
  const suites = [
    ...(await parsers()),
    await aiFallback(opts.llm, opts.model),
    ...categoriesSuites(),
    ...(await detectorsAndPairing(opts.db, opts.keys)),
  ];
  return { ai: opts.llm.mock ? "mock" : "live", suites };
}
