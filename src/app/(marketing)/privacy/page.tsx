import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

const SECTIONS: { h: string; p: string[] }[] = [
  {
    h: "What we collect",
    p: [
      "Your email address, to sign you in. Passkeys if you add them.",
      "From statements you upload: dates, amounts, currencies, merchant descriptions, the card's or account's product name, statement totals, balances and due dates.",
    ],
  },
  {
    h: "What we never store",
    p: [
      "Card numbers (not even the last four digits), cardholder names, addresses, bank account numbers, statement passwords or the files themselves. Files are read in memory and discarded. Sign-in IP addresses aren't stored either.",
      "To tell apart two cards or accounts with the same name, each number is turned into a one-way code with a key unique to you. The code can't be turned back into the number and is never shown.",
      "The names of people you pay or are paid by. A PayNow or FAST transfer to or from a person is kept as just “PayNow transfer”, with its date and amount; payments to businesses keep the business name.",
    ],
  },
  {
    h: "Where it lives",
    p: [
      "In Singapore (Vercel sin1; database in ap-southeast-1). Full transaction descriptions are encrypted with a key that is unique to you. A short merchant name (like “Grab”) is kept unencrypted so totals can be calculated.",
      "Some features send minimised, masked text (never card numbers, names or addresses) to Anthropic's Claude API, which processes it outside Singapore.",
    ],
  },
  {
    h: "Your control",
    p: [
      "Nothing in your data changes without your approval, and approved changes can be undone. You can export everything, or delete your account and all data at any time.",
    ],
  },
  {
    h: "Not financial advice",
    p: [
      "The app describes your past spending. It doesn't recommend financial products or move money.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main id="main" className="page-col flex-1 pt-36 pb-[72px]">
      <h1 className="text-[30px] font-medium tracking-tight">Privacy</h1>
      <p className="mt-3 text-[15px] text-muted">
        A plain-English summary. Draft for the Phase 4 launch; the full PDPA notice will replace it.
      </p>
      {SECTIONS.map((s) => (
        <section key={s.h} className="mt-10 border-t border-rule pt-6">
          <h2 className="text-[17px] font-semibold">{s.h}</h2>
          {s.p.map((t) => (
            <p key={t} className="mt-2 text-[15px] leading-relaxed text-muted">
              {t}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
