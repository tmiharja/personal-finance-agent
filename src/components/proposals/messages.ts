/** Plain-English messages for proposal and correction error codes. */
const MESSAGES: Record<string, string> = {
  proposal_not_found: "This suggestion no longer exists.",
  proposal_not_pending: "This was already approved or discarded.",
  proposal_expired: "This suggestion expired after 24 hours. Make the change again.",
  proposal_stale:
    "Some of these transactions changed since this was suggested, so nothing was applied. Make the change again.",
  invalid_category: "That category can't be used here.",
  too_many_rows: "That would change more than 2,000 transactions at once.",
  not_categorisable:
    "Card payments, fees, cashback and matched transfers keep their own categories.",
  transaction_not_found: "That transaction no longer exists.",
  invalid_reference: "Something this refers to no longer exists.",
  invalid_input: "That change isn't valid.",
  action_not_allowed: "That kind of change isn't allowed.",
  nothing_to_change: "Nothing would change.",
  not_undoable: "This change can't be undone.",
  already_undone: "This was already undone.",
  undo_expired: "Changes can be undone for 30 days; this one is older.",
  undo_stale:
    "Something this change touched has changed since, so undoing it would overwrite a newer decision. Nothing changed.",
  unauthenticated: "Your session ended. Sign in again.",
};

export const proposalErrorMessage = (code: string) =>
  MESSAGES[code] ?? "Something went wrong. Nothing changed.";
