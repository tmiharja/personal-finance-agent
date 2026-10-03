import { and, eq, isNull, sql } from "drizzle-orm";
import { TRANSFER_MERCHANTS } from "@/lib/kinds";
import { sqlRows } from "@/db/rows";
import { categories, transactions } from "@/db/schema";
import type { Tx } from "@/db/with-user";

/**
 * Transfer pairing (PRD IMP-10, DET-7). Money moving between your own accounts
 * shows up twice: as money out of one account and money in to another. Both
 * legs are paired and excluded from spend and income.
 *
 *  - Card bills: a bank account's "DBS card payment" ↔ the DBS card's own
 *    payment row (opposite amount, ±3 days). Before that card statement is
 *    imported, the bank row is still linked to the card it paid (the card
 *    whose statement balance it matches, or the only card from that issuer),
 *    so the card shows as paid.
 *  - Transfers: a FAST/PayNow/funds transfer out of one account ↔ one in to
 *    another of your accounts, opposite amount, ±3 days.
 *
 * A pair is made only when it is unambiguous: each leg has exactly one
 * candidate on the other side. Anything else is left for you to review. The
 * matcher is a pure function, so the import preview can count pairs without
 * writing anything; the approved import applies them in its own transaction.
 */

export const PAIR_WINDOW_DAYS = 3;

export { TRANSFER_MERCHANTS };

export type PairCandidate = {
  id: string;
  accountId: string;
  accountKind: "card" | "deposit";
  /** The account's bank (cards) — POSB counts as DBS. */
  bank: string;
  date: string;
  /** Signed: + money out of the account, − money in. */
  cents: number;
  kind: string;
  merchant: string;
};

export type CardStatementRef = {
  accountId: string;
  bank: string;
  statementDate: string;
  totalCents: number | null;
};

export type Pairing = {
  pairs: { a: string; b: string; accountA: string; accountB: string; type: "card" | "transfer" }[];
  /** Bank card payments with no card row yet, linked to the card they paid. */
  links: { id: string; cardAccountId: string }[];
};

const days = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** "DBS card payment" → "DBS"; "Card payment" → null (issuer unknown). */
export function issuerOf(merchant: string): string | null {
  const m = /^(\w+) card payment$/i.exec(merchant);
  return m ? m[1]!.toUpperCase().replace("POSB", "DBS") : null;
}

const isTransferLeg = (c: PairCandidate) =>
  c.accountKind === "deposit" && (c.kind === "transfer" || TRANSFER_MERCHANTS.has(c.merchant));

/** Pairs `a` with the one `b` that matches it, if exactly one does, and vice versa. */
function uniquePairs(
  outs: PairCandidate[],
  ins: PairCandidate[],
  ok: (o: PairCandidate, i: PairCandidate) => boolean,
): [PairCandidate, PairCandidate][] {
  const forOut = new Map(outs.map((o) => [o.id, ins.filter((i) => ok(o, i))]));
  const forIn = new Map(ins.map((i) => [i.id, outs.filter((o) => ok(o, i))]));
  const pairs: [PairCandidate, PairCandidate][] = [];
  for (const o of outs) {
    const match = forOut.get(o.id)!;
    if (match.length === 1 && forIn.get(match[0]!.id)!.length === 1) pairs.push([o, match[0]!]);
  }
  return pairs;
}

export function matchTransfers(
  candidates: readonly PairCandidate[],
  cardStatements: readonly CardStatementRef[] = [],
): Pairing {
  const near = (a: PairCandidate, b: PairCandidate) =>
    a.accountId !== b.accountId && a.cents === -b.cents && days(a.date, b.date) <= PAIR_WINDOW_DAYS;

  // Card bills: bank leg (money out, deposit) ↔ card leg (credit on the card).
  const bankPays = candidates.filter(
    (c) => c.accountKind === "deposit" && c.kind === "card_payment" && c.cents > 0,
  );
  const cardPays = candidates.filter(
    (c) => c.accountKind === "card" && c.kind === "card_payment" && c.cents < 0,
  );
  const cardPairs = uniquePairs(bankPays, cardPays, (b, c) => {
    const issuer = issuerOf(b.merchant);
    return near(b, c) && (!issuer || issuer === c.bank);
  });
  const paired = new Set(cardPairs.flatMap(([b, c]) => [b.id, c.id]));

  // A bank payment whose card statement isn't imported yet: link it to its card.
  const links: Pairing["links"] = [];
  const cardsByBank = new Map<string, Set<string>>();
  for (const s of cardStatements) {
    if (!cardsByBank.has(s.bank)) cardsByBank.set(s.bank, new Set());
    cardsByBank.get(s.bank)!.add(s.accountId);
  }
  for (const b of bankPays) {
    if (paired.has(b.id)) continue;
    const issuer = issuerOf(b.merchant);
    if (!issuer) continue;
    // The card whose latest statement before the payment was for exactly this amount…
    const latest = new Map<string, CardStatementRef>();
    for (const s of cardStatements)
      if (s.bank === issuer && s.statementDate < b.date) latest.set(s.accountId, s);
    const exact = [...latest.values()].filter((s) => s.totalCents === b.cents);
    const cards = cardsByBank.get(issuer);
    const target =
      exact.length === 1 ? exact[0]!.accountId : cards?.size === 1 ? [...cards][0]! : null;
    if (target) links.push({ id: b.id, cardAccountId: target });
  }

  // Own transfers: transfer-like legs in two different deposit accounts.
  const legs = candidates.filter(isTransferLeg);
  const transferPairs = uniquePairs(
    legs.filter((c) => c.cents > 0),
    legs.filter((c) => c.cents < 0),
    near,
  );

  return {
    pairs: [
      ...cardPairs.map(([b, c]) => ({
        a: b.id,
        b: c.id,
        accountA: b.accountId,
        accountB: c.accountId,
        type: "card" as const,
      })),
      ...transferPairs.map(([o, i]) => ({
        a: o.id,
        b: i.id,
        accountA: o.accountId,
        accountB: i.accountId,
        type: "transfer" as const,
      })),
    ],
    links,
  };
}

