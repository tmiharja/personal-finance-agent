import { describe, expect, it } from "vitest";
import { bankRow } from "@/server/ingest/parsers/bank-rows";
import { describeRow } from "@/server/finance/ledger";

// Only the fixture personas' names appear here (CLAUDE.md §1).
const row = (type: string, details: string[], cents: number) => bankRow({ type, details, cents });

describe("bank rows: kind and a descriptor that is safe to store", () => {
  it("drops a person's name from PayNow and FAST transfers, keeping the direction", () => {
    expect(row("FAST Payment / Receipt", ["PIB2309181234567890", "TO JORDAN TAN"], 4500)).toEqual({
      kind: "charge",
      rawDescriptor: "FAST TRANSFER OUT",
    });
    expect(row("PayNow Transfer", ["FROM ALEX TAN", "OTHR"], -12000)).toEqual({
      kind: "income",
      rawDescriptor: "PAYNOW TRANSFER IN",
    });
    expect(row("Funds Transfer", ["JORDAN TAN 123-456789-0"], 30000).rawDescriptor).toBe(
      "FUNDS TRANSFER OUT",
    );
  });

  it("keeps a business payee, which is a merchant", () => {
    expect(row("PayNow Transfer", ["TO SAMPLE PROPERTY PTE LTD"], 250000)).toEqual({
      kind: "charge",
      rawDescriptor: "PAYNOW TO SAMPLE PROPERTY PTE LTD",
    });
    expect(describeRow("PAYNOW TO SAMPLE PROPERTY PTE LTD").merchantName).toBe(
      "Sample Property Pte Ltd",
    );
  });

  it("recognises card bill payments by issuer, with the card number dropped", () => {
    expect(row("Bill Payment", ["DBS CARD CENTRE 4111111111111111"], 57323)).toEqual({
      kind: "card_payment",
      rawDescriptor: "CARD PAYMENT DBS CARD",
    });
    expect(row("GIRO", ["UOB CREDIT CARD"], 58535).rawDescriptor).toBe("CARD PAYMENT UOB CARD");
  });

  it("salary and interest are income; own-account transfers are transfers", () => {
    expect(row("GIRO - Salary", ["SAMPLE EMPLOYER PTE LTD"], -680000)).toEqual({
      kind: "income",
      rawDescriptor: "SALARY SAMPLE EMPLOYER PTE LTD",
    });
    expect(row("Interest Earned", [], -312)).toEqual({
      kind: "income",
      rawDescriptor: "INTEREST CREDIT",
    });
    expect(row("Funds Transfer", ["TO OWN ACCOUNT"], 150000)).toEqual({
      kind: "transfer",
      rawDescriptor: "TRANSFER TO OWN ACCOUNT",
    });
  });

  it("purchases keep the merchant without the type prefix; GIRO bills keep the payee", () => {
    expect(row("NETS QR", ["NETS QR SAMPLE HAWKER CENTRE", "REF 00012345678"], 680)).toEqual({
      kind: "charge",
      rawDescriptor: "SAMPLE HAWKER CENTRE",
    });
    expect(row("Point-of-Sale Transaction", ["FAIRPRICE XTRA - SAMPLE"], 4210).rawDescriptor).toBe(
      "FAIRPRICE XTRA - SAMPLE",
    );
    expect(describeRow("FAIRPRICE XTRA - SAMPLE").merchantName).toBe("FairPrice");
    expect(row("GIRO", ["SAMPLE TOWN COUNCIL"], 8240)).toEqual({
      kind: "charge",
      rawDescriptor: "SAMPLE TOWN COUNCIL",
    });
  });

  it("ATM withdrawals are cash; fees and reversals are recognised", () => {
    expect(row("ATM Cash Withdrawal", ["SAMPLE MALL BRANCH"], 20000)).toEqual({
      kind: "charge",
      rawDescriptor: "CASH WITHDRAWAL ATM",
    });
    expect(row("Service Charge", [], 200).kind).toBe("fee");
    expect(row("NETS Reversal", ["SAMPLE HAWKER CENTRE"], -680).kind).toBe("refund");
  });

  it("an unrecognised row keeps only its type line, never free-text details", () => {
    expect(row("Advice", ["JORDAN TAN", "SOME NOTE"], -5000)).toEqual({
      kind: "income",
      rawDescriptor: "ADVICE",
    });
  });
});
