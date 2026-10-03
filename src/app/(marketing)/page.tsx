import Link from "next/link";
import Hero from "@/components/hero";
import Reveal from "@/components/reveal";
import { buttonVariants } from "@/components/ui/button";

const STEPS = [
  {
    title: "Upload your statements",
    body: "DBS and UOB credit-card PDFs to start. Files are read in memory and discarded; card numbers, names and addresses are never stored.",
  },
  {
    title: "Review what we found",
    body: "Every statement is reconciled against its printed totals. Spending is categorised, and subscriptions, bills, fees and unusual charges are flagged with a plain reason.",
  },
  {
    title: "Ask, and approve",
    body: "Ask things like “what did I spend on dining in Q3?”. Answers come from your data, with the transactions behind them. Any change is a proposal you approve first.",
  },
];

const PROMISES = [
  "Read-only towards your bank: no logins, no payments, ever",
  "Nothing changes without your approval, and everything can be undone",
  "Hosted in Singapore; sensitive fields encrypted with a key per user",
  "Card numbers, names and addresses are never stored",
  "Delete everything with one click",
];

export default function Landing() {
  return (
    <main id="main" className="flex-1">
      <Hero>
        <h1
          id="hero-heading"
          className="text-[36px] leading-[1.1] font-medium tracking-tight sm:text-[48px]"
        >
          Know where your money goes.
        </h1>
        <p className="mt-4 max-w-[560px] text-[17px] text-muted">
          Your Singapore bank and card statements, reconciled, categorised and explained. It finds
          the leaks and answers your questions, and never acts without asking.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href="/login" className={buttonVariants()}>
            Sign in or create an account
          </Link>
          <span className="text-[13px] text-muted">Demo with fictional data: coming soon</span>
        </div>
      </Hero>

      <div className="page-col">
        <section id="how-it-works" aria-labelledby="how-heading" className="pt-[72px]">
          <Reveal>
            <h2 id="how-heading" className="text-[24px] font-semibold tracking-tight">
              How it works
            </h2>
            <ol className="mt-6">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-5 border-t border-rule py-5">
                  <span className="tabular w-5 shrink-0 text-[15px] text-muted">{i + 1}</span>
                  <div>
                    <h3 className="text-[17px] font-medium">{s.title}</h3>
                    <p className="mt-1 text-[15px] text-muted">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>
        </section>

        <section aria-labelledby="control-heading" className="py-[72px]">
          <Reveal>
            <h2 id="control-heading" className="text-[24px] font-semibold tracking-tight">
              You stay in control
            </h2>
            <ul className="mt-6">
              {PROMISES.map((p) => (
                <li key={p} className="border-t border-rule py-4 text-[15px]">
                  {p}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[13px] text-muted">
              Descriptive only, not financial advice. Read the{" "}
              <Link href="/privacy" className="link">
                privacy notice
              </Link>
              .
            </p>
          </Reveal>
        </section>
      </div>
    </main>
  );
}
