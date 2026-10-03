/** Labels for action types and who proposed them (client and server). */
export const ACTION_LABEL: Record<string, string> = {
  commit_import: "Import a statement",
  create_rule: "Create a rule",
  update_rule: "Change a rule",
  delete_rule: "Delete a rule",
  recategorise_transactions: "Recategorise",
  tag_transactions: "Tag transactions",
  mark_transfer: "Mark as transfer",
  dismiss_alert: "Dismiss an alert",
  mark_alert_expected: "Mark an alert expected",
  set_subscription_status: "Ignore or show a subscription",
  add_bill: "Add a bill",
  update_bill: "Change a bill",
  set_budget: "Set a budget",
};

export const PROPOSER_LABEL: Record<string, string> = {
  user: "You",
  agent: "Ask",
  detector: "Detectors",
  system: "The app",
};

export const STATE_LABEL: Record<string, string> = {
  done: "Done",
  undone: "Undone",
  discarded: "Discarded",
  expired: "Expired",
  failed: "Not applied",
};
