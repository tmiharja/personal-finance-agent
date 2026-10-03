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
| Tests | 59 unit/integration tests (two-user isolation, cross-user reference checks, encryption, firewall, no-PII harness over a full DB dump and logs, demo seed). 12 Playwright e2e tests (sign-in with a code, session enforcement, security headers), on desktop and mobile |

**Next: Phase 1.** DBS and UOB card PDF parsers, import preview and approval, categorisation, Transactions and Ask (see the PRD §12).

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
2. Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MASTER_KEY`, `RESEND_API_KEY` and `EMAIL_FROM`. The app refuses to start in production without them.
3. `vercel.json` pins functions to `sin1`.

**Back up `MASTER_KEY` somewhere safe.** Without it, encrypted data can't be read.

**Rotating `MASTER_KEY`:**
1. Move the old value to `MASTER_KEY_PREVIOUS`, set a new `MASTER_KEY`, and increment `MASTER_KEY_ID`.
2. Deploy, then run `npm run keys:rewrap`. It re-wraps every user's key, including users who haven't been back since.
3. Remove `MASTER_KEY_PREVIOUS` only after it prints `remaining: 0`.
