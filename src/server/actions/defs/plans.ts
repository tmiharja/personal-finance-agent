import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, bills, budgets, categories } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { todaySgt } from "@/server/agent/period";
import { ProposalError } from "../common";
import { register, type Versions } from "../engine";
import {
  categoryRefSchema,
  categoryVersion,
  lastDecision,
  payloadIs,
  resolveCategory,
  sgd,
} from "./shared";

/** Budgets and bills you set yourself (or Ask suggests, for your approval). */

const cents = z.number().int().min(0).max(100_000_000);

const budgetPayload = z.object({ categoryId: z.uuid(), monthlyAmountCents: cents.nullable() });

const budgetVersion = async (tx: Tx, categoryId: string, lock: boolean): Promise<Versions> => {
  // A new budget has no row to lock: lock the category instead, so two
  // approvals for it run one after the other and the second sees the first.
  if (lock)
    await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .for("update");
  const [b] = await tx
    .select({ amount: budgets.monthlyAmountCents })
    .from(budgets)
    .where(eq(budgets.categoryId, categoryId));
  const last = await lastDecision(tx, ["set_budget"], payloadIs("categoryId", categoryId));
  return { [`budget:${categoryId}`]: `${b ? b.amount : "none"}|${last}` };
};

async function budgetAmount(tx: Tx, categoryId: string): Promise<number | null> {
  const [b] = await tx
    .select({ amount: budgets.monthlyAmountCents })
    .from(budgets)
    .where(eq(budgets.categoryId, categoryId));
  return b?.amount ?? null;
}

async function writeBudget(tx: Tx, userId: string, categoryId: string, amount: number | null) {
  if (amount === null) {
    await tx.delete(budgets).where(eq(budgets.categoryId, categoryId));
    return;
  }
  await tx
    .insert(budgets)
    .values({ userId, categoryId, monthlyAmountCents: amount })
    .onConflictDoUpdate({
      target: [budgets.userId, budgets.categoryId],
      set: { monthlyAmountCents: amount },
    });
}

register({
  type: "set_budget",
  /** A monthly budget for one spending category; null removes it. */
  input: z.intersection(categoryRefSchema, z.object({ monthlyAmountCents: cents.nullable() })),
  payload: budgetPayload,
  undoable: true,
  ledger: false,
  async prepare(tx, _userId, input) {
    const cat = await resolveCategory(tx, input);
    if (cat.kind !== "expense") throw new ProposalError("invalid_category");
    const before = await budgetAmount(tx, cat.id);
    const was = before === null ? null : sgd(before);
    const to = input.monthlyAmountCents;
    return {
      payload: { categoryId: cat.id, monthlyAmountCents: to },
      preview: {
        title:
          to === null
            ? `Remove the ${cat.name} budget`
            : `Budget ${sgd(to)} a month for ${cat.name}`,
        lines: [was ? `It was ${was} a month.` : "No budget before."],
        affected: before === to ? 0 : 1,
      },
    };
  },
  versions: async (tx, p, lock) => ({
    ...(await budgetVersion(tx, p.categoryId, lock)),
    ...(await categoryVersion(tx, p.categoryId)),
  }),
  async execute(tx, userId, p) {
    const before = await budgetAmount(tx, p.categoryId);
    await writeBudget(tx, userId, p.categoryId, p.monthlyAmountCents);
    return { result: { changed: 1 }, inverse: { monthlyAmountCents: before } };
  },
  async undo(tx, userId, p, inverse) {
    const { monthlyAmountCents } = z
      .object({ monthlyAmountCents: cents.nullable() })
      .parse(inverse);
    await writeBudget(tx, userId, p.categoryId, monthlyAmountCents);
  },
});

/** The next date on or after today that falls on `day` (clamped to short months). */
export function nextDueDate(day: number, today = todaySgt()): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const on = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
  };
  const thisMonth = on(y, m);
  if (Number(thisMonth.slice(8)) >= d) return thisMonth;
  return m === 12 ? on(y + 1, 1) : on(y, m + 1);
}

const payee = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[\p{L}\p{N} &'.,()/-]+$/u, "letters, numbers and simple punctuation only");

const billFields = z.object({
  dueDay: z.number().int().min(1).max(31),
  expectedAmountCents: cents.nullable(),
  accountId: z.uuid().nullable(),
});
const addPayload = billFields.extend({ payee });

async function accountName(tx: Tx, accountId: string | null) {
  if (!accountId) return null;
  const [a] = await tx
    .select({ name: accounts.productName })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!a) throw new ProposalError("invalid_reference");
  return a.name;
}

const billLines = (b: z.output<typeof billFields>, paidFrom: string | null) => [
  `Due on day ${b.dueDay} of each month${b.expectedAmountCents !== null ? `, about ${sgd(b.expectedAmountCents)}` : ""}.`,
  ...(paidFrom ? [`Paid from ${paidFrom}.`] : []),
];

