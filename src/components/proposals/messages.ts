/** Plain-English messages for proposal and correction error codes. */
const MESSAGES: Record<string, string> = {
  proposal_not_found: "This suggestion no longer exists.",
  proposal_not_pending: "This was already approved or discarded.",
  proposal_expired: "This suggestion expired after 24 hours. Make the change again.",
  proposal_stale:
    "Some of these transactions changed since this was suggested, so nothing was applied. Make the change again.",
  invalid_category: "That category can't be used here.",
  too_many_rows: "That would change more than 2,000 transactions at once.",
  not_categorisable: "Card payments, fees and cashback keep their own categories.",
  transaction_not_found: "That transaction no longer exists.",
  unauthenticated: "Your session ended. Sign in again.",
};

export const proposalErrorMessage = (code: string) =>
  MESSAGES[code] ?? "Something went wrong. Nothing changed.";
