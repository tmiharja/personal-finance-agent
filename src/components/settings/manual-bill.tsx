"use client";

import { useState } from "react";
import BillForm from "./bill-form";

/** "Change" on a bill you added: swaps in the form. */
export default function ManualBillEdit(props: {
  bill: { id: string; payee: string; dueDay: number | null; expectedAmountCents: number | null };
}) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="mt-2 w-full">
      <BillForm bill={props.bill} onDone={() => setOpen(false)} />
    </div>
  ) : (
    <button
      type="button"
      className="link text-[13px]"
      onClick={() => setOpen(true)}
      aria-label={`Change the ${props.bill.payee} bill`}
    >
      Change
    </button>
  );
}
