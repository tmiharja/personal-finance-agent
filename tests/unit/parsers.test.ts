import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLines, PdfError } from "@/server/ingest/pdf";
import { ParseError, parseStatementPdf } from "@/server/ingest/parsers";
import { classify, inferDate } from "@/server/ingest/parsers/common";
import { parseDbsCard } from "@/server/ingest/parsers/dbs-card";
import { parseUobCard } from "@/server/ingest/parsers/uob-card";

const DIR = join(process.cwd(), "evals", "fixtures", "synthetic");

type Expected = {
  bank: string;
  statementDate: string;
  dueDate: string;
  minimumPaymentCents: number;
  statementTotalCents: number;
  cards: {
    productName: string;
    ordinal: number;
    previousBalanceCents: number;
    totalCents: number;
    rows: {
      txnDate: string;
      postDate: string | null;
      amountCents: number;
      rawDescriptor: string;
      fx: { currency: string; amount: string } | null;
      kind: string;
    }[];
  }[];
};

const fixtures = ["dbs", "uob"].flatMap((bank) =>
  readdirSync(join(DIR, bank))
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => `${bank}/${f.replace(".pdf", "")}`),
);
const load = (name: string) => new Uint8Array(readFileSync(join(DIR, `${name}.pdf`)));
const expected = (name: string) =>
  JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), "utf8")) as Expected;

function project(e: Expected) {
  return {
    bank: e.bank,
    statementDate: e.statementDate,
    dueDate: e.dueDate,
    minimumPaymentCents: e.minimumPaymentCents,
    statementTotalCents: e.statementTotalCents,
    cards: e.cards.map((c) => ({
      productName: c.productName,
      ordinal: c.ordinal,
      previousBalanceCents: c.previousBalanceCents,
      totalCents: c.totalCents,
      reconciled: true,
      rows: c.rows.map((r) => ({
        txnDate: r.txnDate,
        postDate: r.postDate,
        amountCents: r.amountCents,
        rawDescriptor: r.rawDescriptor,
        fx: r.fx,
        kind: r.kind,
      })),
    })),
  };
}

describe("golden: synthetic DBS + UOB card statements", () => {
  it("covers all 24 fixtures", () => expect(fixtures).toHaveLength(24));

  it.each(fixtures)("%s parses exactly to its expected.json", async (name) => {
    const { statement, names } = await parseStatementPdf(load(name));
    const got = {
      ...statement,
      cards: statement.cards.map((c) => ({
        ...c,
        rows: c.rows.map((r) => ({ ...r, refNo: undefined })),
      })),
    };
    expect(got).toMatchObject(project(expected(name)));
    expect(statement.totalsMatch).toBe(true);
    expect(statement.warnings).toEqual([]);
    // Cardholder names are surfaced for the firewall, never as output fields.
    expect(names).toContain("ALEX TAN");
    expect(JSON.stringify(statement)).not.toMatch(
      /ALEX TAN|JORDAN TAN|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}/,
    );
  });

  it("captures reference numbers for the dedupe hash (UOB charges, DBS payments)", async () => {
    const uob = await parseStatementPdf(load("uob/2026-01"));
    expect(
      uob.statement.cards[0]!.rows.filter((r) => r.kind === "charge").every((r) =>
        /^\d{23}$/.test(r.refNo ?? ""),
      ),
    ).toBe(true);
    const dbs = await parseStatementPdf(load("dbs/2026-03"));
    expect(dbs.statement.cards[0]!.rows.find((r) => r.kind === "card_payment")!.refNo).toMatch(
      /^\d{23}$/,
    );
  });

  it("drops supplementary cardholder headers but keeps their rows", async () => {
    const { statement, names } = await parseStatementPdf(load("dbs/2026-04"));
    expect(names).toEqual(expect.arrayContaining(["ALEX TAN", "JORDAN TAN"]));
    expect(
      statement.cards[0]!.rows.some((r) => r.rawDescriptor === "SAMPLE BOOKSTORE SINGAPORE"),
    ).toBe(true);
  });
});

describe("missing printed totals never count as reconciled", () => {
  const without = async (name: string, drop: RegExp) =>
    (await extractLines(load(name))).lines.filter((l) => !drop.test(l.text));

  it("DBS: a card with no TOTAL line is unreconciled and warned", async () => {
    const lines = await without("dbs/2026-03", /^TOTAL:/);
    const { statement } = parseDbsCard(lines);
    expect(statement.cards.every((c) => !c.reconciled)).toBe(true);
    expect(statement.warnings).toContain("card_1_total_missing");
  });

  it("UOB: a card with no TOTAL BALANCE line is unreconciled and warned", async () => {
    const lines = await without("uob/2026-03", /^TOTAL BALANCE FOR/);
    const { statement } = parseUobCard(lines);
    expect(statement.cards.every((c) => !c.reconciled)).toBe(true);
    expect(statement.warnings).toContain("card_1_total_missing");
  });

  it("a missing statement total leaves totalsMatch unknown, not true", async () => {
    const lines = await without("dbs/2026-03", /GRAND TOTAL FOR ALL CARD ACCOUNTS/);
    const { statement } = parseDbsCard(lines);
    expect(statement.cards.every((c) => c.reconciled)).toBe(true);
    expect(statement.totalsMatch).toBeNull();
  });
});

describe("encrypted statements", () => {
  it("opens an owner-password (copy-restricted) PDF without asking", async () => {
    const { statement } = await parseStatementPdf(load("variants/dbs-2026-03-owner-only"));
    expect(statement).toMatchObject(project(expected("dbs/2026-03")));
  });

  it("asks for an open password, rejects a wrong one, then parses", async () => {
    const pdf = load("variants/uob-2026-01-password");
    await expect(parseStatementPdf(pdf)).rejects.toMatchObject({ code: "password_required" });
    await expect(parseStatementPdf(pdf, { password: "nope" })).rejects.toMatchObject({
      code: "password_incorrect",
    });
    const { statement } = await parseStatementPdf(pdf, { password: "alex0000" });
    expect(statement).toMatchObject(project(expected("uob/2026-01")));
  });
});

describe("rejections", () => {
  it("rejects a PDF that isn't a supported statement", async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText("Hello", { x: 50, y: 700, font: await doc.embedFont(StandardFonts.Helvetica) });
    await expect(parseStatementPdf(await doc.save())).rejects.toBeInstanceOf(ParseError);
  });

  it("rejects a PDF with no text layer", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage();
    await expect(parseStatementPdf(await doc.save())).rejects.toMatchObject({ code: "no_text" });
  });

  it("rejects bytes that aren't a PDF", async () => {
    await expect(parseStatementPdf(new TextEncoder().encode("not a pdf"))).rejects.toBeInstanceOf(
      PdfError,
    );
  });
});

describe("helpers", () => {
  it("infers the year across Dec → Jan", () => {
    expect(inferDate("28 DEC", "2026-01-14")).toBe("2025-12-28");
    expect(inferDate("05 JAN", "2026-01-14")).toBe("2026-01-05");
  });

  it("classifies rows", () => {
    expect(classify("AUTOPAY", -100)).toBe("card_payment");
    expect(classify("GIRO PAYMENT", -100)).toBe("card_payment");
    expect(classify("UOB SAMPLE CASHBACK Card Cashback", -71)).toBe("cashback");
    expect(classify("ANNUAL FEE", 19620)).toBe("fee");
    expect(classify("GST @ 9%", 1766)).toBe("fee");
    expect(classify("SHOPEE SG MP", -507)).toBe("refund");
    expect(classify("GRAB* A-X", 1200)).toBe("charge");
  });
});
