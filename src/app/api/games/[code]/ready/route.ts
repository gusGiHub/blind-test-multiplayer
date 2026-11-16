import { handleGameCommand } from "@/src/lib/gameCommand";

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
    return handleGameCommand(request, params, "ready");
}
