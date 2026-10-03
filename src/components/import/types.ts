import type { ImportPreview } from "@/server/import/service";

export type { ImportPreview };
export type CommitResult = {
  inserted: number;
  duplicates: number;
  cards: number;
  allReconciled: boolean;
};

/** Plain-English messages for every error code the import API returns. */
export const IMPORT_ERRORS: Record<string, string> = {
  password_incorrect: "That password didn't open the file. Try again.",
  unsupported_format:
    "This doesn't look like a DBS or UOB credit-card statement. Those are supported first.",
  no_cards: "We couldn't find any card sections in this statement.",
  no_statement_date: "We couldn't find the statement date in this file.",
  invalid_output: "We couldn't read this statement reliably, so nothing was imported.",
  no_text:
    "This PDF has no text layer (it may be a scan). Download the e-statement PDF from your bank instead.",
  too_many_pages: "This PDF has more than 30 pages. Statements are usually much shorter.",
  unreadable: "This file couldn't be opened as a PDF.",
  not_pdf: "Only PDF statements are supported for now.",
  too_large: "This file is over 4 MB. Statements are usually much smaller.",
  already_imported: "You've already imported this file.",
  rate_limited: "You've reached the import limit for now (40 files per 30 days).",
  pii_blocked:
    "We stopped this import because a field still looked like personal data after cleaning. Nothing was saved.",
  proposal_expired: "This preview expired after 24 hours. Upload the file again.",
  proposal_not_pending: "This import was already approved or discarded.",
  proposal_not_found: "This import no longer exists.",
  preview_tampered:
    "This preview changed after it was created, so it wasn't imported. Upload the file again.",
  unauthenticated: "Your session ended. Sign in again.",
};

export const errorMessage = (code: string) =>
  IMPORT_ERRORS[code] ?? "Something went wrong. Nothing was imported.";
