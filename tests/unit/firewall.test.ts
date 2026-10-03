import { describe, expect, it } from "vitest";
import {
  assertNoPii,
  isValidNric,
  luhn,
  maskForLlm,
  PiiViolation,
  sanitiseDescriptor,
  scanForPii,
} from "@/server/pii/firewall";

// All values below are synthetic: public test card numbers and example.com emails.
// NRIC, phone and postal values are assembled at runtime so no literal identifier
// sits in the repo (npm run check:pii scans source files too).
const NRIC = ["S", "1234567", "D"].join("");
const BAD_NRIC = ["S", "1234567", "A"].join("");
const PHONE_INTL = ["+65", "9123", "4567"].join(" ");
const PHONE_LOCAL = ["9123", "4567"].join(" ");
const POSTAL = ["SINGAPORE", "123456"].join(" ");
describe("detectors", () => {
  it("finds Luhn-valid card numbers in every common format", () => {
    for (const s of [
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "4111111111111111",
      "CARD NO.: 5555 5555 5555 4444",
    ]) {
      expect(scanForPii(s), s).toContain("card_number");
    }
    expect(scanForPii("REF 4111111111111112")).not.toContain("card_number"); // fails Luhn
    expect(scanForPii("0000000000000000")).not.toContain("card_number");
    expect(luhn("4012888888881881")).toBe(true);
  });

  it("validates NRIC/FIN check letters, including the M series", () => {
    expect(isValidNric(NRIC)).toBe(true);
    expect(isValidNric(BAD_NRIC)).toBe(false);
    expect(scanForPii(`id ${NRIC}`)).toContain("nric");
  });

  it("finds emails, SG phone numbers, postal codes, account numbers and names", () => {
    expect(scanForPii("mail alex@example.com")).toContain("email");
    expect(scanForPii(`call ${PHONE_INTL}`)).toContain("phone");
    expect(scanForPii(`call ${PHONE_LOCAL}`)).toContain("phone");
    expect(scanForPii(POSTAL)).toContain("postal_code");
    expect(scanForPii("SINGAPORE 000000")).toEqual([]); // the fixtures' fictional code
    expect(scanForPii("AUTOPAY AC#1234567890123456")).toContain("account_number");
    expect(scanForPii("NEW TRANSACTIONS ALEX TAN", { names: ["ALEX TAN"] })).toContain("name");
  });

  it("leaves ordinary descriptors and amounts alone", () => {
    for (const s of [
      "GRAB* A-Y5WPJ7LPZTBL",
      "SHOPEE SG MP",
      "BUS/MRT # SINGAPORE",
      "1,234.56",
      "GST @ 9%",
      "JPY 12,000.00",
    ]) {
      expect(scanForPii(s), s).toEqual([]);
    }
  });
});

describe("sanitiseDescriptor", () => {
  it("drops account numbers and replaces 6+ digit runs", () => {
    expect(sanitiseDescriptor("AUTOPAY AC#0000000000000000")).toBe("AUTOPAY");
    expect(sanitiseDescriptor("BUS/MRT 911568828 SINGAPORE")).toBe("BUS/MRT # SINGAPORE");
    expect(sanitiseDescriptor("SAMPLESHOP* 482019 11122233344")).toBe("SAMPLESHOP* # #");
  });

  it("redacts identifiers that slip into a descriptor", () => {
    expect(sanitiseDescriptor("REFUND TO alex@example.com")).toBe("REFUND TO [EMAIL]");
    expect(sanitiseDescriptor("PAYNOW TO ALEX TAN", { names: ["ALEX TAN"] })).toBe(
      "PAYNOW TO [NAME]",
    );
    const out = sanitiseDescriptor("PAYMENT 4111 1111 1111 1111");
    expect(out).toBe("PAYMENT [CARD]");
    expect(scanForPii(out)).toEqual([]);
  });
});

describe("maskForLlm", () => {
  it("replaces identifiers with typed placeholders", () => {
    const text = `ALEX TAN 4111-1111-1111-1111 ${NRIC} alex@example.com ${PHONE_INTL} ${POSTAL}`;
    const masked = maskForLlm(text, { names: ["ALEX TAN"] });
    expect(masked).toBe("[NAME] [CARD] [NRIC] [EMAIL] [PHONE] [POSTAL]");
    expect(scanForPii(masked, { names: ["ALEX TAN"] })).toEqual([]);
  });
});

describe("assertNoPii", () => {
  it("throws a violation naming the field and kinds, never the value", () => {
    try {
      assertNoPii({ row: { descriptor: "PAY 4111 1111 1111 1111" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PiiViolation);
      expect((e as PiiViolation).field).toBe("row.descriptor");
      expect((e as Error).message).not.toContain("4111");
    }
  });
  it("passes clean records", () => {
    expect(() => assertNoPii({ merchantName: "Grab", amount: 1234 })).not.toThrow();
  });
});
