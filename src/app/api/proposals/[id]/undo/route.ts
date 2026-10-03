import { decide } from "@/server/proposal-route";

/** ACT-9: undo an executed change within 30 days, if nothing it touched has changed since. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return decide(request, (await params).id, "undo");
}