/** Every unpaired row that could be one leg of a transfer, for this user (RLS). */
export async function loadPairCandidates(
  tx: Tx,
): Promise<{ candidates: PairCandidate[]; cardStatements: CardStatementRef[] }> {
  const rows = sqlRows<{
    id: string;
    account_id: string;
    account_kind: "card" | "deposit";
    bank: string;
    date: string;
    cents: string;
    kind: string;
    merchant: string | null;
  }>(
    await tx.execute(sql`
      select t.id, t.account_id, a.kind as account_kind, a.bank, t.txn_date::text as date,
             t.amount_cents::text as cents, t.kind, t.merchant_name as merchant
      from transactions t join accounts a on a.id = t.account_id
      where t.transfer_pair_id is null
        and (t.kind in ('card_payment', 'transfer')
             or t.merchant_name in ('PayNow transfer', 'FAST transfer', 'Funds transfer', 'Own account transfer'))
      order by t.txn_date, t.id`),
  );
  const statements = sqlRows<{
    account_id: string;
    bank: string;
    statement_date: string;
    total_cents: string | null;
  }>(
    await tx.execute(sql`
      select s.account_id, a.bank, s.statement_date::text, s.total_cents::text
      from statements s join accounts a on a.id = s.account_id
      where a.kind = 'card' order by s.statement_date`),
  );
  return {
    candidates: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountKind: r.account_kind,
      bank: r.bank,
      date: r.date,
      cents: Number(r.cents),
      kind: r.kind,
      merchant: r.merchant ?? "",
    })),
    cardStatements: statements.map((s) => ({
      accountId: s.account_id,
      bank: s.bank,
      statementDate: s.statement_date,
      totalCents: s.total_cents === null ? null : Number(s.total_cents),
    })),
  };
}

/**
 * Pairs every unambiguous transfer in the user's ledger. Paired rows become
 * transfers (excluded from spend and income) in the Transfers category; their
 * kind is kept, so the direction and what the bank called it stay visible.
 */
export async function pairTransfers(tx: Tx): Promise<{ pairs: number; links: number }> {
  const { candidates, cardStatements } = await loadPairCandidates(tx);
  const { pairs, links } = matchTransfers(candidates, cardStatements);
  if (!pairs.length && !links.length) return { pairs: 0, links: 0 };
  const [transfersCat] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, "Transfers"));
  const mark = (id: string, pairId: string | null, accountId: string) =>
    tx
      .update(transactions)
      .set({
        transferPairId: pairId ?? undefined,
        transferAccountId: accountId,
        isTransfer: true,
        ...(transfersCat
          ? { categoryId: transfersCat.id, categorySource: "system" as const, confidence: 1 }
          : {}),
        version: sql`${transactions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, id), isNull(transactions.transferPairId)));
  for (const p of pairs) {
    await mark(p.a, p.b, p.accountB);
    await mark(p.b, p.a, p.accountA);
  }
  for (const l of links) {
    await tx
      .update(transactions)
      .set({ transferAccountId: l.cardAccountId, updatedAt: new Date() })
      .where(and(eq(transactions.id, l.id), isNull(transactions.transferAccountId)));
  }
  return { pairs: pairs.length, links: links.length };
}

/** For the import preview: how many of a statement's rows would be paired. */
export function countNewPairs(pairing: Pairing, newIds: ReadonlySet<string>) {
  const pairs = pairing.pairs.filter((p) => newIds.has(p.a) || newIds.has(p.b));
  return {
    cardPayments: pairs.filter((p) => p.type === "card").length,
    transfers: pairs.filter((p) => p.type === "transfer").length,
    linkedCardPayments: pairing.links.filter((l) => newIds.has(l.id)).length,
  };
}
