# Statement formats: DBS and UOB credit cards and bank accounts (parser spec)

The credit-card rules (§1–2) were derived from real DBS and UOB credit-card statements. The bank-account rules (§5–7) are **provisional**: they are modelled on the banks' published statement and export layouts and are tested only against synthetic fixtures, until real samples have passed the local reconciliation test. **The real files are not in this repository and must never be committed** (see [`../CLAUDE.md`](../CLAUDE.md)).

Every example below is **fictional** and matches the synthetic fixtures in [`../evals/fixtures/synthetic/`](../evals/fixtures/synthetic/): the person is "Alex Tan", the card numbers are public test numbers, and the product names, merchants, amounts and dates are made up.

A prototype parser built from these rules reconciled every card section of the real samples exactly. It also parses all 24 synthetic fixtures (885 rows) back to their `.expected.json`.

The code blocks below show the **shape** of each line. They combine lines from several fixture statements, so their numbers don't add up.

The production parser should work from **pdf.js text items with x/y positions** (via `unpdf`), not from `pdftotext -layout` lines. The rules below are written as logical lines; amounts are **right-aligned in the amount column** and should be found by x-position.

---

## 0. Shared rules (both banks)

| Topic | Rule |
|---|---|
| Amount | `1,234.56` means a debit or charge (positive). `1,234.56 CR` means a credit (negative): payment, refund or cashback. Store integer cents. |
| Dates | `DD MON` with no year. Year = the statement year, unless the month is after the statement month, in which case it's the previous year (this handles Dec → Jan). |
| Currency | Billing currency is SGD. A foreign charge has an extra line under it with the original amount (format differs per bank, below). |
| Reconciliation, per card | `PREVIOUS BALANCE + Σ signed rows == card total` must hold exactly, in cents. |
| Reconciliation, per statement | `Σ card totals == statement grand total` (DBS) or `== summary "Amount to Pay" total` (UOB). |
| Stop zones | Stop reading transactions at the end-of-transactions marker. The pages after it repeat card numbers and totals (rewards tables, payment slip), so **don't parse them**. |
| PII | Card numbers, cardholder names, addresses and bank account numbers are consumed and dropped. See PRD §7.1a. The card's **product name** is the only card identifier kept. |
| Card payments | Payment rows (`AUTOPAY …`, `GIRO PAYMENT`) are marked as `card_payment` transfers, so they're excluded from spend. |
| Encryption | Try to open the PDF with no password first. Prompt for one only on pdf.js `PasswordException`. DBS statements seen so far are copy-restricted with an owner password but have no open password; UOB statements seen so far are unencrypted. |

---

## 1. DBS credit card statement

**Fingerprint:**
- first page contains `Credit Cards` + `Statement of Account`;
- `DBS Cards P.O. Box`;
- column header `DATE  DESCRIPTION  AMOUNT (S$)`.

**Fixture:** [`synthetic/dbs/`](../evals/fixtures/synthetic/dbs/)

### Header (page 1)

```
STATEMENT DATE        CREDIT LIMIT        MINIMUM PAYMENT        PAYMENT DUE DATE
  14 Mar 2026         $20,000.00              $50.00                08 Apr 2026
```

| Field | Keep? |
|---|---|
| Statement date | ✓, gives the year for all rows |
| Minimum payment | ✓, the statement-level total minimum |
| Payment due date | ✓ |
| Credit limit | ✗, not stored |
| Name and address block (top left) | ✗, never read |

### Card section (repeats per card)

