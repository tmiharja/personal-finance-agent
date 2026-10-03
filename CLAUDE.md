# Rules for this repository

## 1. No PII, ever (this repo is public)

- **Never commit real statements or anything derived from them.** That covers PDFs, CSVs, screenshots, extracted text, real merchant/amount rows, real dates and real card product combinations. Real samples live only in git-ignored `private/` or `tests/private/`.
- **Never commit personal data**: names (other than the fictional personas in fixtures), addresses, postal codes, NRIC/FIN, phone numbers, email addresses, or card or bank account numbers (full, partial or last-4).
- **Test data is synthetic only.** Use `npm run fixtures` (fictional "Alex Tan", well-known test card numbers, "SYNTHETIC TEST DATA" watermark and PDF metadata).
- **Run `npm run check:pii` before every commit.** CI runs it on every push and pull request. If it flags something, remove the data. Never weaken the check to make it pass.
- Logs, error messages, eval reports and PR descriptions follow the same rule: report codes and counts, never values.
