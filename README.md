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

**Next: Phase 2.** OCBC cards, bank-account statements with transfer pairing, and the detectors (subscriptions, price rises, unusual charges, fees, bills). See the PRD §12.

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