```
DBS SAMPLE VISA SIGNATURE CARD NO.: 4111 1111 1111 1111         ← section start: product name + number

           PREVIOUS BALANCE                                    227.22
10 MAR     AUTOPAY AC#0000000000000000                         227.22 CR   ← card payment (strip AC#…)
           REF NO: 00000000000000000000000                                 ← ref line (transient, dedupe only)

NEW TRANSACTIONS ALEX TAN                                                  ← sub-header; drop the name
16 FEB     GRAB* A-Y5WPJ7LPZTBL                                 23.62
06 MAR     OPENCOURSE ONLINE SAN FRANCISCO CA                   27.20
           U. S. DOLLAR 20.00                                              ← FX line (currency NAME + amount, no thousands separator)
11 MAR     ANNUAL FEE                                          196.20
11 MAR     GST @ 9%                                             17.66      ← fee GST, group with ANNUAL FEE
09 FEB     SHOPEE SG MP                                         45.90 CR   ← refund
NEW TRANSACTIONS JORDAN TAN                                                ← supplementary cardholder; drop the name
                                               SUB-TOTAL:      573.23
                                                   TOTAL:      573.23      ← card total (reconcile against this)
Any Full Amount due will be deducted from bank account 0000000000. GIRO deduction date: …   ← drop (account no.)
```

| Element | Rule |
|---|---|
| Section start | Regex `^(?<product>.+?) CARD NO\.:\s*[\d ]{13,23}$`. `product` (e.g. `DBS SAMPLE VISA SIGNATURE`) is the card name. **The number is discarded.** |
| Previous balance | `PREVIOUS BALANCE` + amount |
| Transaction row | `DD MON` + description + amount [`CR`]. DBS shows **one date**, stored as `txn_date`, with `post_date` left null. |
| Continuation lines | `REF NO: <digits>` is used for the dedupe hash, then dropped. An FX line matching `^(?<ccyName>[A-Z][A-Z .]+?) (?<amt>\d+\.\d{2})$` is attached to the previous row. |
| FX currency names | DBS prints currency **names** with irregular spacing (e.g. `U. S. DOLLAR`, `RUPIAH`, `HONG KONG DOLLAR`). Map names to ISO 4217 with a lookup table (normalise spaces and dots). An unknown name keeps the row and sets `fx_currency = null` with a warning. |
| Cardholder sub-header | `NEW TRANSACTIONS <NAME>`. Drop it. Supplementary cardholders appear as further sub-headers within the same card section. |
| Card total | `TOTAL:` (not `SUB-TOTAL:`) |
| Statement total | `GRAND TOTAL FOR ALL CARD ACCOUNTS:` |
| Page furniture to ignore | `Credit Cards`, `Statement of Account`, `n of m` (counts transaction pages only), the `PDS_…` footer, GST/Co. Reg. lines, and the column header |
| Stop zones | `DBS VISA/MASTERCARD/AMEX CARD - DBS POINTS SUMMARY` (repeats card numbers), and everything from `USEFUL INFORMATION` onwards |
| Notable rows | `ANNUAL FEE` + `GST @ 9%` → Fees & Charges and the DET-5 alert; `AUTOPAY` → card payment |

---

## 2. UOB credit card statement

**Fingerprint:**
- `United Overseas Bank Limited`;
- `Credit Card(s) Statement`;
- column headers `Post Date | Trans Date | Description of Transaction | Transaction Amount SGD`.

**Fixture:** [`synthetic/uob/`](../evals/fixtures/synthetic/uob/)

### Header and summary (page 1)

```
Statement Summary
Statement Date            13 JAN 2026
Total Credit Limit        SGD 15,000          ← not stored
Payment Summary
Amount to Pay             SGD 1,274.42        ← statement total (reconcile)
Minimum Payment           SGD 100.00
Due Date                  01 FEB 2026

Summary
Card Name              Card Number            Name on Card     Amount to Pay SGD   Minimum Payment SGD
UOB SAMPLE CASHBACK    4012-8888-8888-1881    ALEX TAN               357.30             50.00
UOB SAMPLE MILES VISA  4000-0566-5566-5556    ALEX TAN               917.12             50.00
CARD                                                                                   ← card name wraps onto a second line
```

The summary table gives each card's product name, amount to pay and minimum payment. **Card Number and Name on Card are discarded.** A wrapped name (`UOB SAMPLE MILES VISA` + `CARD`) is joined by y-proximity within the Card Name column.

### Card section (repeats per card, can span many pages)

