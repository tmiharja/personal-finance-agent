import { money } from "@/lib/format";
import type { Figure } from "@/server/agent/tools";

/**
 * The answer's mini chart (PRD ASK-4), built from the tool result, never from
 * model text. One series, one colour; every value is printed, so nothing
 * depends on colour or hover.
 */
export default function AskFigure({ figure }: { figure: Figure }) {
  const max = Math.max(...figure.points.map((p) => p.cents), 1);
  if (figure.kind === "bars") {
    return (
      <figure className="mt-3" aria-label={figure.title}>
        <ul className="tabular space-y-1 text-[12px]">
          {figure.points.map((p) => (
            <li key={p.label} className="grid grid-cols-[96px_1fr_auto] items-center gap-2">
              <span className="truncate">{p.label}</span>
              <span className="h-2.5" aria-hidden>
                <span
                  className="block h-full rounded-r bg-accent"
                  style={{ width: `${Math.max(1, (Math.max(0, p.cents) / max) * 100)}%` }}
                />
              </span>
              <span className="text-right text-muted">{money(p.cents)}</span>
            </li>
          ))}
        </ul>
      </figure>
    );
  }
  const many = figure.points.length > 6;
  return (
    <figure className="mt-3" aria-label={figure.title}>
      <div className="flex h-20 items-end gap-[2px] border-b border-rule" aria-hidden>
        {figure.points.map((p, i) => (
          <span
            key={p.label}
            title={`${p.label}: ${money(p.cents)}`}
            className={`block flex-1 rounded-t ${i === figure.points.length - 1 ? "bg-accent" : "bg-chart-context"}`}
            style={{
              height: `${Math.max(0, (p.cents / max) * 100)}%`,
              maxWidth: many ? undefined : 40,
            }}
          />
        ))}
      </div>
      <ul className="tabular mt-1 flex gap-[2px] text-[10px] text-muted">
        {figure.points.map((p) => (
          <li
            key={p.label}
            className="flex-1 truncate text-center"
            style={{ maxWidth: many ? undefined : 40 }}
          >
            {many ? p.label.slice(5) : money(p.cents)}
          </li>
        ))}
      </ul>
    </figure>
  );
}
