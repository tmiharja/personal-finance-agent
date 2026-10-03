# Synthetic statements (training and eval data)

[`synthetic/`](synthetic/) holds **fully synthetic** DBS and UOB credit-card statements. They're used for parser tests, detector evals, categorisation evals and the demo workspace. Nothing in them comes from a real person:

| Data | What the fixtures use |
|---|---|
| Person | "Alex Tan", supplementary cardholder "Jordan Tan" (fictional) |
| Address | `10 EXAMPLE AVENUE, #01-01 SAMPLE RESIDENCES, SINGAPORE 000000` (000000 isn't a real postal code) |
| Card numbers | Public test numbers (`4111 1111 1111 1111`, `5555 5555 5555 4444`, `4012-8888-8888-1881`, `4000-0566-5566-5556`), never issued to anyone |
| Bank account | All zeros |
| Card products | `DBS SAMPLE VISA SIGNATURE`, `DBS SAMPLE WORLD MASTERCARD`, `UOB SAMPLE CASHBACK`, `UOB SAMPLE MILES VISA CARD` (fictional) |
| Merchants, amounts, dates | Generated from a fixed seed; "SAMPLE …" merchants are fictional |
| Watermark | Every page has a red "SYNTHETIC TEST DATA" banner (top and bottom), grey vector hatching, and a footer watermark. The PDF Subject metadata says `SYNTHETIC TEST DATA` (`npm run check:pii` verifies this) |

The layouts follow [`docs/statement-formats.md`](../../docs/statement-formats.md). They reproduce the line structure the parsers depend on, not the banks' branding.

## Contents

- `dbs/2025-10.pdf … 2026-09.pdf`: 12 monthly DBS statements, each with 2 cards
- `uob/2025-10.pdf … 2026-09.pdf`: 12 monthly UOB statements, each with 2 cards (one card name wraps in the summary table)
- `*.expected.json`: the exact parse result per PDF, following the output contract in `statement-formats.md` §3, plus `rawDescriptor`, `expectedCategory` and `supplementary` for evals
- `ledger.json`: the events planted in the data, which detector evals should find

In total there are 24 statements and 885 rows. Every card section reconciles: previous balance + Σ rows = total.

## Planted events

| Event | Where |
|---|---|
| Monthly subscriptions | Netflix, Spotify, Apple (DBS Visa); gym, a USD course subscription whose SGD amount varies with FX (DBS MC) |
| Price increase | Netflix 17.98 → 19.98 from May 2026 |
| Free trial converting to paid | Disney Plus 1.00 (Nov 2025), then 13.98 monthly |
| Bills | Singtel and SP Digital, monthly with variable amounts (UOB) |
| Annual fee + GST | DBS Visa, Mar 2026 statement |
| Refund (`CR`) | Shopee, Feb 2026 DBS statement |
| First-time large merchant | Courts 1,299.00, Jun 2026 DBS |
| Duplicate charge | Lazada 89.90 ×2 on the same day, Jul 2026 DBS |
| Unusual amount at a regular merchant | FairPrice 412.35, Aug 2026 UOB |
| FX + Dec → Jan year rollover | Japan trip (JPY), Jan 2026 UOB; IDR rows (DBS currency-name format) |
| Supplementary cardholder sub-header | Apr 2026 DBS |
| Card with no new spending | DBS MC, Sep 2026 (payment only, total 0.00) |

## Regenerating

```bash
npm install
npm run fixtures   # deterministic: same seed, byte-identical output (CI checks this)
npm run check:pii  # must pass before committing
```

The generator is [`generate-statements.mjs`](generate-statements.mjs). Change `SEED` or the planted events there, then regenerate the fixtures and commit both together.

**Real statements never go in this folder.** Keep them in git-ignored `private/` or `tests/private/`.
