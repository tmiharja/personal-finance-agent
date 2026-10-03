import { describe, expect, it } from "vitest";
import { cancellationDraft, duplicateDisputeDraft, feeWaiverDraft } from "@/lib/drafts";

describe("drafts (ACT-2)", () => {
  it("a fee waiver request quotes the fee and leaves name and card digits blank", () => {
    const d = feeWaiverDraft({
      card: "DBS SAMPLE REWARDS CARD",
      feeCents: 19_620,
      gstCents: 1_766,
      kind: "Annual fee",
      date: "2026-05-14",
    });
    expect(d.title).toBe("Ask to waive the annual fee");
    expect(d.text).toContain(
      "I was charged S$196.20 plus GST of S$17.66 as the annual fee on my DBS Sample Rewards Card (card ending [last 4 digits]) on 14 May 2026.",
    );
    expect(d.text).toContain("[Your name]");
    expect(d.text).not.toMatch(/\d{4} ?\d{4}/);
  });

  it("a duplicate dispute names both dates and the amount", () => {
    const d = duplicateDisputeDraft({
      merchant: "Lazada",
      amountCents: 8_990,
      dates: ["2026-07-03", "2026-07-04"],
    });
    expect(d.text).toContain(
      "I was charged S$89.90 by Lazada on 3 Jul 2026 and 4 Jul 2026, for what I believe is a single purchase.",
    );
    expect(
      duplicateDisputeDraft({
        merchant: "Lazada",
        amountCents: 8_990,
        dates: ["2026-07-03", "2026-07-03"],
      }).text,
    ).toContain("twice on 3 Jul 2026");
  });

  it("cancellation steps say when to cancel by", () => {
    const d = cancellationDraft({
      merchant: "Spotify",
      cadence: "monthly",
      amountCents: 1_198,
      nextExpectedDate: "2026-10-12",
    });
    expect(d.title).toBe("How to cancel Spotify");
    expect(d.text).toContain("Spotify (S$11.98 a month)");
    expect(d.text).toContain("Cancel before 12 Oct 2026 to avoid the next charge.");
  });
});
