import { extractLines } from "../pdf";
import { isDbsCard, parseDbsCard } from "./dbs-card";
import { ParseError, parsedStatementSchema, type ParseResult } from "./types";
import { isUobCard, parseUobCard } from "./uob-card";

export { ParseError } from "./types";
export type { ParsedCard, ParsedRow, ParsedStatement, ParseResult } from "./types";

const PARSERS = [
  { detect: isDbsCard, parse: parseDbsCard },
  { detect: isUobCard, parse: parseUobCard },
] as const;

/**
 * PDF bytes → parsed card statement. Deterministic, in memory. The output is
 * validated against the strict schema, so no unexpected field can leave here.
 */
export async function parseStatementPdf(
  bytes: Uint8Array,
  opts: { password?: string } = {},
): Promise<ParseResult> {
  const { lines } = await extractLines(bytes, opts);
  const parser = PARSERS.find((p) => p.detect(lines));
  if (!parser) throw new ParseError("unsupported_format");
  const result = parser.parse(lines);
  const checked = parsedStatementSchema.safeParse(result.statement);
  if (!checked.success) throw new ParseError("invalid_output");
  return { statement: checked.data, names: result.names };
}
