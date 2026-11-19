import { withGameStore } from "@/src/lib/sharedStore";
import { handleGameCommand } from "@/src/lib/gameCommand";

async function handlePOST(request: Request, { params }: { params: Promise<{ code: string }> }) {
    return handleGameCommand(request, params, "reveal");
}

export const POST = withGameStore(handlePOST);
export const maxDuration = 60;
