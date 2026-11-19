import { withGameStore } from "@/src/lib/sharedStore";
import { games } from "@/src/lib/gameStore";
import { getGamePlayers } from "@/src/lib/gameView";
import { NextResponse } from "next/server";

async function handleGET(_request: Request, { params }: { params: Promise<{ code: string }> }) {

    const code = (await params).code;

    const game = games.get(code);

    if (!game) {
        return NextResponse.json({ error: "Partie introuvable." }, { status: 404 });
    }

    const gamePlayers = getGamePlayers(code);

    return NextResponse.json({ game, players: gamePlayers }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withGameStore(handleGET);
export const maxDuration = 60;
