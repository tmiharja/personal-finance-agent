# Personal Finance Agent (SG)

An agentic personal-finance web app for Singapore. You upload your own bank and credit-card statements, and it:

- categorises your spending;
- finds subscriptions, bills and unusual charges;
- answers questions such as *"What did I spend on dining in Q3?"*.

The agent can read your data but never changes anything on its own. Every write is a proposal that you approve first.

> **This repository is public. It must never contain personal data:** no real statements, names, addresses, card or account numbers, or emails. Test data is fully synthetic. See [`CLAUDE.md`](CLAUDE.md).

## What's here

| Path | What it is |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements |
| [`docs/architecture.md`](docs/architecture.md) | High-level architecture flow (diagram: [`docs/architecture.png`](docs/architecture.png)) |
| [`docs/statement-formats.md`](docs/statement-formats.md) | Parser spec for DBS and UOB credit-card statements |
| [`evals/fixtures/`](evals/fixtures/) | Synthetic statements (fictional person, test card numbers) for parser and detector evals |
| [`scripts/check-no-pii.mjs`](scripts/check-no-pii.mjs) | The PII guard that runs locally and in CI |

## Status

**Phase 0: foundations (done).**

| Area | What's in place |
|---|---|
| App | Next.js 16 App Router, TypeScript, Tailwind 4, Vercel `sin1` |
| Shell | Landing, sign-in, privacy and the `/app` screens. Uses the Resume Optimiser / portfolio design tokens, light and dark. Screenshots: [`docs/screenshots/phase-0/`](docs/screenshots/phase-0/) |
| Auth | Better Auth with email one-time codes and passkeys. Passwordless, no IP tracking, rate-limited, logs sanitised |
| Database | Drizzle + Postgres (Neon in production). Every user table has **Row-Level Security**: app queries run as `app_user` through `withUser()`. The audit log is append-only |
| Encryption | Per-user data keys wrapped by `MASTER_KEY` (AES-256-GCM). Ciphertexts are bound to user and field. HMAC dedupe keys. Master-key rotation |
| PII firewall | Sanitises descriptors, masks text for the LLM, and runs a last assertion before every write. The logger only keeps codes and numbers |
| Demo seed | 12 months of synthetic "Alex Tan" statements loaded through the real write path |
| Tests (Phase 0) | 59 unit/integration tests (two-user isolation, cross-user reference checks, encryption, firewall, no-PII harness over a full DB dump and logs, demo seed). 12 Playwright e2e tests (sign-in with a code, session enforcement, security headers), on desktop and mobile |

**Phase 1a: statement import (done).**

| Area | What's in place |
|---|---|
| Parsing | `src/server/ingest/`: in-memory pdf.js extraction with positions, and DBS + UOB credit-card parsers (`dbs-card-pdf@1`, `uob-card-pdf@1`) per [`docs/statement-formats.md`](docs/statement-formats.md). Year inference, FX lines, multi-card statements, and stop zones so rewards tables and payment slips are never read |
| Passwords | Owner-password PDFs open without a prompt. For open-password PDFs, the app asks; the password is used once and never stored or logged |
| Reconciliation | Per card (previous + Σ rows = total) and per statement (Σ cards = printed total). A mismatch needs an explicit "Import anyway" |
| Import flow | Upload → PII firewall + dedupe keys → encrypted preview (24 h) → `commit_import` proposal → **you approve** → ledger + audit log. Previews nobody approves are deleted by a daily cron. Re-uploads are detected; rows already imported from another file are marked duplicate and skipped |
| UI | Import page (drop zone, password prompt, preview card with per-card reconciliation and rows, Approve / Discard). Activity lists pending approvals and history. Screenshots: [`docs/screenshots/phase-1a/`](docs/screenshots/phase-1a/) |
| Tests | 34 parser golden tests (24 fixtures + 2 encrypted variants + rejections), 11 import-service tests (lifecycle, isolation, expiry, tampering, no PII in DB or logs), 8 new e2e tests. The real samples reconcile in a local-only, git-ignored test |

**Phase 1b: categorise → overview → ask, and the demo (done).**

