import { z } from "zod";
import { EXPORT_MAX_ROWS, countExport, exportFilterSchema } from "@/server/finance/export";
import { ProposalError } from "../common";
import { register } from "../engine";
import { plural } from "./shared";

/**
 * export_csv: recorded like any change, so Activity shows every export. It
 * writes nothing, so there is nothing to undo (ACT-9). The file itself is built
 * by the export route right after, under the same filter.
 */
register({
  type: "export_csv",
  input: exportFilterSchema,
  payload: z.object({ filter: exportFilterSchema, rows: z.number().int() }),
  undoable: false,
  ledger: false,
  directOnly: true,
  async prepare(tx, _userId, filter) {
    const rows = await countExport(tx, filter);
    if (rows > EXPORT_MAX_ROWS) throw new ProposalError("too_many_rows");
    const scope = [
      filter.from || filter.to ? `${filter.from ?? "start"} to ${filter.to ?? "now"}` : null,
      filter.category,
      filter.merchant,
    ].filter(Boolean);
    return {
      payload: { filter, rows },
      preview: {
        title: `Export ${plural(rows, "transaction")} to CSV`,
        lines: [scope.length ? `Filtered: ${scope.join(", ")}.` : "All transactions."],
        affected: rows,
      },
    };
  },
  versions: async () => ({}),
  execute: async (_tx, _userId, p) => ({ result: { rows: p.rows }, inverse: null }),
});
