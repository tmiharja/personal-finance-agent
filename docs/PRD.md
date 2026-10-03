# PRD — Personal Finance Agent (SG)

| | |
|---|---|
| **Status** | Draft v2 (2026-10-03): updated after the sample DBS + UOB card statements and decisions on auth, model and monetisation |
| **Owner** | toninmotion |
| **Working title** | "Finance Agent" (wordmark). Rename any time; nothing depends on it. |
| **Sister projects** | [Resume Optimiser](https://github.com/tmiharja/resume-scorer-optimiser) (same stack and conventions) and the [portfolio website](https://github.com/tmiharja/portfolio-website) (same look and feel) |
| **Companion docs** | [`architecture.md`](architecture.md): the high-level architecture flow · [`statement-formats.md`](statement-formats.md): parser spec for DBS and UOB card statements · [`../evals/fixtures/`](../evals/fixtures/): synthetic statements |

Decisions marked ★ were taken by default after the Q&A on 2026-10-03 (questions 21–63 were delegated). Each one can be changed. Section 14 lists what is still open.

**Confirmed by the owner (v2):**
- Credit cards first, **DBS then UOB**, from real sample statements.
- **No PII stored**; at most the card's product name (§7.1a).
- **Better Auth**.
- **Sonnet 5.5** for Q&A (cheapest that passes the evals).
- **No monetisation**: free forever, on Vercel Hobby.

---

## 1. Summary

The Finance Agent is a free public web app for people in Singapore. You upload your own bank and credit-card statements as PDF or CSV. The app then:

- extracts and reconciles every transaction;
- categorises your spending;
- finds subscriptions, bills and unusual charges;
- answers plain-English questions such as *"What did I spend on dining in Q3?"*.

The agent can read your data freely, but it **never changes anything on its own**. Every write (an import, a rule, a recategorisation, a dismissed alert, an export) is a **proposal you approve first**. The app is **read-only towards banks**: it never moves money, logs into a bank, or contacts anyone on your behalf.

It is also a portfolio piece. The write-up will focus on **human-in-the-loop agent design**, with privacy engineering and evals as supporting stories.

## 2. Problem

- SG banks don't offer consumers a Plaid-style API. Spending insight means downloading statements from several banks and stitching them together in a spreadsheet.
- Bank apps categorise poorly, and only within that one bank. Nobody sees across DBS + OCBC + UOB + cards.
- Subscriptions creep up, prices rise silently, and free trials convert into paid plans. Annual card fees and late fees slip through.
- Existing AI "money assistants" either want bank credentials or act without asking. Both erode trust.

## 3. Goals and non-goals

### Goals (v1)

1. **G1 – Trustworthy ingestion.** Import 12 months of statements from the major SG banks in under 10 minutes. Every statement reconciles to its printed totals, or is flagged.
2. **G2 – Useful categorisation.** About 85% of transactions are correct on the first pass, and over 95% after a month of corrections that turn into rules.
3. **G3 – Find leaks.** Surface subscriptions, price increases, trial conversions, duplicate charges, card fees and unusually large charges, each with a plain-English reason.
4. **G4 – Answer questions correctly.** Every number in an answer comes from a database query and links to the transactions behind it. The LLM never does arithmetic.
5. **G5 – Human approval for every write**, with an audit log and undo.
6. **G6 – Privacy by design.** Data is hosted in Singapore, sensitive fields are encrypted, identifiers are masked before any LLM call, and you can wipe everything with one click.
7. **G7 – Portfolio quality.** The UI feels like part of the Resume Optimiser family, there's a public demo with a fictional user, and the eval results are published.

### Non-goals (v1)

- **Moving money of any kind**: no payments, transfers, GIRO set-up or bill pay. This is permanent, not just a v1 limit.
- Logging into banks, screen-scraping, or storing bank credentials. SGFinDex and aggregator APIs are out of scope.
- Investment, CPF, insurance-policy or tax advice. The agent describes past spending only, which also keeps it clear of Financial Advisers Act territory. A "not financial advice" notice is shown.
- Forecasting and "can I afford X?" questions (Phase 4 at the earliest).
- Split transactions, multi-person households, shared ledgers or "who owes whom" ★ (Q2, Q18, Q20).
- E-wallet exports (PayLah!, GrabPay), receipts and CPF statements (Q14).
- Scanned or image-only statements (Q11).
- Native mobile apps. The web app is responsive and mobile-first.
- Sending emails, creating calendar events, or contacting merchants on your behalf. The agent can **draft** text for you to copy and send yourself.

## 4. Users and personas

**Public multi-user app, one person per account** (Q1 = C, Q2 = A). Each account's data is fully isolated.

| Persona | Description | Key jobs |
|---|---|---|
| **Mei, 31, product manager** (primary) | Has 2 bank accounts and 3 credit cards across DBS, OCBC and UOB, and chases card rewards. Comfortable with tech, cautious about privacy. | "Where does my money go each month?", "Which subscriptions am I paying for?", "Did my card charge me an annual fee?" |
| **Arjun, 27, young professional** | Has 1 bank account and 1 card, wants a monthly budget. | Monthly overview, category budgets, bill-due reminders |
| **Portfolio visitor / recruiter** | Wants to see the agent work without uploading anything. | The demo workspace with a fictional user, asking questions, approving proposals |
| **Owner (operator/admin)** | Runs the service. | Cost dashboard, error rates, parser coverage, eval runs |

## 5. Key user journeys

1. **Onboard.** Sign up (email OTP or passkey), consent to the privacy notice, and choose a base currency (SGD, fixed in v1).
2. **First import.** Drop up to 12 months of PDFs/CSVs and enter the password for any locked PDF; the password is never stored. Then:
   - Each file parses with live progress, and you see an **import preview**: period, transaction count, reconciliation ✓/✗, duplicates skipped, transfers detected, low-confidence categories.
   - You approve to commit the import.
3. **Overview.** See this month's income vs spend, spend by category, a small trend line, upcoming bills, open alerts and the subscription total.
4. **Review.** Work through low-confidence categories quickly. Each correction asks *"Apply to all past and future Grab transactions?"* (Q17). A yes creates a **rule proposal**, which you approve.
5. **Ask.** Type "What did I spend on dining in Q3 vs Q2?". You get the figures and a small chart, with a "View 47 transactions" link.
6. **Act.** The agent spots an Apple One price rise and proposes:
   - (a) tag it #review;
   - (b) a draft cancellation checklist.

   You approve (a) and copy (b).
7. **Ongoing.** Each month you upload new statements. A daily job refreshes detectors, and a weekly in-app digest summarises what changed.
8. **Leave.** Export a CSV, then "Delete my account and all data". Both need you to re-authenticate.

## 6. Functional requirements

Priorities: **P0** is needed for MVP, **P1** for v1, **P2** comes later.

### 6.1 Accounts, auth and workspace

| ID | Requirement | Pri |
|---|---|---|
| AUTH-1 | Sign up and log in with email OTP or magic link, plus passkeys. Google sign-in is optional ★. | P0 |
| AUTH-2 | Sessions use HttpOnly, Secure, SameSite=Lax cookies, time out after 30 minutes idle and expire after 7 days absolute. | P0 |
| AUTH-3 | Step-up re-authentication before export, account deletion, and approving any action that touches more than 100 transactions. | P1 |
| AUTH-4 | Optional TOTP 2FA. | P1 |
| AUTH-5 | Signup records a timestamp and version for consent to the privacy notice and the "not financial advice" notice. | P0 |
| AUTH-6 | **Demo workspace**: the "Try the demo" button needs no signup. Each visitor gets an ephemeral copy of a seeded fictional user ("Alex Tan", 12 months, 3 accounts). Uploads are disabled, Q&A is capped per IP, and the copy is deleted after 24 h. | P0 |

### 6.2 Statement import

| ID | Requirement | Pri |
|---|---|---|
| IMP-1 | Upload **PDF** statements (Q7a) as P0. Several files can be dropped at once and each is processed separately. Files must be ≤ 4 MB and PDFs ≤ 30 pages. **CSV/XLS(X)** exports (Q7b) are P1, and come with bank-account statements. | P0 |
| IMP-2 | **Password-protected PDFs**. Ask for a password only when the PDF needs one to open. The password is used in memory only and never stored or logged (Q8). Owner-password PDFs that only restrict copying or printing open without a prompt. DBS statements seen so far are of this kind; UOB statements seen so far aren't encrypted. | P0 |
| IMP-3 | Detect the institution and statement type (savings/current or credit card) from layout fingerprints. | P0 |
| IMP-4 | **Deterministic parser per bank and format first** (Q10). **MVP: DBS and UOB credit-card PDF statements**, specified in [`statement-formats.md`](statement-formats.md) from the real samples. Phase 2 adds **DBS/POSB and UOB bank-account statements** (PDF + CSV). Later (Phase 4): OCBC first, then Citi, HSBC, Standard Chartered, Maybank, AMEX and Trust ★. | P0 |
| IMP-5 | **LLM fallback extractor** for unknown layouts, with the same output schema. Results are always marked "AI-extracted, please review", and the import is blocked unless reconciliation passes or you explicitly accept. | P1 |
| IMP-6a | **Multi-card statements**. One PDF often holds several cards (the samples from both banks did). Each card section becomes its own card account, identified by bank + card product name (see §7.1a). Each card reconciles separately, and the cards together must add up to the statement's grand total (DBS) or summary total (UOB). | P0 |
| IMP-6 | **Reconciliation**. For bank statements, opening balance + Σ transactions = closing balance. For card statements, previous balance + Σ signed rows (charges positive; payments, refunds and cashback negative, marked `CR`) = the card's total. This was verified on every card section of the real samples (kept out of the repo) and on all synthetic fixtures. A mismatch flags the statement, shows the difference and blocks one-click commit. | P0 |
| IMP-7 | Reject scanned or image-only PDFs (no text layer) with a friendly message (Q11). | P0 |
| IMP-8a | **Dates without a year**. Both banks print `DD MON`, so the year is inferred from the statement date: a month after the statement month belongs to the previous year (this handles Dec → Jan). UOB has a post date and a transaction date; DBS has a single date, stored as the transaction date. | P0 |
| IMP-8 | **Normalise** each transaction to: txn date, post date, signed amount in minor units, currency, original FX amount and currency, **sanitised** descriptor (§7.1a), and account. Card statements also give due date, minimum payment and statement balance. | P0 |
| IMP-9 | **De-duplication** (Q12). An exact fingerprint (account, date, amount, normalised descriptor, sequence) is skipped silently. Near-duplicates (same amount ±1 day, similar descriptor, a different source file) go to a review list in the import preview. Overlapping statement periods are handled. | P0 |
| IMP-10 | **Transfer detection** (Q13). Credit-card bill payments and transfers between your own accounts are paired (opposite amounts within ±3 days, known descriptors such as "BILL PAYMENT", "FAST", "GIRO … CARD") and excluded from spend and income. Unpaired candidates ask you to confirm. | P0 |
| IMP-11 | **Import preview → approve to commit.** Nothing is written to your ledger until you approve. Uncommitted previews expire after 24 h. | P0 |
| IMP-12 | Backfill: show a progress checklist for "last 12 months per account" (Q9), with gaps highlighted, e.g. "DBS Sample World Mastercard: missing Apr, Jun". | P1 |
| IMP-13 | Raw files are **discarded after parsing** and never stored ★. Only a SHA-256 of the file is kept, to block exact re-uploads. | P0 |
| IMP-14 | Live progress over SSE: Unlocking → Reading → Parsing → Reconciling → Categorising → Ready for review. | P0 |

### 6.3 Categorisation, merchants and tags

| ID | Requirement | Pri |
|---|---|---|
| CAT-1 | A fixed default taxonomy of about 15 editable categories (Q15). You can rename, hide or add categories. Starter set: Dining, Groceries, Transport, Shopping, Bills & Utilities, Telco & Internet, Insurance, Health, Entertainment, Subscriptions, Travel, Education, Home, Fees & Charges, Gifts & Donations, Cashback & Rewards, Income, Transfers (system), Uncategorised (system). | P0 |
| CAT-2 | **Merchant normalisation**: turn the raw descriptor into a clean merchant name. For example, `GRAB* A-3XYZ SINGAPORE SG` becomes "Grab", and `BUS/MRT 123456 SINGAPORE` becomes "SimplyGo / Transit". | P0 |
| CAT-3 | **Category resolution order** (Q16): your rules → curated global merchant map → LLM batch classifier (constrained to your category list, with confidence) → Uncategorised. | P0 |
| CAT-4 | LLM categorisations below 0.7 confidence are flagged for review in the import preview and on the Transactions screen. | P0 |
| CAT-5 | **Correction flow** (Q17). Changing a category asks: *this transaction only*, or *all past and future from this merchant*. The second option creates a **rule proposal** (see §6.6). | P0 |
| CAT-6 | **Tags** (Q19). Free-form tags with suggestions (#travel-japan, #reimbursable, #wedding). Reimbursables are a tag only, with a filter and total (Q20). | P1 |
| CAT-7 | **No split transactions** in v1 (Q18). | — |
| CAT-8 | **Global merchant map privacy**. It is seeded from a curated list. Learning from users is P2, and only promotes a descriptor → merchant mapping when at least 5 distinct users agree and the descriptor isn't person-like (PayNow/FAST to individuals is never promoted). | P2 |

### 6.4 Detectors: subscriptions, bills and unusual charges

All detectors are **deterministic code over the database, not LLM calls**. The LLM is used only to explain a finding in plain English when you ask.

| ID | Requirement | Pri |
|---|---|---|
| DET-1 | **Subscriptions**. A merchant with at least 3 charges on a regular cadence counts. Cadences are weekly, monthly (±4 days), quarterly or annual; annual needs only 2 charges. The amount must be within ±10% or exact. Shows the monthly-equivalent cost, next expected date, last price and status (active, possibly cancelled, overdue). | P0 |
| DET-2 | **Price increase**: the latest charge is more than 5% above the median of earlier ones. | P0 |
| DET-3 | **Free-trial conversion**: a $0–$2 charge followed by a full-price charge from the same merchant within 3–35 days. | P1 |
| DET-4 | **Unusual charge**, for any of these reasons: (a) amount > max(3× merchant median, merchant p95) with at least 3 prior charges; (b) first-time merchant ≥ S$200 (configurable); (c) duplicate, meaning same merchant and amount within 48 h, excluding transit/F&B micro-charges; (d) foreign-currency charge, with the FX fee shown. | P0 |
| DET-5 | **Card fees and charges**: annual fee and the GST charged on it, late fee, finance charge or interest, and overlimit fee are tagged as Fees & Charges and raise an alert. DBS prints `ANNUAL FEE` followed by a `GST @ 9%` row, and they are grouped as one fee event. SG banks often waive the annual fee when asked, so the alert offers a draft waiver request (ACT-2). | P0 |
| DET-6 | **Bills**. Recurring payees (utilities, telcos, insurers, town council/MCST, IRAS GIRO, loans) are detected from history, and you can add bills manually (Q25). Each bill has an expected amount, due day and paid/unpaid status for the cycle. | P1 |
| DET-7 | **Card due dates** come from card statements: due date, minimum payment and statement balance (Q26). A card is marked "Paid" when a matching bill payment appears in an imported bank account. | P0 |
| DET-8 | **Alerts inbox**. Each alert shows type, reason (as text, never colour alone), linked transactions and its actions (all of which are proposals; see §6.6). | P0 |
| DET-9 | Detectors re-run after every committed import, and once a day by cron for date-based states such as "bill due in 3 days" and "subscription overdue". | P0 |
| DET-10 | **Weekly digest**, shown in-app (Q27, Q28): spend vs the previous week, new alerts, upcoming bills. An optional email digest is P2. | P1 |

### 6.5 Ask (the Q&A agent)

| ID | Requirement | Pri |
|---|---|---|
| ASK-1 | A chat panel on every data screen: a slide-over on desktop, full screen on mobile (Q29). Chat is kept for the session only, not stored (Q35) ★. | P0 |
| ASK-2 | **Tool-grounded answers** (Q30). The agent can only answer through typed, read-only tools that run parameterised SQL scoped to your account. It never writes SQL itself. | P0 |
| ASK-3 | **The numbers guard**. Every figure in an answer must trace back to a tool result. A deterministic check compares the numbers in the final text against the tool outputs. On a mismatch the answer is regenerated once, and failing that it is replaced by the tool's table. | P0 |
| ASK-4 | **Answer format** (Q31): a short sentence, the key figures, an optional mini chart (bar or line, plain SVG), and a **"View N transactions"** link to a pre-filtered Transactions view. | P0 |
| ASK-5 | **Period semantics** (Q32). Periods are resolved deterministically by a `resolve_period` tool. "Q3" means calendar Jul–Sep by **transaction date** in the current year, or the most recent complete Q3 if this year's isn't over. The resolved range is always shown, e.g. *"Q3 2026 (1 Jul – 30 Sep)"*. | P0 |
| ASK-6 | Transfers are excluded from spend and income, and refunds net against their category. Each answer says what was included, e.g. *"Excludes 6 card payments and transfers"*. | P0 |
| ASK-7 | Supported question types: totals, breakdowns, comparisons between periods, top merchants, specific transaction lookups, subscriptions, bills and alerts, and "what changed" questions. Out-of-scope questions (advice, forecasts, other people's data) get a polite refusal. | P0 |
| ASK-8 | The agent can **propose** actions (see §6.6) inside the chat, as an inline Proposed-action card. | P1 |
| ASK-9 | Suggested starter questions on an empty chat. | P1 |
| ASK-10 | **Budgets**: a monthly budget per category, with a progress bar on the Overview. The agent can answer "Am I on track?" (Q34). | P1 |

### 6.6 Actions and human-in-the-loop approval (core differentiator)

**The principle:** the agent and the background jobs can **read** anything in your workspace, but every **write** they want is stored as a `proposed_action` and shown to you. A write happens only after you approve it in the UI. The server enforces this; it is not just a prompt instruction.

| ID | Requirement | Pri |
|---|---|---|
| ACT-1 | **Allowed action types (v1 allowlist)**: `commit_import`, `create_rule`, `update_rule`, `delete_rule`, `recategorise_transactions`, `tag_transactions`, `mark_transfer`, `dismiss_alert`, `mark_alert_expected`, `set_subscription_status`, `add_bill` / `update_bill`, `set_budget`, `export_csv`. Anything else is rejected. | P0 |
| ACT-2 | **Draft-only assistance**: cancellation steps, an annual-fee waiver request, or a dispute message for a duplicate charge. These are text for you to copy. They are never sent and change no data, so they need no approval. | P1 |
| ACT-3 | **Never allowed** (hard-coded, not configurable): moving money, contacting anyone, external API calls with user data apart from the LLM, deleting statements or accounts (you do that yourself in Settings), and changing auth settings. | P0 |
| ACT-4 | **Proposal card**: a plain-English title, the reason, a **deterministic preview diff** computed by the server (e.g. "23 transactions: Shopping → Groceries", with a sample of rows), any risk notes, and Approve / Reject / Edit buttons. The preview is rendered from structured data, never from model-written text. | P0 |
| ACT-5 | **Batch approval** with select-all (Q39), and per-item deselect for bulk actions. | P1 |
| ACT-6 | **Integrity**: each proposal stores a hash of its payload and the versions of the rows it affects. Approval executes **exactly** the previewed payload. If the data changed in the meantime, the proposal is marked stale and re-previewed. Proposals expire after 24 h. Execution is idempotent (one proposal executes at most once). | P0 |
| ACT-7 | **Policy checks** before a proposal is even shown: the action type is in the allowlist, the payload passes Zod validation, the bounds hold (e.g. at most 2,000 transactions per action), and every referenced ID belongs to your account. | P0 |
| ACT-8 | **Audit log** (Q40): an append-only record of who proposed what (agent, detector or you), when, the preview, your decision, the execution result, and undo. It can be viewed and filtered under Activity. | P0 |
| ACT-9 | **Undo**: every executed data change stores its inverse. Undo is one click for 30 days and is itself logged. `export_csv` cannot be undone. | P1 |
| ACT-10 | **No auto-apply**. Even high-confidence agent proposals wait for you (Q41 = always ask) ★. Import-time categorisation is not a separate approval because it's covered by approving `commit_import`. | P0 |
| ACT-11 | An "Approvals" badge in the header shows how many proposals are pending. | P0 |

### 6.7 Screens (UX scope)

| Screen | Purpose | Pri |
|---|---|---|
| **Landing** (`/`) | Hero band like the Resume Optimiser's, value proposition, "Try the demo", "Sign up", the privacy promise, how it works | P0 |
| **Import** (`/import`) | Multi-file drop zone, password prompt, per-file progress, import preview, approve | P0 |
| **Overview** (`/app`) | Month at a glance: spend vs income, by category, trend, bills due, alerts, subscriptions total, budget bars | P0 |
| **Transactions** (`/app/transactions`) | Filterable, searchable table (date range, account, category, merchant, tag, amount); inline recategorise; CSV export | P0 |
| **Subscriptions** (`/app/subscriptions`) | List with cadence, monthly-equivalent cost, next date, price history, status | P0 |
| **Bills** (`/app/bills`) | Card due dates, recurring bills, a calendar-style list for the next 30 days | P1 |
| **Alerts** (`/app/alerts`) | Inbox of detector findings, with filters | P0 |
| **Ask** | Chat slide-over, available everywhere | P0 |
| **Activity** (`/app/activity`) | Pending approvals and the audit history, with undo | P0 |
| **Settings** | Accounts, categories, rules, budgets, thresholds, export, delete account | P0 |
| **Privacy / Terms** | Plain-English PDPA notice, data flows (including the US LLM processing), retention, "not financial advice" | P0 |

### 6.8 Admin and operations

| ID | Requirement | Pri |
|---|---|---|
| OPS-1 | Per-request token usage and cost logging, plus per-user and global monthly cost counters. | P0 |
| OPS-2 | A **global monthly budget circuit breaker**. When it trips, LLM features degrade gracefully: imports still parse with deterministic parsers, and Q&A shows "capacity reached". | P0 |
| OPS-3 | An admin page (owner only) showing users, imports per bank, the parser failure rate, reconciliation pass rate, LLM cost and the eval scoreboard. It shows no user financial data. | P1 |
| OPS-4 | Structured logs with **no PII, descriptors or amounts**. Only IDs, counts, timings and error codes are logged. | P0 |

## 7. Non-functional requirements

### 7.1 Security and privacy (PDPA-aligned)

| Area | Requirement |
|---|---|
| **Data residency** | App functions run in `sin1`; Postgres in Neon `aws-ap-southeast-1` (Singapore); Redis in Upstash `ap-southeast-1` ★ (Q46). |
| **LLM processing** | Anthropic API calls are processed outside Singapore. This is disclosed in the privacy notice (PDPA Transfer Limitation Obligation). |
| **No PII stored** | See §7.1a. This was a hard requirement from the owner, and tests enforce it. |
| **Minimise LLM data** | Only what each task needs is sent: for categorisation, normalised descriptors + amount + MCC-like hints, never account numbers or names. |
| **Masking** | Before any LLM call, the following are masked deterministically: card and account numbers, NRIC/FIN (checksum-validated), phone numbers, emails, addresses, and personal names in PayNow/FAST descriptors. |
| **Encryption** | TLS everywhere, and Neon encryption at rest. On top of that, sensitive columns (sanitised descriptor, card nickname, notes) are encrypted at the application level with **per-user data keys** (envelope encryption). A master key in Vercel env wraps the per-user keys and can be rotated (Q44). |
| **Tenant isolation** | Every table carries `user_id`. Postgres **Row-Level Security** is enforced by a per-transaction `app.user_id` setting. Query helpers in the app layer can't be called without a session user. Tests prove that user A can't read user B's data. |
| **Agent tool scoping** | `user_id` is never a tool parameter; it is injected from the authenticated session. |
| **Prompt injection** | Statement text and descriptors are **untrusted data**. The categoriser's output is constrained to an enum. The Q&A agent has read-only tools, and every write goes through §6.6. |
| **Secrets** | The PDF password lives in memory for one request and is never logged. Raw files are discarded. |
| **Retention** | Data is kept while the account is active. "Delete account" hard-deletes within 24 h and disclosure covers the Neon point-in-time-restore window. Accounts inactive for 18 months get an email and are deleted 30 days later ★. |
| **Rights** | Export everything as CSV/JSON. Delete everything. View the audit log. |
| **Web security** | CSP; same-origin checks on mutations (like the Resume Optimiser); CSRF tokens on approve/execute; rate limits on auth and upload. |
| **Breach readiness** | A short incident runbook: assess, then notify the PDPC and affected users within PDPA timelines. |

### 7.1a PII policy: what is and isn't stored

**Rule:** the only thing that identifies a card is its **product name as printed** (e.g. "DBS Sample Visa Signature", "UOB Sample Cashback" in the fixtures), plus an optional nickname you choose. No identifier of you or your card is ever written to the database, logs, analytics, the LLM, or error reports.

| Data on the statement | Handling |
|---|---|
| Full card number, in every format (`4111 1111 1111 1111`, `4111-1111-1111-1111`, in the header, summary table, rewards table and payment slip) | **Never stored, never sent to the LLM.** It's used in memory only to split card sections and to derive a one-way **account digest** (HMAC under the user's own key, like the dedupe key), then dropped. The digest only tells two cards with the same product name apart; it can't be reversed or shown. Last-4 digits are not kept either. |
| Cardholder name and name on card (including supplementary cardholders) | **Never stored.** Section headers like `NEW TRANSACTIONS <NAME>` or `<card no> <NAME>` are consumed by the parser and dropped. |
| Mailing address, postal code | **Never extracted.** The parser skips the address block entirely. |
| Bank account numbers in payment rows (e.g. `AUTOPAY AC#…`, "deducted from bank account …") | **Removed** from the descriptor. The row is kept as "Card payment (GIRO/AutoPay)" and marked as a transfer. |
| Credit limit, reward points, interest rates, marketing pages | **Not stored.** They aren't needed. |
| Transaction reference numbers (`REF NO:` / `Ref No. :`) | Used **transiently** inside a keyed hash (HMAC with a per-user secret) for dedupe, then dropped. The hash can't be reversed. |
| Long digit runs inside descriptors (transit trip IDs, merchant IDs, phone numbers) | Runs of 6+ digits are **replaced with `#`** before storage. For example, a transit descriptor becomes `BUS/MRT # SINGAPORE`, normalised to "SimplyGo / Transit". |
| Statement date, due date, minimum payment, previous balance, card total | **Stored.** They're needed for bills and reconciliation. |
| Bank account number, account holder name and address on a bank-account statement | **Never stored.** The account's **product name** (e.g. "POSB Sample Savings Account") is the identifier shown, as for cards; the number only becomes the one-way account digest, so two accounts with the same product name stay apart. |
| Other people's names in PayNow, FAST and funds-transfer rows ("PAYNOW TO <name>") | **Removed** by the parser: the row is kept as "PayNow transfer" (direction and amount only). Business payees with a company suffix (PTE LTD, LTD, LLP…) are kept, since they are merchants. |
| Opening and closing balance of a bank account | **Stored.** They're needed for reconciliation. |
| Transaction date(s), amount, currency, FX amount + currency, sanitised descriptor | **Stored**, with the descriptor encrypted at the application level. |

**Defence in depth (all P0):**
1. **Parsers allow fields in**, rather than filtering them out: only named fields leave the parser. The header and address zone is never read except for the statement date, due date and minimum payment.
2. A **PII firewall** runs on every string before storage, before any LLM call, and before logging. It masks:
   - Luhn-valid 13–19 digit sequences, whether spaced, dashed or plain;
   - NRIC/FIN (checksum-validated);
   - SG postal codes next to "SINGAPORE";
   - emails and phone numbers;
   - the cardholder name tokens seen in this upload, held in memory only.

   A hit that survives sanitising **blocks the import** with an error code, never the value itself.
3. **Tests**:
   - Synthetic fixtures contain fake card numbers, names and addresses. A test dumps every table, log line, LLM request body and API response after an import and asserts that none of those values appear.
   - A local-only test does the same against the real sample PDFs, which are git-ignored.
4. **Same-product duplicates**: if one statement has two cards with the same product name (e.g. a principal and a supplementary card shown separately), they're labelled "UOB Sample Cashback (1)" / "(2)" by order of appearance, and you can nickname them in the import preview. On later imports they're matched by name and order. No number is used.

### 7.2 Performance

| Metric | Target |
|---|---|
| Deterministic parse of one statement (PDF ≤ 10 pages) | p95 < 5 s |
| LLM-fallback parse | p95 < 60 s |
| First import (12 statements) end to end | < 3 min |
| Q&A answer | first token < 3 s, full answer p95 < 10 s |
| Overview page | LCP < 2.0 s on 4G |
| Transactions table | handles 10k rows with server-side pagination |

### 7.3 Cost (per active user per month, US$, estimate to be measured)

| Activity | Model ★ | Estimate |
|---|---|---|
| Onboarding categorisation (~1,500 txns, ~300 unique merchants, batches of 50) | Haiku 4.5 | ~$0.10 one-off |
| LLM-fallback parsing (only unknown layouts) | Haiku 4.5 | ~$0.03 per statement |
| Monthly new-merchant categorisation | Haiku 4.5 | < $0.03 |
| Q&A (~40 questions/month, 2–3 tool rounds each, cached system+tools) | Sonnet 5.5 | ~$0.03–0.05 per question, so ~$1.20–2.00 |
| **Typical total** | | **≈ $1.50 / active user / month**, with Q&A dominating |

Pricing used: Haiku 4.5 is $1 / $5 per MTok in/out; Sonnet 5.5 is $2 / $10. Model IDs are set per route in env and must be in `pricing.ts`, the same pattern as the Resume Optimiser.

**Guardrails** ★:
- Per user: 60 questions/day, 40 statement uploads/month, and a US$3/month LLM soft cap after which Q&A is paused.
- Demo: 10 questions per IP per day.
- A global monthly breaker (default US$40).
- The Anthropic Console spend limit as the hard backstop.

### 7.4 Quality, accessibility and compatibility

- WCAG 2.2 AA. Meaning is always given as text, not colour alone. Keyboard support covers the whole approval flow. Motion respects `prefers-reduced-motion`.
- Mobile-first, from 360 px up. Latest Chrome, Safari, Firefox and Edge.
- Amounts use `tabular-nums` and SGD formatting (`S$1,234.56`). Dates are shown as `3 Oct 2026` in the Asia/Singapore timezone.

## 8. Look and feel (requirement)

The app must look like **the same family as the Resume Optimiser and portfolio**. It reuses their design tokens, typography and component conventions verbatim (see the Resume Optimiser's `ui-layout.md` §2 and `PLAN.md` §13).

- **Tokens**:
  - Light: `#fbfbf9` / `#1a1a1a` / muted `#5f5f5f` / rule `#e6e4df` / accent `#1f4e79` / accent-soft `#eef3f8`.
  - Dark: `#131416` / `#e8e6e1` / `#9a9a94` / `#2a2c30` / `#8fb4dc` / `#1b2733`.
  - `warn` and `danger` (plus their soft variants) as in the Resume Optimiser.
- **Type**: the Helvetica system stack and no web fonts. Medium-weight headlines with tight tracking, 24 px section headings, 15–17 px body text, and `tabular-nums` for all numbers.
- **Surfaces**: hairline rules instead of cards, no shadows, 6–10 px radius, pill chips.
- **Layout adaptation for data** ★ (Q49): a single centred column, 680 px on landing, import and settings and **960 px on data screens** (Overview, Transactions, Subscriptions). There's a top nav and no sidebar. On mobile the nav collapses into a bottom tab bar (Overview, Transactions, Ask, Activity, More).
- **Charts** ★ (Q50, Q51): plain SVG with no chart library. Categories are told apart by **tints of the navy accent plus direct labels**; there's no rainbow palette. Bars and sparklines only, with no pie charts.
- **Hero**: the landing page only has a full-width background-image band with light and dark variants, the same as the Resume Optimiser ★ (Q54).
- **Motion**: the portfolio's `Reveal` fade-up (0.35 s, framer-motion), disabled under reduced motion.
- **Theme**: follows the system setting, with a header toggle saved in `localStorage` and no flash on load.
- **Branding**: a text wordmark ("Finance Agent", working title), and "Built by toninmotion" in the footer linking to the portfolio.
- **Approval card styling**: an accent-soft background and a 1 px accent left rule, so it's the one deliberate "attention" surface in the app. Approve is the primary button, Reject is secondary.

## 9. Data (high level)

The main entities are `users`, `accounts`, `statements`, `transactions`, `merchants`, `categories`, `rules`, `tags`, `subscriptions`, `bills`, `alerts`, `budgets`, `proposed_actions`, `audit_log` and `usage`. Money is stored as **integer minor units + ISO currency**, never as floats. See [`architecture.md`](architecture.md) §5 for the entity diagram.

## 10. AI / agent design summary

| Step | Type | Model ★ | Why |
|---|---|---|---|
| Parse a known bank layout | Deterministic TS | — | Accuracy, cost and speed. The LLM isn't needed. |
| Parse an unknown layout | LLM structured output, then a deterministic reconciliation verifier | Haiku 4.5 | Coverage without a parser per bank. Reconciliation catches hallucinated rows. |
| Normalise merchants and categorise | Rules/map first, then a batched LLM with enum-constrained output | Haiku 4.5 | Cheap and bulk. Corrections become rules, so LLM calls shrink over time. |
| Detectors | Deterministic SQL/TS | — | Explainable and testable. |
| Explain an alert, draft a cancellation or waiver | LLM text | Haiku 4.5 | Low stakes, short output. |
| Q&A agent | LLM tool loop with read tools + `propose_action`, plus the numbers guard | **Sonnet 5.5** (confirmed), adaptive thinking, effort starting at `low`/`medium` and tuned by eval | Cheapest model with the tool-use judgement this needs. Every model is configurable per route in env; any change of model is your call. |

## 11. Success metrics

| Metric | Target |
|---|---|
| Statements that reconcile (supported banks) | ≥ 98% auto-reconciled, and 100% either reconciled or flagged |
| Field accuracy on the golden statement set (date, amount, sign) | ≥ 99.5% |
| First-pass category accuracy (golden set) | ≥ 85% |
| User correction rate after 30 days | < 5% of new transactions |
| Subscription detection (golden set) | precision ≥ 90%, recall ≥ 80% |
| Q&A numeric correctness (golden questions vs SQL ground truth) | 100% of numbers match, ≥ 95% of questions answered correctly overall |
| Unapproved writes | **0**, proven by tests and audit |
| Cross-tenant data access | **0**, proven by the RLS test suite |
| Activation: signup → first committed import | ≥ 50% |
| Weekly active users / monthly active users | ≥ 40% |
| LLM cost per active user per month | ≤ US$2 |

## 12. Release plan (phases) ★ (Q61)

**Status:** Phase 0 and Phase 1 are done: DBS + UOB card import with approval (1a), and categorisation, Transactions, Overview, Ask and the demo (1b). Phase 2a (the detectors: subscriptions, bills, alerts) is done. Phase 2b (DBS/POSB and UOB bank-account statements, PDF + CSV, with transfer pairing, income and card payments confirmed from the bank) is done: every planted transfer and card payment in the synthetic household pairs. Its parsers are marked provisional until real bank-account samples pass the local reconciliation test. Other banks (OCBC first) move to Phase 4. Phase 3a (the action engine: every allowed action type except `export_csv` goes through one registry with server-built previews, version checks, an audit trail and 30-day undo; Activity with filters and batch approval; Ask proposes changes but never applies them) is done, and the zero-unapproved-write test passes. Phase 3b is done too: budgets on Overview and "am I on track?" in Ask (ASK-10), Settings (accounts, budgets, rules, export, delete account), manual bills, drafts (ACT-2), `export_csv` (audited, sign-in within 10 minutes, AUTH-3) and the in-app weekly digest (DET-10). Phase 3 is complete; Phase 4 (polish and publish) is next. Two choices differ from the plan: Claude is called through the official Anthropic SDK rather than the Vercel AI SDK, and the charts are plain HTML/CSS rather than SVG (still no chart library). The README lists what was built and how it was verified.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundations** | New repo, scaffold copied from Resume Optimiser conventions, Better Auth, RLS schema, envelope encryption, **PII firewall + no-PII test harness**, design shell, demo seed generator, synthetic DBS/UOB card-statement fixture generator | Two-user isolation and no-PII tests pass; shell matches the mockups |
| **1. MVP: ingest → categorise → overview → ask** | **DBS + UOB credit-card PDF parsers**, multi-card split, reconciliation, dedupe, card-payment detection, import preview + approve, categorisation + correction rules, Overview, Transactions, Ask (read-only), demo | Golden-set targets for parsing and categories met; Q&A numbers guard at 100% |
| **2. Detect + bank accounts** | (2b) DBS/POSB and UOB bank-account statements (PDF + CSV) with transfer pairing, income and card payments confirmed from the bank; (2a) subscriptions, price rise, unusual charges, card fees, card due dates, Alerts, Subscriptions screen, daily cron | Detector golden-set targets met; every synthetic transfer and card payment paired; real bank samples reconcile locally |
| **3. Act** | (3a) The full proposal/approval engine (all ACT-* items), agent proposals in chat, Activity + undo; (3b) drafts, budgets and bills screens, weekly digest, export | Zero unapproved-write tests pass; audit complete |
| **4. Polish + publish** | LLM-fallback parser, more banks (OCBC cards and accounts first), admin page, privacy page, portfolio project page + blog post with eval results | Public launch |

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Bank layouts change and break parsers | Fingerprint plus a version per parser; the LLM fallback; reconciliation catches silent breaks; an admin alert when a bank's failure rate rises |
| Too few real samples to build parsers | DBS and UOB card samples were received and used only locally. Synthetic fixture PDFs are generated in the same layouts with fake data (like the Resume Optimiser's `evals/generate-fixtures`). **Real statements are never committed**: they're git-ignored and used only by a local test that checks reconciliation and the no-PII guarantee. `npm run check:pii` plus CI block personal data from the repo. |
| Users are reluctant to upload financial data | SG hosting, encryption, discarding files, masking, wipe button, a demo-first experience, a plain-English privacy page |
| The LLM produces wrong numbers | Tools-only arithmetic plus the numbers guard plus "View N transactions" provenance |
| Prompt injection via descriptors | Treat descriptors as data, enum outputs, read-only tools, server-enforced approvals |
| Regulatory creep (advice, payments) | Hard non-goals, refusal behaviour for advice, a "not financial advice" notice |
| Cost spikes from heavy Q&A users | Per-user caps, prompt caching, global breaker |
| Vercel Hobby terms (non-commercial) | Confirmed: no monetisation, so Hobby fits. Revisit only if that changes. |

## 14. Open questions

Resolved in v2: sample statements (DBS + UOB cards), auth (Better Auth), Q&A model (Sonnet 5.5), monetisation (none).

1. **More card samples** to harden the parsers. These would help: a December/January statement (year rollover), one with an instalment plan or cash advance, one with a supplementary card, and one with a late fee or interest. Older months from the same cards are fine.
2. **Name**: is "Finance Agent" fine, or do you have a brand name and domain in mind (e.g. a `*.toninmotion` subdomain)?
3. **Google sign-in**: include it at launch, or keep to email + passkeys only? ★ The default is email + passkeys only.
4. **Hero image**: will you supply light/dark hero images as you did for the Resume Optimiser?
5. **DBS/POSB and UOB bank-account samples** (Phase 2b): one statement PDF from each, plus the CSV export if your internet banking offers one. They stay local and git-ignored, and are used only to verify the provisional parsers. OCBC is deferred to Phase 4.