| Area | What's in place |
|---|---|
| Categorisation | At import preview, before anything is saved: the row kind → your rules → a curated merchant map and keywords → the classifier's earlier decision for that merchant → **Claude Haiku 4.5** in batches of 50 merchants (masked input, output limited to your category names, with a confidence) → Uncategorised. Below 0.7 confidence is flagged for review. Without an API key it degrades to rules + map |
| Transactions | Server-paginated table with merchant search and category, card, date and "to review" filters. Descriptors are decrypted for the visible page only. Correct one row directly, or choose "all from this merchant": a `create_rule` **proposal** with a server-built preview ("56 × Dining → Health"), version-checked and audited on approval |
| Overview | Month at a glance: spend (charges + fees, refunds netted), refunds, cashback and card payments shown separately, spend by category (each bar links to its transactions), and a 12-month trend. Plain HTML/CSS, one navy hue, validated contrast in light and dark |
| Ask | A read-only Q&A agent on **Claude Sonnet 5.5** (adaptive thinking, low effort, cached prompt and tools, server-side refusal fallback). Eight typed tools over the same spend queries as Overview; periods resolved deterministically ("Q3" = last complete Q3). A **numbers guard** checks every figure in the answer against tool results (one retry, then the tool's own figures). Answers stream with a mini chart and a "View N transactions" link. Chat is kept in the tab only |
| Guardrails | Per-route models and prices in `src/server/llm/pricing.ts`; one usage row per call or question; a global monthly breaker (US$40), a per-user soft cap (US$3/month) and 60 questions/day |
| Demo | "Try the demo" opens a no-signup workspace with the fictional Alex Tan's 12 months. Imports are off, corrections and approvals work, and it's deleted after 24 hours by the daily cron. Limits per visitor per day are keyed by a daily-rotating HMAC of the IP, so no IP is stored |
| Tests | 173 unit/integration tests and 28 e2e tests (desktop + mobile) with an offline model (`LLM_MOCK=1`): categoriser, golden categories, transactions and rule proposals, spend definitions against fixture ground truth, period resolution, the numbers guard, the Ask loop, demo lifecycle, and the no-PII harness over every model request body. Screenshots: [`docs/screenshots/phase-1b/`](docs/screenshots/phase-1b/) |

**Phase 2a: detectors (done).**

| Area | What's in place |
|---|---|
| Detectors | Deterministic and idempotent. They run after every approval, after the demo seed and in the daily cron (`/api/cron/daily`). **Subscriptions:** weekly, monthly, quarterly or yearly charges at a steady price, with trial-to-paid and price-rise (>5%) detection; their status (active, overdue, possibly cancelled) is measured against each card's latest statement. **Bills:** recurring utilities, telco, insurance, town council and loan payments, plus card payment due dates. **Alerts:** unusual amount for a merchant, first charge at a new merchant (S$200+), possible duplicate (same amount on the same or the next date), foreign-currency charges with an FX fee estimate, card annual fees with GST, and card payments due in 3 days (or missed in the last week) with no payment seen. Open alerts refresh as their group grows (more foreign charges that month) and a due-date alert is retired once paid; alerts you dismissed are never rewritten. Every alert states its reason and links its transactions |
| Screens | Subscriptions (monthly total, price changes, "Not a subscription? Ignore"), Bills (card payments with paid/due/overdue, recurring bills), an Alerts inbox (Open and Dismissed/expected, with Dismiss, "This was expected" and Reopen), and "Coming up" tiles on Overview. Activity history names what each approval changed |
| Ask | Three more read-only tools: `get_subscriptions`, `get_bills`, `get_alerts` (11 in total) |
| Evaluation | A golden eval over the fixture household's planted events: **recall 17/17**; 18 of 20 detections are planted events and the other 2 are correct overdue-payment alerts (two cards due 2 Oct 2026 with no payment in the data). Edge cases: trials, price levels, coverage gaps, ignored subscriptions, idempotent re-runs |
| Tests | 192 unit/integration tests and 36 e2e tests (desktop + mobile). The no-PII harness now covers detector output too. Screenshots: [`docs/screenshots/phase-2a/`](docs/screenshots/phase-2a/) |

**Phase 2b: DBS/POSB and UOB bank accounts (done; parsers provisional).**

| Area | What's in place |
|---|---|
| Bank statements | POSB/DBS and UOB account statements as **PDF** or the bank's **CSV export** (UOB's XLS saved as CSV). Withdrawals, deposits and the running balance are read by column; each account reconciles `opening − Σ rows = closing`, and every printed running balance is checked. A PDF and the CSV of the same month produce identical rows, so importing both adds nothing. **The layouts are provisional**: built against synthetic statements in the banks' published formats, until real samples pass the local reconciliation test |
| Privacy | The account number is dropped with the header; the account's product name is its only identifier. **Other people's names never leave the parser**: a PayNow/FAST transfer to or from a person is stored as "PayNow transfer" (date and amount only); payments to businesses keep the business name. `check:pii` now rejects any CSV that isn't a marked synthetic fixture, and any spreadsheet |
| Transfer pairing | Money moving between your own accounts appears twice; both legs are paired and excluded from spend and income (PRD IMP-10). A bank's card bill payment pairs with the card's own payment row; a FAST transfer out of one account pairs with the same amount into another, within 3 days. Only unambiguous matches pair; the import preview says how many will, and the approval applies them. A bank payment made before its card statement is imported is still linked to the card, so the card shows **paid** (DET-7) |
| Income | Salary, interest and other money in. Overview shows Income next to Spent (refunds netted), plus the balance across your bank accounts; Ask's `spend_summary` returns income too, and its "Excludes…" note names transfers. An unmatched PayNow in is left for review: confirm it as income, or as a transfer between your own accounts |
| Evaluation | The fixture household now has a POSB and a UOB One account (salary, an own transfer each month, card bills paid from the bank, a town-council GIRO, ATM, NETS, PayNow). **60 of 60** planted card payments and transfers pair; detector **recall 19/19** (the bank-side town-council bill and a first-time PayNow payee included) |
| Tests | 269 unit/integration tests and 40 e2e tests (desktop + mobile): 48 bank fixtures parse exactly (PDF and CSV), the bank-row classifier, the pairing matcher, cross-bank pairing and CSV dedupe through the real import path, RLS on the new pair columns, and the no-PII dump with bank data. Screenshots: [`docs/screenshots/phase-2b/`](docs/screenshots/phase-2b/) |

