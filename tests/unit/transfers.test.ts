import { describe, expect, it } from "vitest";
import { matchTransfers, type PairCandidate } from "@/server/finance/transfers";

let n = 0;
const c = (over: Partial<PairCandidate> & Pick<PairCandidate, "accountId" | "date" | "cents">) =>
  ({
    id: `t${++n}`,
    accountKind: "deposit",
    bank: "DBS",
    kind: "charge",
    merchant: "FAST transfer",
    ...over,
  }) as PairCandidate;

const bankPay = (date: string, cents: number, merchant = "DBS card payment") =>
  c({ accountId: "posb", date, cents, kind: "card_payment", merchant });
const cardPay = (accountId: string, date: string, cents: number, bank = "DBS") =>
  c({
    accountId,
    accountKind: "card",
    bank,
    date,
    cents,
    kind: "card_payment",
    merchant: "Card payment",
  });

describe("transfer pairing (IMP-10)", () => {
  it("pairs a bank's card payment with the card's own payment row", () => {
    const b = bankPay("2026-03-10", 22722);
    const k = cardPay("visa", "2026-03-10", -22722);
    expect(matchTransfers([b, k]).pairs).toEqual([
      { a: b.id, b: k.id, accountA: "posb", accountB: "visa", type: "card" },
    ]);
  });

  it("needs the same issuer, the opposite amount and at most 3 days apart", () => {
    expect(
      matchTransfers([bankPay("2026-03-10", 22722), cardPay("uob", "2026-03-10", -22722, "UOB")])
        .pairs,
    ).toEqual([]);
    expect(
      matchTransfers([bankPay("2026-03-10", 22722), cardPay("visa", "2026-03-10", -22723)]).pairs,
    ).toEqual([]);
    expect(
      matchTransfers([bankPay("2026-03-10", 22722), cardPay("visa", "2026-03-14", -22722)]).pairs,
    ).toEqual([]);
  });

  it("leaves an ambiguous match for review", () => {
    const b = bankPay("2026-03-10", 5000);
    const pairs = matchTransfers([
      b,
      cardPay("visa", "2026-03-10", -5000),
      cardPay("mc", "2026-03-11", -5000),
    ]).pairs;
    expect(pairs).toEqual([]);
  });

  it("links a bank payment to its card before that card's statement is imported", () => {
    const b = bankPay("2026-04-08", 57323);
    const statements = [
      { accountId: "visa", bank: "DBS", statementDate: "2026-03-14", totalCents: 57323 },
      { accountId: "mc", bank: "DBS", statementDate: "2026-03-14", totalCents: 23601 },
    ];
    expect(matchTransfers([b], statements).links).toEqual([{ id: b.id, cardAccountId: "visa" }]);
    // No exact balance, but the only DBS card: still that card.
    const only = [{ accountId: "visa", bank: "DBS", statementDate: "2026-03-14", totalCents: 100 }];
    expect(matchTransfers([b], only).links).toEqual([{ id: b.id, cardAccountId: "visa" }]);
    // Two DBS cards and no exact balance: unknown.
    const two = [
      ...only,
      { accountId: "mc", bank: "DBS", statementDate: "2026-03-14", totalCents: 200 },
    ];
    expect(matchTransfers([b], two).links).toEqual([]);
  });

  it("pairs a transfer out of one account with the same amount into another, within 3 days", () => {
    const out = c({ accountId: "uob", date: "2026-03-26", cents: 300000 });
    const into = c({ accountId: "posb", date: "2026-03-27", cents: -300000, kind: "income" });
    expect(matchTransfers([out, into]).pairs).toEqual([
      { a: out.id, b: into.id, accountA: "uob", accountB: "posb", type: "transfer" },
    ]);
  });

  it("never pairs within one account, purchases, or legs four days apart", () => {
    const out = c({ accountId: "uob", date: "2026-03-26", cents: 300000 });
    expect(
      matchTransfers([out, c({ accountId: "uob", date: "2026-03-26", cents: -300000 })]).pairs,
    ).toEqual([]);
    expect(
      matchTransfers([
        out,
        c({ accountId: "posb", date: "2026-03-26", cents: -300000, merchant: "FairPrice" }),
      ]).pairs,
    ).toEqual([]);
    expect(
      matchTransfers([out, c({ accountId: "posb", date: "2026-03-30", cents: -300000 })]).pairs,
    ).toEqual([]);
  });
});
