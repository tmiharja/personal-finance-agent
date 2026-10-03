import { extractLines } from "../pdf";
import { isDbsAccount, isUobAccount, parseDbsAccount, parseUobAccount } from "./bank-pdf";
import { parseDbsCsv, parseUobCsv, sniffCsv } from "./bank-csv";
import { isDbsCard, parseDbsCard } from "./dbs-card";
import { ParseError, parsedStatementSchema, type ParseResult } from "./types";
import { isUobCard, parseUobCard } from "./uob-card";

export { ParseError } from "./types";
export type { ParsedCard, ParsedRow, ParsedStatement, ParseResult } from "./types";

const PARSERS = [
  { detect: isDbsCard, parse: parseDbsCard },
  { detect: isUobCard, parse: parseUobCard },
  { detect: isDbsAccount, parse: parseDbsAccount },
  { detect: isUobAccount, parse: parseUobAccount },
] as const;

/** The output is validated against the strict schema, so no unexpected field can leave here. */
function checked(result: ParseResult): ParseResult {
  const ok = parsedStatementSchema.safeParse(result.statement);
  if (!ok.success) throw new ParseError("invalid_output");
  return { statement: ok.data, names: result.names, accountRefs: result.accountRefs ?? [] };
}

/** PDF bytes → parsed card or bank-account statement. Deterministic, in memory. */
export async function parseStatementPdf(
  bytes: Uint8Array,
  opts: { password?: string } = {},
): Promise<ParseResult> {
  const { lines } = await extractLines(bytes, opts);
  const parser = PARSERS.find((p) => p.detect(lines));
  if (!parser) throw new ParseError("unsupported_format");
  return checked(parser.parse(lines));
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

export const isPdf = (bytes: Uint8Array) => PDF_MAGIC.every((b, i) => bytes[i] === b);

/** CSV bytes (UTF-8, optional BOM) → a parsed bank-account statement. */
export function parseStatementCsv(bytes: Uint8Array): ParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new ParseError("unsupported_format");
  }
  const bank = sniffCsv(text);
  if (bank === "DBS") return checked(parseDbsCsv(text));
  if (bank === "UOB") return checked(parseUobCsv(text));
  throw new ParseError("unsupported_format");
}

/** Any supported upload: PDF by its magic bytes, otherwise CSV. */
export async function parseStatementFile(
  bytes: Uint8Array,
  opts: { password?: string } = {},
): Promise<ParseResult> {
  return isPdf(bytes) ? parseStatementPdf(bytes, opts) : parseStatementCsv(bytes);
}
