# Synthetic statements (training and eval data)

[`synthetic/`](synthetic/) holds **fully synthetic** DBS and UOB credit-card statements, and POSB/UOB bank-account statements (PDF and CSV). They're used for parser tests, detector evals, categorisation evals and the demo workspace. Nothing in them comes from a real person:

| Data | What the fixtures use |
|---|---|
| Person | "Alex Tan", supplementary cardholder "Jordan Tan" (fictional) |
| Address | `10 EXAMPLE AVENUE, #01-01 SAMPLE RESIDENCES, SINGAPORE 000000` (000000 isn't a real postal code) |
| Card numbers | Public test numbers (`4111 1111 1111 1111`, `5555 5555 5555 4444`, `4012-8888-8888-1881`, `4000-0566-5566-5556`), never issued to anyone |
| Bank account | All zeros (`000-00000-0`, `000-000-000-0`) |
| Bank accounts | `POSB SAMPLE SAVINGS ACCOUNT`, `UOB SAMPLE ONE ACCOUNT` (fictional products); employer `SAMPLE EMPLOYER PTE LTD`; PayNow to and from "Jordan Tan" (a fixture persona) |
| Card products | `DBS SAMPLE VISA SIGNATURE`, `DBS SAMPLE WORLD MASTERCARD`, `UOB SAMPLE CASHBACK`, `UOB SAMPLE MILES VISA CARD` (fictional) |
| Merchants, amounts, dates | Generated from a fixed seed; "SAMPLE …" merchants are fictional |
| Watermark | Every page has a red "SYNTHETIC TEST DATA" banner (top and bottom), grey vector hatching, and a footer watermark. The PDF Subject metadata says `SYNTHETIC TEST DATA` (`npm run check:pii` verifies this) |

The layouts follow [`docs/statement-formats.md`](../../docs/statement-formats.md). They reproduce the line structure the parsers depend on, not the banks' branding.

## Contents

- `dbs/2025-10.pdf … 2026-09.pdf`: 12 monthly DBS statements, each with 2 cards
- `posb/` and `uob-one/`: 12 monthly bank-account statements each (Oct 2025 – Sep 2026), as `.pdf` and as the bank's `.csv` export, with `.expected.json` and `.csv.expected.json`. The layouts are **provisional** (`docs/statement-formats.md` §4–7). Every CSV starts with a `SYNTHETIC TEST DATA` line, which `npm run check:pii` requires.
- `uob/2025-10.pdf … 2026-09.pdf`: 12 monthly UOB statements, each with 2 cards (one card name wraps in the summary table)
- `*.expected.json`: the exact parse result per PDF, following the output contract in `statement-formats.md` §3, plus `rawDescriptor`, `expectedCategory` and `supplementary` for evals
- `ledger.json`: the events planted in the data, which detector evals should find
- `sample-bank/2026-07.pdf … 2026-09.pdf`: three card statements from a fictional "Sample Bank" (bank code `OTHER`) in a layout no parser reads, for the AI fallback extractor (`docs/statement-formats.md` §9). Same fictional holder and address, test card number `5105 1051 0510 5100`. The offline extractor reads this layout, so the eval runs without the network
- `variants/`: encrypted copies (RC4-128). `dbs-2026-03-owner-only.pdf` is copy-restricted with no open password, like real DBS e-statements. `uob-2026-01-password.pdf` needs the fictional password `alex0000`. `manifest.json` lists both, and `npm run check:pii` uses it to verify their synthetic marker.

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
| Salary | 6,800.00 on the 25th into the UOB One account, plus a December bonus |
| Own-account transfer | UOB → POSB by FAST, 3,000.00 on the 26th, landing the same day or the next: must be paired |
| Card bills paid from the bank | Every card statement's payment row appears in POSB (DBS cards) or UOB One (UOB cards) on the same day, same amount: must be paired, and the card marked paid |
| Bill from a bank account | Town council charges by GIRO, 82.40 monthly (UOB One) |
| First-time payee by PayNow | `SAMPLE RENOVATION PTE LTD`, 1,800.00, Mar 2026 (POSB) |
| PayNow to and from a person | Several a month (POSB): the name must be dropped; both directions are left for review |
| Page break | December is busy, so both bank layouts run over a page |
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
