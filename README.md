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

```bash
npm install
npm run fixtures    # regenerate synthetic statements
npm run check:pii   # scan the repo for personal data
```
