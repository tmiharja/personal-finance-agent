/**
 * Structured logging that can't leak personal data: only numbers, booleans,
 * null and short code-like strings (e.g. "import.committed", "pii_violation")
 * are kept. Anything else (free text, descriptors, emails, error messages from
 * libraries or models) is replaced by "[dropped]".
 */

type Primitive = string | number | boolean | null | undefined;
export type LogFields = Record<string, Primitive | readonly Primitive[]>;

const CODE_LIKE = /^[A-Za-z0-9_.:\-/]{1,64}$/;
// A code that is really a long number (card, account, reference) is dropped too.
const DIGIT_RUN = /\d{6,}/;

function safe(value: Primitive): Primitive | "[dropped]" {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return CODE_LIKE.test(value) && !DIGIT_RUN.test(value) && !value.includes("@")
    ? value
    : "[dropped]";
}

export function sanitiseLogFields(fields: LogFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.map(safe) : safe(v as Primitive),
    ]),
  );
}

export function logEvent(event: string, fields: LogFields = {}): void {
  console.info(JSON.stringify({ event: safe(event), ...sanitiseLogFields(fields) }));
}

/** Logs an error by class and code only, never its message (which can carry data). */
export function logError(where: string, error: unknown): void {
  const errorClass = error instanceof Error ? error.name : "unknown";
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  console.error(
    JSON.stringify({ event: "error", ...sanitiseLogFields({ where, errorClass, code }) }),
  );
}
