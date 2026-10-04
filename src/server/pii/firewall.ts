/**
 * PII firewall (PRD §7.1a). Runs on every string before it is stored, sent to an
 * LLM or logged. Three operations:
 *
 *   sanitiseDescriptor(raw)  what a stored transaction descriptor may contain
 *   maskForLlm(text, ctx)    what may leave Singapore in an LLM request
 *   assertNoPii(record, ctx) last check before a write; throws PiiViolation
 *
 * Detectors are deterministic. Findings carry a code and a field name only,
 * never the matched value, so they are safe to log and to show in errors.
 */

export type PiiCode =
  "card_number" | "nric" | "email" | "phone" | "postal_code" | "account_number" | "name";

export type PiiContext = {
  /** Cardholder names seen in the current upload. Held in memory only, never stored. */
  names?: readonly string[];
};

// ------------------------------------------------------------------ detectors

const NRIC_PATTERN = /\b([STFGM])(\d{7})([A-Z])\b/g;
const WEIGHTS = [2, 7, 6, 5, 4, 3, 2] as const;

/** NRIC/FIN check letter (S/T citizens and PRs, F/G/M foreigners). */
export function isValidNric(value: string): boolean {
  const match = /^([STFGM])(\d{7})([A-Z])$/.exec(value.toUpperCase());
  if (!match) return false;
  const [, prefix, digits, check] = match as unknown as [string, string, string, string];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * WEIGHTS[i]!;
  if (prefix === "T" || prefix === "G") sum += 4;
  if (prefix === "M") sum += 3;
  const r = sum % 11;
  const expected =
    prefix === "S" || prefix === "T"
      ? "JZIHGFEDCBA"[r]
      : prefix === "F" || prefix === "G"
        ? "XWUTRQPNMLK"[r]
        : "KLJNPQRTUWX"[10 - r];
  return check === expected;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

// 13–19 digits, optionally grouped by single spaces or dashes.
const CARD_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// +65 numbers, and 8-digit SG numbers starting 6/8/9 written as "9123 4567" / "9123-4567".
const PHONE = /(?:\+65[\s-]?[3689]\d{3}[\s-]?\d{4})|(?<![\d.,])[689]\d{3}[\s-]\d{4}(?![\d.,])/g;
// "SINGAPORE" or "S(" / "S " followed by a six-digit postal code.
const POSTAL = /\b(?:SINGAPORE\s*|S\s?\(?)(\d{6})\)?(?!\d)/gi;
// Account numbers in payment rows: "AC#1234…", "A/C 123-456-789", "account 1234567890".
const ACCOUNT = /\b(?:AC#|A\/C\s*(?:NO\.?)?\s*|ACCOUNT\s*(?:NO\.?)?\s*)[\d-]{6,}/gi;

function cardNumbers(text: string): RegExpMatchArray[] {
  return [...text.matchAll(CARD_CANDIDATE)].filter((m) => {
    const d = m[0].replace(/[ -]/g, "");
    return d.length >= 13 && d.length <= 19 && !/^0+$/.test(d) && luhn(d);
  });
}

/** The distinct card numbers in a text, as digits, in order of appearance. In memory only. */
export function findCardNumbers(text: string): string[] {
  return [...new Set(cardNumbers(text).map((m) => m[0].replace(/[ -]/g, "")))];
}

function nameTokens(ctx: PiiContext): string[] {
  return (ctx.names ?? []).map((n) => n.trim()).filter((n) => n.length >= 3);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which kinds of PII the text contains (codes only). */
export function scanForPii(text: string, ctx: PiiContext = {}): PiiCode[] {
  const found = new Set<PiiCode>();
  if (cardNumbers(text).length) found.add("card_number");
  for (const m of text.toUpperCase().matchAll(NRIC_PATTERN))
    if (isValidNric(m[0])) found.add("nric");
  if (new RegExp(EMAIL.source).test(text)) found.add("email");
  if (new RegExp(PHONE.source).test(text)) found.add("phone");
  for (const m of text.matchAll(POSTAL)) if (m[1] !== "000000") found.add("postal_code");
  if (new RegExp(ACCOUNT.source, "i").test(text)) found.add("account_number");
  for (const n of nameTokens(ctx)) {
    if (new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(text)) found.add("name");
  }
  return [...found];
}

// ------------------------------------------------------------------ transforms

/** Replaces every detected identifier with a typed placeholder. */
function redact(text: string, ctx: PiiContext): string {
  let out = text;
  for (const n of nameTokens(ctx))
    out = out.replace(new RegExp(`\\b${escapeRe(n)}\\b`, "gi"), "[NAME]");
  out = out.replace(ACCOUNT, "[ACCOUNT]");
  for (const m of cardNumbers(out)) out = out.replace(m[0], "[CARD]");
  out = out.replace(NRIC_PATTERN, (m) => (isValidNric(m) ? "[NRIC]" : m));
  out = out.replace(EMAIL, "[EMAIL]");
  out = out.replace(PHONE, "[PHONE]");
  out = out.replace(POSTAL, (m, code: string) => (code === "000000" ? m : "[POSTAL]"));
  return out;
}

/**
 * What a stored descriptor may contain: no account numbers, no identifiers, and
 * every run of 6+ digits (transit trip ids, merchant ids, phone numbers) → "#".
 */
export function sanitiseDescriptor(raw: string, ctx: PiiContext = {}): string {
  const noAccount = raw.replace(/\bAC#\d+/gi, " ");
  return redact(noAccount, ctx)
    .replace(/\d{6,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text that may be sent to an LLM: identifiers replaced by typed placeholders. */
export function maskForLlm(text: string, ctx: PiiContext = {}): string {
  return redact(text, ctx);
}

// ------------------------------------------------------------------ guard

export class PiiViolation extends Error {
  constructor(
    readonly field: string,
    readonly codes: PiiCode[],
  ) {
    // Names the field and the kinds of data only: safe for logs and errors.
    super(`PII detected in field "${field}": ${codes.join(", ")}`);
    this.name = "PiiViolation";
  }
}

/** Throws if any string value in the record (searched recursively) contains PII. */
export function assertNoPii(
  record: Record<string, unknown>,
  ctx: PiiContext = {},
  path = "",
): void {
  for (const [key, value] of Object.entries(record)) {
    const field = path ? `${path}.${key}` : key;
    if (typeof value === "string") {
      const codes = scanForPii(value, ctx);
      if (codes.length) throw new PiiViolation(field, codes);
    } else if (value && typeof value === "object" && !(value instanceof Date)) {
      assertNoPii(value as Record<string, unknown>, ctx, field);
    }
  }
}
