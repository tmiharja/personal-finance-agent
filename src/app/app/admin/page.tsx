import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PageTitle from "@/components/app/page-title";
import { getDb } from "@/db/client";
import { BANK_LABEL, type Bank } from "@/lib/banks";
import { getAdminStats, isAdmin } from "@/server/admin/stats";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Admin" };

const h2 = "text-[17px] font-semibold";
const table = "tabular mt-3 w-full text-left text-[15px]";
const th = "border-b border-rule py-2 pr-4 text-[13px] font-medium text-muted";
const td = "border-b border-rule py-2 pr-4";
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
const usd = (n: number) => `US$${n.toFixed(2)}`;

const OK_OUTCOMES = new Set(["reconciled", "unreconciled", "no_balance"]);

/**
 * PRD OPS-3: how the service is doing (users, parsing, reconciliation, AI cost,
 * evals). Counts and costs only; it shows no one's financial data. Owner only:
 * anyone else gets a 404.
 */
export default async function AdminPage() {
  const user = await requireUser();
  if (!isAdmin(user)) notFound();
  const s = await getAdminStats(getDb());
  const methods = [...new Set(s.parsing.map((p) => p.method))];

  return (
    <>
      <PageTitle title="Admin">
        How the service is doing. Counts and costs only: no one&rsquo;s transactions, amounts or
        descriptors are shown here.
      </PageTitle>

      <section aria-labelledby="users-h" className="max-w-[720px]">
        <h2 id="users-h" className={h2}>
          Users
        </h2>
        <dl className="mt-3 grid grid-cols-3 gap-4 text-[15px]">
          {[
            ["Accounts", s.users.total],
            ["New in 30 days", s.users.last30],
            ["Open demo workspaces", s.users.demos],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-rule px-4 py-3">
              <dt className="text-[13px] text-muted">{k}</dt>
              <dd className="tabular text-[20px] font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="imports-h" className="mt-12 max-w-[720px]">
        <h2 id="imports-h" className={h2}>
          Imports by bank
        </h2>
        {s.imports.length === 0 ? (
          <p className="mt-3 text-[15px] text-muted">No imports yet.</p>
        ) : (
          <table className={table}>
            <thead>
              <tr>
                <th className={th}>Bank</th>
                <th className={th}>Statements imported</th>
                <th className={th}>Read by AI</th>
              </tr>
            </thead>
            <tbody>
              {s.imports.map((i) => (
                <tr key={i.bank}>
                  <td className={td}>{BANK_LABEL[i.bank as Bank] ?? i.bank}</td>
                  <td className={td}>{i.committed}</td>
                  <td className={td}>{i.ai}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="parsing-h" className="mt-12 max-w-[720px]">
        <h2 id="parsing-h" className={h2}>
          Parsing, last 30 days
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Every upload, by how it was read. A failure is any upload that didn&rsquo;t produce a
          preview.
        </p>
        {methods.length === 0 ? (
          <p className="mt-3 text-[15px] text-muted">No uploads yet.</p>
        ) : (
          <table className={table}>
            <thead>
              <tr>
                <th className={th}>Read by</th>
                <th className={th}>Uploads</th>
                <th className={th}>Failed</th>
                <th className={th}>Reconciled</th>
                <th className={th}>Failure codes</th>
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => {
                const rows = s.parsing.filter((p) => p.method === m);
                const total = rows.reduce((t, r) => t + r.n, 0);
                const failed = rows.filter((r) => !OK_OUTCOMES.has(r.outcome));
                const nFailed = failed.reduce((t, r) => t + r.n, 0);
                const rec = rows.find((r) => r.outcome === "reconciled")?.n ?? 0;
                const unrec = rows.find((r) => r.outcome === "unreconciled")?.n ?? 0;
                return (
                  <tr key={m}>
                    <td className={td}>{m === "ai" ? "AI fallback" : "Parsers"}</td>
                    <td className={td}>{total}</td>
                    <td className={td}>
                      {nFailed} ({pct(nFailed, total)})
                    </td>
                    <td className={td}>{pct(rec, rec + unrec)}</td>
                    <td className={`${td} text-[13px] [overflow-wrap:anywhere] text-muted`}>
                      {failed.map((f) => `${f.outcome} ×${f.n}`).join(", ") || "none"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-[13px] text-muted">
          Imported card and account statements: {s.reconciliation.reconciled} reconciled,{" "}
          {s.reconciliation.unreconciled} accepted without reconciling, {s.reconciliation.unchecked}{" "}
          with no balances to check.
        </p>
      </section>

      <section aria-labelledby="cost-h" className="mt-12 max-w-[720px]">
        <h2 id="cost-h" className={h2}>
          AI cost this month
        </h2>
        <p className="mt-1 text-[15px]">
          <span className="tabular font-semibold">{usd(s.cost.totalUsd)}</span>{" "}
          <span className="text-muted">
            of the {usd(s.cost.budgetUsd)} monthly limit ({pct(s.cost.totalUsd, s.cost.budgetUsd)})
          </span>
        </p>
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Use</th>
              <th className={th}>Calls</th>
              <th className={th}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {s.cost.byRoute.map((r) => (
              <tr key={r.route}>
                <td className={td}>
                  {{ ask: "Ask", categorise: "Categorising", extract: "Reading unknown layouts" }[
                    r.route
                  ] ?? r.route}
                </td>
                <td className={td}>{r.calls}</td>
                <td className={td}>{usd(r.usd)}</td>
              </tr>
            ))}
            {s.cost.archivedUsd > 0 && (
              <tr>
                <td className={td}>Deleted accounts and demos</td>
                <td className={td}>–</td>
                <td className={td}>{usd(s.cost.archivedUsd)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="evals-h" className="mt-12 max-w-[720px]">
        <h2 id="evals-h" className={h2}>
          Eval scoreboard
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Run {s.evals.generatedOn} over the synthetic household (<code>npm run eval</code>). The AI
          fallback was scored with{" "}
          {s.evals.ai === "live" ? "the real model" : "the offline stand-in"}.
        </p>
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Measure</th>
              <th className={th}>Result</th>
              <th className={th}>Target</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {s.evals.suites.map((e) => (
              <tr key={e.id}>
                <td className={td}>
                  {e.label}
                  {e.note && <span className="block text-[12px] text-muted">{e.note}</span>}
                </td>
                <td className={td}>
                  {e.pass}/{e.total}
                </td>
                <td className={td}>{Math.round(e.target * 100)}%</td>
                <td className={`${td} ${e.ok ? "" : "text-danger"}`}>
                  {e.ok ? "Pass" : "Below target"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
