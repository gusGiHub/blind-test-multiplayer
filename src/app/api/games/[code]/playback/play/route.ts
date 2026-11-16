import { handleGamePlayback } from "@/src/lib/gamePlayback";
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
    return handleGamePlayback(request, params, "play");
}
