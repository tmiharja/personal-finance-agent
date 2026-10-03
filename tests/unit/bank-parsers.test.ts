import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ParseError, parseStatementCsv, parseStatementFile } from "@/server/ingest/parsers";

const DIR = join(process.cwd(), "evals", "fixtures", "synthetic");

type Expected = {
  bank: string;
  kind: string;
  statementDate: string;
  cards: {
    productName: string;
    ordinal: number;
    previousBalanceCents: number | null;
    totalCents: number | null;
    reconciled: boolean | null;
    rows: { txnDate: string; amountCents: number; rawDescriptor: string; kind: string }[];
  }[];
};

const files = ["posb", "uob-one"].flatMap((acct) =>
  readdirSync(join(DIR, acct))
    .filter((f) => f.endsWith(".pdf") || f.endsWith(".csv"))
    .map((f) => `${acct}/${f}`),
);
const load = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
const expected = (f: string) =>
  JSON.parse(
    readFileSync(
      join(DIR, f.replace(/\.pdf$/, ".expected.json").replace(/\.csv$/, ".csv.expected.json")),
      "utf8",
    ),
  ) as Expected;

const project = (e: Expected) => ({
  bank: e.bank,
  kind: e.kind,
  statementDate: e.statementDate,
  cards: e.cards.map((c) => ({
    productName: c.productName,
    ordinal: c.ordinal,
    previousBalanceCents: c.previousBalanceCents,
    totalCents: c.totalCents,
    reconciled: c.reconciled,
    rows: c.rows.map((r) => ({
      txnDate: r.txnDate,
      postDate: null,
      amountCents: r.amountCents,
      rawDescriptor: r.rawDescriptor,
      refNo: null,
      fx: null,
      kind: r.kind,
    })),
  })),
});

describe("bank-account statements (provisional layouts): golden fixtures", () => {
  it("covers 12 months of POSB and UOB, as PDF and CSV", () => {
    expect(files.length).toBe(48);
  });

  it.each(files)("%s parses exactly to its expected output", async (f) => {
    const { statement } = await parseStatementFile(load(f));
    const {
      parserVersion,
      warnings,
      dueDate,
      minimumPaymentCents,
      statementTotalCents,
      totalsMatch,
      ...rest
    } = statement;
    expect(parserVersion).toMatch(/provisional/);
    expect({ dueDate, minimumPaymentCents, statementTotalCents, totalsMatch }).toEqual({
      dueDate: null,
      minimumPaymentCents: null,
      statementTotalCents: null,
      totalsMatch: null,
    });
    expect(warnings.filter((w) => w !== "no_opening_balance")).toEqual([]);
    expect(rest).toEqual(project(expected(f)));
  });

  it("a PDF and the CSV of the same month give the same rows, so either dedupes the other", async () => {
    for (const acct of ["posb", "uob-one"]) {
      const pdf = await parseStatementFile(load(`${acct}/2026-03.pdf`));
      const csv = await parseStatementFile(load(`${acct}/2026-03.csv`));
      const rows = (r: typeof pdf) =>
        r.statement.cards[0]!.rows.map((x) => [x.txnDate, x.amountCents, x.rawDescriptor, x.kind]);
      expect(rows(csv)).toEqual(rows(pdf));
      expect(csv.statement.cards[0]!.productName).toBe(pdf.statement.cards[0]!.productName);
    }
  });

  it("reads balances across a page break, ignoring the repeated brought/carried-forward lines", async () => {
    for (const f of ["posb/2025-12.pdf", "uob-one/2025-12.pdf"]) {
      const { statement } = await parseStatementFile(load(f));
      expect(statement.cards[0]!.reconciled).toBe(true);
      expect(statement.cards[0]!.rows.length).toBeGreaterThan(30);
    }
  });

  it("keeps people's names out of every descriptor; the holder's name goes only to the firewall", async () => {
    for (const f of files) {
      const { statement, names } = await parseStatementFile(load(f));
      const text = JSON.stringify(statement);
      expect(text).not.toMatch(/ALEX|JORDAN|EXAMPLE AVENUE|000-0/);
      if (f.endsWith(".pdf")) expect(names).toEqual(["ALEX TAN"]);
    }
  });

  it("a CSV whose amounts don't follow its running balance is not reconciled", () => {
    const text = readFileSync(join(DIR, "uob-one/2026-03.csv"), "utf8");
    // Drop one transaction line: the running balance no longer follows.
    const lines = text.split("\n");
    const header = lines.findIndex((l) => l.startsWith("Transaction Date"));
    const tampered = [...lines.slice(0, header + 3), ...lines.slice(header + 4)].join("\n");
    expect(tampered).not.toBe(text);
    const { statement } = parseStatementCsv(new TextEncoder().encode(tampered));
    expect(statement.cards[0]!.reconciled).toBe(false);
    expect(statement.warnings).toContain("running_balance_mismatch");
  });

  it("a PDF whose printed running balance is wrong is not reconciled, even if the totals add up", async () => {
    const { extractLines } = await import("@/server/ingest/pdf");
    const { parseDbsAccount } = await import("@/server/ingest/parsers/bank-pdf");
    const { lines } = await extractLines(load("posb/2026-03.pdf"));
    expect(parseDbsAccount(lines).statement.cards[0]!.reconciled).toBe(true);
    // Change one row's printed balance; opening, rows and closing stay as they are.
    const row = lines.find((l) => /^\d{2}\/03\/2026\b/.test(l.text) && l.items.length >= 4)!;
    const balance = row.items.at(-1)!;
    balance.str = "1.00";
    const { statement } = parseDbsAccount(lines);
    expect(statement.cards[0]!.reconciled).toBe(false);
    expect(statement.warnings).toContain("running_balance_mismatch");
  });

  it("refuses a CSV that isn't a supported bank export", () => {
    const csv = new TextEncoder().encode("date,amount\n2026-01-01,12.30\n");
    expect(() => parseStatementCsv(csv)).toThrow(ParseError);
    expect(() => parseStatementCsv(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(ParseError);
  });
});
