import { decideMany } from "@/server/proposal-route";

/** Batch approval (ACT-5): `{ ids: [...] }`, at most 50. */
export async function POST(request: Request) {
  return decideMany(request);
}