```
UOB SAMPLE CASHBACK                                                           ← product name (section title)
4012-8888-8888-1881 ALEX TAN                                                  ← number + name: drop both
Post Date   Trans Date   Description of Transaction              Transaction Amount SGD
                         PREVIOUS BALANCE                                    421.02
01 JAN      01 JAN       GIRO PAYMENT                                        421.02 CR   ← card payment
12 JAN      11 JAN       UOB SAMPLE CASHBACK Card Cashback                     3.38 CR   ← Cashback & Rewards
19 DEC      16 DEC       FAIRPRICE XTRA - SAMPLE SINGAPORE                    21.42
                         Ref No. : 00000000000000000000000                               ← dedupe only
17 DEC      13 DEC       BUS/MRT 770826567 SINGAPORE                           4.83      ← digits → "#"
20 DEC      18 DEC       ICHIRAN SHIBUYA TOKYO JPN                            15.13
                         JPY 1,700.00                                                    ← FX line (ISO code + amount)
                         SUB TOTAL                                           357.30
                         TOTAL BALANCE FOR UOB SAMPLE CASHBACK               357.30      ← card total
```

On the next page the section continues after a repeated header: `UOB SAMPLE MILES VISA CARD` / `4000-… ALEX TAN (continued)` / column header.

| Element | Rule |
|---|---|
| Section start | A product-name title line followed by a `\d{4}-\d{4}-\d{4}-\d{4} <NAME>` line **without** `(continued)`. The product name comes from the title line, cross-checked against the summary table. |
| Continuation | The same two lines with `(continued)` mean the current card carries on. Don't open a new card. |
| Transaction row | Two dates (`post_date`, `txn_date`) + description + amount [`CR`]. **Rows are not in strict date order**: credits come first, then charges by transaction date, with out-of-order post dates. Don't assume sorting. |
| Continuation lines | `Ref No. : <digits>` is used for the dedupe hash, then dropped. An FX line matching `^(?<ccy>[A-Z]{3}) (?<amt>[\d,]+\.\d{2})$` (e.g. `JPY 1,700.00`, `USD 20.00`) is attached to the previous row. |
| Card total | `TOTAL BALANCE FOR <product>`; `SUB TOTAL` is informational |
| Statement total | `Amount to Pay` in the Payment Summary, which equals the summary table total |
| Page furniture to ignore | The "check the entries" disclaimer (the real one also has a Chinese translation), the bank address footer, `Page n of m`, and dashed separators |
| Stop zones | Stop at `End of Transaction Details`. After it come `Rewards Summary` (repeats a card number), general information, and the **payment slip** (repeats every card number and amount). |
| Descriptor quirks | The merchant and city are often run together (`…MALLSINGAPORE`, `…CBDSINGAPORE`). The merchant normaliser should strip a trailing `SINGAPORE`/`Singapore`/`N/A`, with or without a space. |
| Notable rows | `GIRO PAYMENT` → card payment; `<PRODUCT> Card Cashback` CR → Cashback & Rewards; `BUS/MRT #` → SimplyGo / Transit |

---

## 3. Output contract (all parsers)

Implemented in `src/server/ingest/parsers/` (`dbs-card-pdf@1`, `uob-card-pdf@1`, and the provisional `dbs-account-pdf@1`, `uob-account-pdf@1`, `dbs-account-csv@1`, `uob-account-csv@1`), and validated at runtime by a strict Zod schema (`types.ts`).