**Phase 3a: the action engine (done).**

| Area | What's in place |
|---|---|
| Engine | One registry of allowed action types (PRD ACT-1): recategorise, mark as transfer, tag, create/update/delete a rule, dismiss an alert or mark it expected, ignore a subscription, set a budget, add/update a bill. Anything else is refused before it is stored. Each type validates its input with Zod, checks every id against your data under RLS, caps a change at 2,000 rows, and builds a **deterministic preview** from data (title, from → to counts, sample rows), never from model text (ACT-4, ACT-7) |
| Integrity | A proposal stores its payload hash and the versions of everything it touches. Approval locks those rows and executes exactly the previewed payload once; if anything changed, it goes stale instead. Proposals expire after 24 hours (ACT-6) |
| Undo | Every change stores its inverse (ids and previous values only). Undo is one click for 30 days, refused if anything it touched has changed since (so it never overwrites a newer decision), and is itself audited (ACT-9). Reopening an alert undoes the decision that closed it |
| Your own edits | "This transaction only", dismissing an alert and ignoring a subscription go through the same engine in one step: validated, audited and undoable |
| Activity | Pending changes as cards with **select all → Approve selected** (each applied or refused on its own, ACT-5), and a history of every change filtered by who (you, Ask, the app), change type and outcome, with Undo (ACT-8) |
| Ask | Eight **propose-only** tools (`propose_recategorise`, `propose_rule`, `propose_mark_transfer`, `propose_tag`, `propose_budget`, `propose_alert_decision`, `propose_ignore_subscription`, `propose_bill`). Each creates a pending proposal shown as a card under the answer; nothing changes until you approve it, and there is no tool that approves (ACT-10) |
| Tests | 294 unit/integration tests and 46 e2e tests (desktop + mobile). The **zero-unapproved-write test** proposes every action type, as Ask and as you, and checks a fingerprint of all your data is unchanged; others cover the allowlist, validation, staleness, expiry, a tampered payload, other users' ids, batch approval, undo (expiry, staleness, once only) and each type's execute/undo. Screenshots: [`docs/screenshots/phase-3a/`](docs/screenshots/phase-3a/) |

Not yet: a stale proposal isn't re-previewed automatically (you make the change again), cards have no Edit button, and a bulk change can't drop single rows before approval. Imports can't be undone yet.

**Phase 3b: budgets, Settings, drafts, export and the weekly digest (done).**