register({
  type: "add_bill",
  input: addPayload.partial({ expectedAmountCents: true, accountId: true }),
  payload: addPayload,
  undoable: true,
  ledger: false,
  async prepare(tx, _userId, input) {
    const p = {
      payee: input.payee,
      dueDay: input.dueDay,
      expectedAmountCents: input.expectedAmountCents ?? null,
      accountId: input.accountId ?? null,
    };
    const [exists] = await tx
      .select({ id: bills.id })
      .from(bills)
      .where(sql`lower(${bills.payee}) = lower(${p.payee}) and ${bills.source} = 'manual'`);
    if (exists) throw new ProposalError("invalid_reference");
    return {
      payload: p,
      preview: {
        title: `Add a bill: ${p.payee}`,
        lines: billLines(p, await accountName(tx, p.accountId)),
        affected: 1,
      },
    };
  },
  async versions(tx, p) {
    const [b] = await tx
      .select({ id: bills.id })
      .from(bills)
      .where(sql`lower(${bills.payee}) = lower(${p.payee}) and ${bills.source} = 'manual'`);
    // The bill and everything about it: an undo after a later edit is refused.
    const snap = b ? await billSnapshot(tx, b.id, false) : undefined;
    return {
      [`bill:${p.payee.toLowerCase()}`]: b && snap ? `${b.id}|${billFieldsKey(snap)}` : "none",
      ...(b ? await billDecision(tx, b.id) : {}),
    };
  },
  async execute(tx, userId, p) {
    const [b] = await tx
      .insert(bills)
      .values({ userId, ...p, source: "manual", dueDate: nextDueDate(p.dueDay) })
      .returning({ id: bills.id });
    return { result: { billId: b!.id }, inverse: { billId: b!.id } };
  },
  async undo(tx, _userId, _p, inverse) {
    const { billId } = z.object({ billId: z.uuid() }).parse(inverse);
    await tx.delete(bills).where(eq(bills.id, billId));
  },
});

const updatePayload = billFields.extend({ billId: z.uuid() });

const billSnapshot = async (tx: Tx, billId: string, lock: boolean) => {
  const q = tx
    .select({
      dueDay: bills.dueDay,
      expectedAmountCents: bills.expectedAmountCents,
      accountId: bills.accountId,
      dueDate: bills.dueDate,
      payee: bills.payee,
      source: bills.source,
    })
    .from(bills)
    .where(eq(bills.id, billId));
  const [b] = lock ? await q.for("update") : await q;
  return b;
};

const billFieldsKey = (b: {
  dueDay: number | null;
  expectedAmountCents: number | null;
  accountId: string | null;
  dueDate: string | null;
}) => `${b.dueDay}|${b.expectedAmountCents ?? ""}|${b.accountId ?? ""}|${b.dueDate ?? ""}`;

/** The latest edit to a bill, so an undo older than it is refused. */
const billDecision = async (tx: Tx, billId: string): Promise<Versions> => ({
  [`bill-edit:${billId}`]: await lastDecision(tx, ["update_bill"], payloadIs("billId", billId)),
});

register({
  type: "update_bill",
  /** Change a manual bill's due day, amount or paying account. */
  input: billFields.partial().extend({ billId: z.uuid() }),
  payload: updatePayload,
  undoable: true,
  ledger: false,
  async prepare(tx, _userId, input) {
    const b = await billSnapshot(tx, input.billId, false);
    // Detected bills are rewritten by every detector run; only your own bills change.
    if (!b || b.source !== "manual") throw new ProposalError("invalid_reference");
    const p = {
      billId: input.billId,
      dueDay: input.dueDay ?? b.dueDay ?? 1,
      expectedAmountCents:
        input.expectedAmountCents !== undefined ? input.expectedAmountCents : b.expectedAmountCents,
      accountId: input.accountId !== undefined ? input.accountId : b.accountId,
    };
    const same =
      p.dueDay === b.dueDay &&
      p.expectedAmountCents === b.expectedAmountCents &&
      p.accountId === b.accountId;
    return {
      payload: p,
      preview: {
        title: `Update the bill: ${b.payee}`,
        lines: billLines(p, await accountName(tx, p.accountId)),
        affected: same ? 0 : 1,
      },
    };
  },
  async versions(tx, p, lock) {
    const b = await billSnapshot(tx, p.billId, lock);
    return {
      [`bill:${p.billId}`]: b ? billFieldsKey(b) : "missing",
      ...(await billDecision(tx, p.billId)),
    };
  },
  async execute(tx, _userId, p) {
    const before = (await billSnapshot(tx, p.billId, false))!;
    await tx
      .update(bills)
      .set({
        dueDay: p.dueDay,
        expectedAmountCents: p.expectedAmountCents,
        accountId: p.accountId,
        dueDate: nextDueDate(p.dueDay),
      })
      .where(eq(bills.id, p.billId));
    return {
      result: { changed: 1 },
      inverse: {
        dueDay: before.dueDay,
        expectedAmountCents: before.expectedAmountCents,
        accountId: before.accountId,
        dueDate: before.dueDate,
      },
    };
  },
  async undo(tx, _userId, p, inverse) {
    const inv = z
      .object({
        dueDay: z.number().nullable(),
        expectedAmountCents: z.number().nullable(),
        accountId: z.uuid().nullable(),
        dueDate: z.string().nullable(),
      })
      .parse(inverse);
    await tx.update(bills).set(inv).where(eq(bills.id, p.billId));
  },
});