```ts
type ParsedStatement = {
  bank: "DBS" | "UOB";
  kind: "card" | "deposit";           // credit-card or bank-account statement
  parserVersion: string;              // e.g. "dbs-card-pdf@1"; bank accounts end in "-provisional"
  statementDate: string;              // ISO date
  dueDate: string | null;
  minimumPaymentCents: number | null;
  statementTotalCents: number | null; // DBS grand total / UOB amount to pay
  totalsMatch: boolean | null;        // Σ card totals == statement total
  cards: Array<{                      // one per card, or per bank account
    productName: string;              // the ONLY identifier, as printed, e.g. "UOB SAMPLE CASHBACK"
    ordinal: number;                  // 1, 2… only if the same product name repeats
    previousBalanceCents: number | null; // signed like rows: + owed, − held (a bank balance is negative)
    totalCents: number | null;        // null: the file printed no balance
    reconciled: boolean | null;       // previous + Σ rows == total; null: nothing to check against
    rows: Array<{
      txnDate: string;                // ISO
      postDate: string | null;        // UOB only
      amountCents: number;            // + charge, − credit
      rawDescriptor: string;          // as printed: IN MEMORY ONLY (see below)
      refNo: string | null;           // IN MEMORY ONLY: enters the dedupe hash, never stored
      fx: { currency: string | null; amount: string } | null;
      kind: "charge" | "refund" | "card_payment" | "fee" | "cashback" | "income" | "transfer";
    }>;
  }>;
  warnings: string[];                 // codes only, never values
};
// Returned alongside, never stored: names: string[] (cardholder or account-holder
// names seen in the file, used only by the PII firewall's name check during this request),
// and accountRefs: (string | null)[] (each section's card/account number digits, turned at
// once into a per-user HMAC "account digest" so same-named cards/accounts stay apart).
```

**What gets persisted.** `prepareRows()` (`src/server/finance/ledger.ts`) is the PII firewall step. It turns each row into a sanitised `descriptor`, a normalised `merchantName` and an HMAC `dedupeKey`. The reference number is consumed by the hash and dropped. Only these prepared rows are stored: first encrypted in the import preview (`imports.preview_enc`), and after approval as transactions with an encrypted descriptor. Raw descriptors, reference numbers and names never reach the database.

There is **no field** for a card number, cardholder or account-holder name, address, credit limit or bank account number. The schema is strict, so none can be added by accident.

The fixtures' `.expected.json` files follow this contract. They add a few fields for evals (`descriptor`, `expectedCategory`, `supplementary`) and leave out `refNo`.

## 4. Bank accounts: shared rules (provisional)

| Topic | Rule |
|---|---|
| Columns | Withdrawal (+, money out), Deposit (−, money in) and Balance. Each amount is placed by its **right edge** against the column headers' right edges (±30pt). |
| Balances | Opening = the **first** "brought forward" balance; closing = the **last** "carried forward" balance. Page breaks that repeat them are ignored. Stored negated (`−opening`, `−closing`), so `previous + Σ rows = total` as for cards. |
| Reconciliation | `opening − Σ rows == closing`, in cents. Each row's printed running balance is also checked; a mismatch adds the warning `running_balance_mismatch`. |
| Rows | A line starting with a date opens a row: the rest of its text is the **transaction type**. Lines under it, until the next row, are its **details**. |
| Classification | `bank-rows.ts` turns (type, details, amount) into a kind and a descriptor: card bill payments (`CARD PAYMENT DBS CARD`) → `card_payment`; salary/bonus and interest → `income`; own-account transfers → `transfer`; PayNow/FAST/funds transfers → `charge` (out) or `income` (in), paired later if both legs are yours; ATM → `charge` (Cash); NETS/POS/debit card → `charge` with the merchant; GIRO → `charge` with the payee. |
| PII | The account number is dropped with the header. **Other people's names are removed**: a PayNow/FAST/funds transfer to or from a person becomes `PAYNOW TRANSFER OUT` / `IN`. A payee with a company suffix (PTE LTD, LTD, LLP, TOWN COUNCIL…) is a merchant and kept. A row of an unrecognised type keeps only its type line and company names. The holder's name (first line of the address block) is passed to the firewall in memory. |
| Stop zones | Footers ("Deposit Insurance Scheme…", "End of Account Transaction Details") end the transactions. The address block and summary tables are never read. |

## 5. DBS/POSB account statement PDF (provisional)

**Fingerprint:** `CONSOLIDATED STATEMENT`, `Balance Brought Forward`, and `DBS Bank Ltd` or `POSB`.

