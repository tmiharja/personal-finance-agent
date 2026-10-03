import { getDocumentProxy } from "unpdf";

/**
 * In-memory PDF text extraction (pdf.js via unpdf). Nothing is written to disk
 * and the password, if any, lives only for this call.
 *
 * Output is a list of visual lines: text items on the same baseline (±2pt),
 * left to right, with their x positions so parsers can find right-aligned
 * amount columns. Rotated text is ignored.
 */

export const MAX_PAGES = 30;

export type LineItem = { x: number; width: number; str: string };
export type Line = {
  page: number;
  y: number;
  pageWidth: number;
  items: LineItem[];
  /** Items joined: one space for a small gap, two for a column gap. */
  text: string;
};

export type PdfErrorCode =
  "password_required" | "password_incorrect" | "too_many_pages" | "no_text" | "unreadable";

export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(`PDF error: ${code}`);
    this.name = "PdfError";
  }
}

const LINE_TOLERANCE = 2;
const COLUMN_GAP = 8;

export function joinItems(items: LineItem[]): string {
  let out = "";
  let end = -Infinity;
  for (const it of items) {
    const gap = it.x - end;
    if (out)
      out +=
        gap > COLUMN_GAP
          ? "  "
          : gap > 1 && !out.endsWith(" ") && !it.str.startsWith(" ")
            ? " "
            : "";
    out += it.str;
    end = it.x + it.width;
  }
  return out.replace(/[ \t]+$/g, "").trim();
}

export async function extractLines(
  bytes: Uint8Array,
  opts: { password?: string } = {},
): Promise<{ pageCount: number; lines: Line[] }> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy: pdf.js may transfer (detach) the buffer it is given.
    pdf = await getDocumentProxy(
      new Uint8Array(bytes),
      opts.password ? { password: opts.password } : {},
    );
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") {
      throw new PdfError(err.code === 2 ? "password_incorrect" : "password_required");
    }
    throw new PdfError("unreadable");
  }
  if (pdf.numPages > MAX_PAGES) throw new PdfError("too_many_pages");

  const lines: Line[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const pageWidth = page.view[2]! - page.view[0]!;
    const content = await page.getTextContent();
    const items: (LineItem & { y: number })[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || !raw.str.trim()) continue;
      const t = raw.transform as number[];
      if (Math.abs(t[1] ?? 0) > 0.01 || Math.abs(t[2] ?? 0) > 0.01) continue; // rotated
      items.push({ x: t[4]!, y: t[5]!, width: raw.width, str: raw.str });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let current: (LineItem & { y: number })[] = [];
    const flush = () => {
      if (!current.length) return;
      current.sort((a, b) => a.x - b.x);
      const lineItems = current.map(({ x, width, str }) => ({ x, width, str }));
      lines.push({
        page: p,
        y: current[0]!.y,
        pageWidth,
        items: lineItems,
        text: joinItems(lineItems),
      });
      current = [];
    };
    for (const it of items) {
      if (current.length && Math.abs(current[0]!.y - it.y) > LINE_TOLERANCE) flush();
      current.push(it);
    }
    flush();
  }
  if (!lines.length) throw new PdfError("no_text");
  return { pageCount: pdf.numPages, lines };
}
