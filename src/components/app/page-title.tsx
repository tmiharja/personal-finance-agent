import type { ReactNode } from "react";

export default function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-10">
      <h1 className="text-[30px] font-medium tracking-tight">{title}</h1>
      {children && <p className="mt-2 max-w-[640px] text-[15px] text-muted">{children}</p>}
    </div>
  );
}