| Area | What's in place |
|---|---|
| Budgets | A monthly budget per spending category (PRD ASK-10), measured with the same spend definition as everything else. Overview shows each one as a bar with its status written out: over, likely to go over (the pace so far would pass it by month end), on track, or within. A month that isn't fully imported is judged on the days it covers, and says so. Ask's `get_budgets` answers "am I on track?" from the same figures. The demo household has four budgets |
| Settings | Cards and bank accounts (product names only), monthly budgets, rules (change the category, which moves the rows the rule categorised, or delete), export and "Delete my account and all data". Every edit goes through the action engine, so it's audited and undoable from Activity |
| Bills | Add a bill the statements don't show (payee, due day, usual amount), and change the ones you added. The daily run rolls each one on to its next due date |
| Export | `export_csv` downloads the Transactions filter (or everything) as CSV: sanitised descriptors, no card or account numbers, formula-injection safe. Recorded in Activity, never a pending proposal, and it needs a sign-in in the last 10 minutes (AUTH-3), like account deletion and approving any change to more than 100 transactions |
| Drafts | Text you copy and send yourself (ACT-2): an annual-fee waiver request from a card-fee alert, a dispute message from a possible duplicate, and how to cancel each subscription. Fixed templates over your data, with blanks for your name and card digits; nothing is ever sent. Ask's `get_draft` shows the same drafts under its answer |
| Weekly digest | "Last week" on Overview (DET-10): spend Monday to Sunday against the week before, where it went, new alerts, and what's due in the next 7 days. It checks each card's and account's statements: a week they don't all cover yet (or a gap from a missing statement) is marked as such instead of showing S$0 |
| Tests | 317 unit/integration tests and 54 e2e tests (desktop + mobile): budget progress and pace, `get_budgets`, CSV contents and injection, export audit, Settings, drafts, the digest week and coverage, and e2e for budgets, export, drafts and manual bills. Screenshots: [`docs/screenshots/phase-3b/`](docs/screenshots/phase-3b/) |

**Next: Phase 4 (polish and publish).** An LLM-fallback parser for layouts the deterministic parsers don't know, more banks (OCBC first), an admin page, and the portfolio write-up with eval results. Real DBS/POSB and UOB bank-account samples, when you have them, turn the provisional parsers into verified ones. See the PRD §12.

## Local development

You need Node 22 and a local Postgres 16. Everything else falls back to local defaults outside production.

```bash
npm install
cp .env.example .env.local      # then fill in the values below

# .env.local
DATABASE_URL=postgres://<user>@127.0.0.1:5432/finance
MASTER_KEY=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
DEV_MAIL_OUTBOX=1               # sign-in codes readable at /api/dev/outbox?email=…

npm run db:migrate              # roles, schema + RLS, grants
npm run seed:demo               # optional: fictional demo user (sign in as demo@example.com)
                                # or click "Try the demo" on the landing page
# Optional: ANTHROPIC_API_KEY=… for Haiku categorisation and Ask (or LLM_MOCK=1 to run offline)
npm run dev
```

The database role in `DATABASE_URL` should be the database owner with `CREATEROLE`, like Neon's default role. Migrations create the `app_user` role that every app query runs as.

| Command | What it does |
|---|---|
| `npm run check` | lint, typecheck, format check, unit/integration tests (in-process Postgres via PGlite) |
| `npm run test:e2e` | Playwright against a production build. Needs `E2E_DATABASE_URL` pointing at a migrated database |
| `npm run fixtures` | Regenerates the synthetic statements (deterministic) |
| `npm run check:pii` | Scans the repo for personal data. Runs in CI on every push |
| `npm run keys:rewrap` | Finishes a `MASTER_KEY` rotation (see below) |

## Deploying (Vercel)

1. Connect Neon (Singapore, `aws-ap-southeast-1`) through the Vercel Marketplace, then run `npm run db:migrate` against it.
2. Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MASTER_KEY`, `RESEND_API_KEY` and `EMAIL_FROM`. The app refuses to start in production without them. Also set `CRON_SECRET` (`openssl rand -hex 32`): the daily cron in `vercel.json` (`/api/cron/daily`) uses it to expire overdue previews and delete their encrypted data, and refuses to run without it.
3. `vercel.json` pins functions to `sin1`.

**Back up `MASTER_KEY` somewhere safe.** Without it, encrypted data can't be read.

**Rotating `MASTER_KEY`:**
1. Move the old value to `MASTER_KEY_PREVIOUS`, set a new `MASTER_KEY`, and increment `MASTER_KEY_ID`.
2. Deploy, then run `npm run keys:rewrap`. It re-wraps every user's key, including users who haven't been back since.
3. Remove `MASTER_KEY_PREVIOUS` only after it prints `remaining: 0`.
