import { longDate, money, titleCase } from "./format";

/**
 * Drafts (PRD ACT-2): text for you to copy and send yourself. Built from fixed
 * templates and your data, never from model text; never sent, and they change
 * nothing, so they need no approval. Your name and card number aren't known
 * to the app, so they're left as blanks for you to fill in.
 */

export type Draft = { title: string; text: string };

const SIGN_OFF = "Thank you.\n\n[Your name]";

export function feeWaiverDraft(a: {
  card: string;
  feeCents: number;
  gstCents: number;
  kind: string;
  date: string;
}): Draft {
  const card = titleCase(a.card);
  const fee = a.kind.toLowerCase() || "annual fee";
  return {
    title: `Ask to waive the ${fee}`,
    text: [
      `Subject: Request to waive the ${fee} on my ${card}`,
      "",
      "Hello,",
      "",
      `I was charged ${money(a.feeCents)}${a.gstCents ? ` plus GST of ${money(a.gstCents)}` : ""} as the ${fee} on my ${card} (card ending [last 4 digits]) on ${longDate(a.date)}.`,
      "",
      "I have been a loyal cardmember and would like to keep using the card. Could you please waive this fee and reverse the charge?",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function duplicateDisputeDraft(a: {
  merchant: string;
  amountCents: number;
  dates: string[];
}): Draft {
  const when =
    a.dates.length > 1 && a.dates[0] !== a.dates[1]
      ? `on ${longDate(a.dates[0]!)} and ${longDate(a.dates[1]!)}`
      : `twice on ${longDate(a.dates[0]!)}`;
  return {
    title: `Dispute a duplicate charge at ${a.merchant}`,
    text: [
      `Subject: Duplicate charge of ${money(a.amountCents)} at ${a.merchant}`,
      "",
      "Hello,",
      "",
      `I was charged ${money(a.amountCents)} by ${a.merchant} ${when}, for what I believe is a single purchase.`,
      "",
      "Please reverse the duplicate charge. If you need more details, such as a receipt or order number, I can provide them.",
      "",
      "Card: [card name and last 4 digits]",
      "",
      SIGN_OFF,
      "",
      "(Send this to the merchant first. If they don't respond, your card issuer can raise a dispute.)",
    ].join("\n"),
  };
}

const PER: Record<string, string> = {
  weekly: "a week",
  monthly: "a month",
  quarterly: "a quarter",
  annual: "a year",
};

export function cancellationDraft(s: {
  merchant: string;
  cadence: string;
  amountCents: number;
  nextExpectedDate: string | null;
}): Draft {
  return {
    title: `How to cancel ${s.merchant}`,
    text: [
      `Cancelling ${s.merchant} (${money(s.amountCents)} ${PER[s.cadence] ?? "each period"})`,
      "",
      `1. Sign in to your ${s.merchant} account on its website or app (not through a link in an email).`,
      "2. Find Account, Billing, Membership or Subscription, and choose Cancel. If you subscribed through the App Store or Google Play, cancel it there instead.",
      `3. Save the confirmation email or a screenshot.${s.nextExpectedDate ? ` Cancel before ${longDate(s.nextExpectedDate)} to avoid the next charge.` : ""}`,
      "4. Check your next statement: if you're still charged, send them the confirmation and ask for a refund.",
      "",
      "If you can't find a way to cancel, message their support:",
      "",
      `"Please cancel my ${s.merchant} subscription with immediate effect and confirm in writing. Account email: [your email]."`,
    ].join("\n"),
  };
}
