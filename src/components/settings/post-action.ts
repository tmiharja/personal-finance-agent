import { proposalErrorMessage } from "@/components/proposals/messages";

/** Applies one of your own edits through the action engine; returns an error message or null. */
export async function postAction(type: string, input: unknown): Promise<string | null> {
  try {
    const res = await fetch("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, input }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return proposalErrorMessage(body.error ?? "");
  } catch {
    return proposalErrorMessage("");
  }
}

/** "1,234.50" or "1234.5" → cents; null if it isn't an amount. */
export function parseSgd(text: string): number | null {
  const t = text.replace(/[S$,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
