import { withGameStore } from "@/src/lib/sharedStore";
import { handleGamePlayback } from "@/src/lib/gamePlayback";
async function handlePOST(request: Request, { params }: { params: Promise<{ code: string }> }) {
    return handleGamePlayback(request, params, "play");
}

export const POST = withGameStore(handlePOST);
export const maxDuration = 60;
