import type { ReactNode } from "react";

/** Stat tile: label, value (proportional figures), optional note. */
export default function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: ReactNode;
}) {
  return (
    <div className="border-t border-rule pt-3">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="mt-1 text-[24px] font-semibold tracking-tight">{value}</dd>
      {note && <dd className="mt-0.5 text-[12px] text-muted">{note}</dd>}
    </div>
  );
}
