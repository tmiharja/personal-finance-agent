import { decide } from "@/server/proposal-route";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return decide(request, (await params).id, "reject");
}
