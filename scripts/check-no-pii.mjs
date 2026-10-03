// Blocks personal data from entering this public repository.
// Scans every tracked or new (non-ignored) file and fails on:
//   - Luhn-valid card numbers (13-19 digits, spaced/dashed/plain), except public test PANs
//   - NRIC/FIN numbers (checksum-validated)
//   - email addresses outside an allowlist
//   - +65 phone numbers and SG postal codes other than the fictional 000000
//   - PDFs that are not synthetic fixtures, and images outside docs/ or public/
//   - any entry in the local, git-ignored .pii-denylist (one string per line, e.g. your
//     name, street, card last-4 + product). Keep it local; never commit it.
// Findings print file:line and the rule only, never the matched value, so CI logs stay clean.
//
// Usage: npm run check:pii

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";

const VARIANTS_DIR = "evals/fixtures/synthetic/variants";
const VARIANTS = existsSync(`${VARIANTS_DIR}/manifest.json`)
  ? JSON.parse(readFileSync(`${VARIANTS_DIR}/manifest.json`, "utf8")).variants
  : [];

const TEST_PANS = new Set([
  "4111111111111111",
  "5555555555554444",
  "4012888888881881",
  "4000056655665556",
  "4242424242424242",
  "5105105105105100",
  "378282246310005",
]);
const EMAIL_ALLOW = [
  /^noreply@anthropic\.com$/i,
  // example.com/.org/.net and their subdomains are reserved (RFC 2606).
  /@([\w-]+\.)*example\.(com|org|net)$/i,
  /^git@github\.com$/i,
];
const IMAGE_DIRS = [/^docs\//, /^public\//];
const SYNTHETIC_PDF_DIR = /^evals\/fixtures\/synthetic\//;
const SYNTHETIC_MARK = "SYNTHETIC TEST DATA";
const SKIP = [/^package-lock\.json$/, /^scripts\/check-no-pii\.mjs$/];
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|heic)$/i;

const luhn = (num) => {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let n = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
};

const nricValid = (id) => {
  const w = [2, 7, 6, 5, 4, 3, 2];
  const p = id[0];
  let s = [...id.slice(1, 8)].reduce((a, c, i) => a + Number(c) * w[i], 0);
  if (p === "T" || p === "G") s += 4;
  if (p === "M") s += 3;
  const st = "JZIHGFEDCBA";
  const fg = "XWUTRQPNMLK";
  const m = "KLJNPQRTUWX";
  const r = s % 11;
  const expected = p === "S" || p === "T" ? st[r] : p === "F" || p === "G" ? fg[r] : m[10 - r];
  return expected === id[8];
};

const denylist = existsSync(".pii-denylist")
  ? readFileSync(".pii-denylist", "utf8")
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"))
  : [];

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((f) => f && existsSync(f) && !SKIP.some((r) => r.test(f)));

const findings = [];
const flag = (file, line, rule) => findings.push(`${file}${line ? `:${line}` : ""}  ${rule}`);

function scanText(file, text) {
  text.split("\n").forEach((line, i) => {
    const ln = i + 1;
    for (const m of line.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
      const num = m[0].replace(/[ -]/g, "");
      // A plain 13-digit epoch-millisecond timestamp (2015–2040, e.g. in drizzle/meta)
      // isn't a card number: no card network issues 13-digit numbers starting 1 or 2.
      const epochMs = /^\d{13}$/.test(m[0]) && Number(num) > 1.42e12 && Number(num) < 2.21e12;
      if (
        !epochMs &&
        num.length >= 13 &&
        num.length <= 19 &&
        luhn(num) &&
        !TEST_PANS.has(num) &&
        !/^0+$/.test(num)
      )
        flag(file, ln, "card-number");
    }
    for (const m of line.matchAll(/\b[STFGM]\d{7}[A-Z]\b/g))
      if (nricValid(m[0])) flag(file, ln, "nric-fin");
    for (const m of line.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      if (
        !EMAIL_ALLOW.some((r) => r.test(m[0])) &&
        !/@\d/.test(m[0]) &&
        !/\.(png|svg|js|ts|mjs|json)$/i.test(m[0])
      )
        flag(file, ln, "email");
    }
    if (/\+65[\s-]?[689]\d{3}[\s-]?\d{4}\b/.test(line)) flag(file, ln, "sg-phone");
    for (const m of line.matchAll(/SINGAPORE\s*\(?S?\)?\s*(\d{6})\b/gi))
      if (m[1] !== "000000") flag(file, ln, "sg-postal-code");
    const lower = line.toLowerCase();
    denylist.forEach(
      (term, k) => lower.includes(term) && flag(file, ln, `denylist entry #${k + 1}`),
    );
  });
}

for (const file of files) {
  if (IMAGE.test(file)) {
    if (!IMAGE_DIRS.some((r) => r.test(file)))
      flag(file, 0, "image outside docs/ or public/ (could be a screenshot of real data)");
    continue;
  }
  if (/\.pdf$/i.test(file)) {
    if (!SYNTHETIC_PDF_DIR.test(file)) {
      flag(file, 0, "PDF outside evals/fixtures/synthetic/");
      continue;
    }
    try {
      // pdf.js decrypts metadata; encrypted fixtures list their fictional password in the manifest.
      const variant = VARIANTS.find((v) => `${VARIANTS_DIR}/${v.file}` === file);
      const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)), {
        ...(variant?.password ? { password: variant.password } : {}),
      });
      const { info } = await pdf.getMetadata();
      await pdf.loadingTask.destroy();
      if (!String(info?.Subject ?? "").includes(SYNTHETIC_MARK))
        flag(file, 0, "PDF is not marked as synthetic");
    } catch {
      flag(file, 0, "PDF could not be verified as synthetic");
    }
    continue;
  }
  if (BINARY.test(file)) continue;
  scanText(file, readFileSync(file, "utf8"));
}

if (findings.length) {
  console.error(
    `check:pii found ${findings.length} problem(s). Remove the data; do not weaken this check.\n`,
  );
  for (const f of findings) console.error("  " + f);
  process.exit(1);
}
console.log(
  `check:pii OK (${files.length} files${denylist.length ? `, ${denylist.length} local denylist entries` : ""})`,
);