```
CONSOLIDATED STATEMENT
ALEX TAN                                   Statement Date         31 Mar 2026
POSB SAMPLE SAVINGS ACCOUNT                        Account No. 000-00000-0   ← section: product name; number dropped
Date        Description                Withdrawal (-)   Deposit (+)    Balance
            Balance Brought Forward                                   16,033.09   ← opening (first one only)
04/03/2026  PayNow Transfer                     20.52                 16,012.57
            TO JORDAN TAN                                                         ← detail: a person → name dropped
10/03/2026  Bill Payment                       227.22                 15,730.32
            DBS CARD CENTRE                                                       ← card bill payment
            4111111111111111                                                      ← card number: never kept
26/03/2026  FAST Payment / Receipt                          3,000.00  16,692.62
            Balance Carried Forward                                   16,647.17   ← closing (last one wins)
            Total                             2,418.87      3,032.95
```

Dates are `DD/MM/YYYY`.

## 6. UOB account statement PDF (provisional)

**Fingerprint:** `United Overseas Bank Limited`, `Statement of Account`, `BALANCE B/F`.

```
Statement of Account                       Period:  01 Mar 2026 to 31 Mar 2026   ← statement date = period end
UOB SAMPLE ONE ACCOUNT  000-000-000-0                                            ← section (continued pages add "(continued)")
Date     Description        Withdrawals    Deposits     Balance
01 Mar   BALANCE B/F                                   40,408.09
03 Mar   NETS QR                  10.73                40,397.36
         NETS QR SAMPLE HAWKER CENTRE                                ← merchant (type prefix stripped)
25 Mar   GIRO - Salary                       6,800.00  45,838.46
         SAMPLE EMPLOYER PTE LTD
         Total                 4,378.73      6,825.38                ← before the closing line: skipped
31 Mar   BALANCE C/F                                   42,854.74
```

Dates are `DD Mon` with the year from the period (Dec → Jan handled as for cards).

## 7. Bank CSV exports (provisional)

| Bank | Shape | Balances |
|---|---|---|
| DBS/POSB | Header rows (`Account Details For:`, `Statement as at:`, `Ledger Balance:`), then `Transaction Date, Reference, Debit Amount, Credit Amount, Transaction Ref1–3`. `Reference` is a code (`ICT` FAST, `BILL` bill payment, `POS`, `INT` interest, `AWL` ATM…), mapped to the PDF's type names so both formats give the same descriptors. | Only the balance *as at* the export: `reconciled = null` (nothing to check), `previousBalanceCents = null`. |
| UOB | Header rows (`Account Type:`, `Account Number:`, `Statement Period:`), then `Transaction Date, Transaction Description, Withdrawal, Deposit, Available Balance`. The description starts with the transaction type. UOB exports XLS; save it as CSV for now. | A running balance per row: opening = first balance + first amount, closing = last balance, and every row is checked against the one before. |

A PDF and the CSV of the same month produce identical rows, so importing both dedupes.

## 8. Fixtures and tests

- `npm run fixtures` regenerates [`evals/fixtures/synthetic/`](../evals/fixtures/synthetic/) deterministically. See [`../evals/fixtures/README.md`](../evals/fixtures/README.md) for what's planted in it.
- **Golden tests**: exact rows, totals and reconciliation per fixture.
- **No-PII tests**: after an import, assert that none of the fixture's test card numbers (in any format), "Alex Tan"/"Jordan Tan" or the fixture address appear in the DB, logs, LLM request bodies or API responses.
- **Local-only real-sample test**: `tests/private/` is git-ignored and skipped in CI. It runs both parsers on your real PDFs and asserts only that reconciliation passes and that no Luhn-valid number or name reaches the output.
- **Encrypted variants** (`synthetic/variants/`, RC4-128 via `@pdfsmaller/pdf-encrypt-lite`, deterministic): an owner-password, copy-restricted DBS statement that must open without a prompt, and a UOB statement with a fictional open password that must be asked for.
- **Bank accounts:** 12 months of a POSB savings account and a UOB One account, each as PDF and CSV (`synthetic/posb/`, `synthetic/uob-one/`), parse exactly (`tests/unit/bank-parsers.test.ts`), including a December that runs over a page break. **Real bank-account samples have not been tested yet**: the parser versions say `provisional` until they have.
- **Status:** both card parsers pass every fixture and variant exactly (`tests/unit/parsers.test.ts`). They also reconcile every card section and the statement totals of the real DBS and UOB samples (local-only test, no values recorded).
