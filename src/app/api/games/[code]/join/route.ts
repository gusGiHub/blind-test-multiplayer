import { withGameStore } from "@/src/lib/sharedStore";
import { NextResponse } from "next/server";
import { games, players, startingGames } from "@/src/lib/gameStore";

import { normalizeGameCode, normalizeNickname } from "@/src/lib/gameValidation";

import { assignPlayerToSession, readPlayerSession } from "@/src/lib/playerSession";

async function handlePOST(request: Request, { params }: { params: Promise<{ code: string }> }) {

    const code = normalizeGameCode((await params).code);
    if (!code) {
        return NextResponse.json({ error: "Le code doit contenir 5 chiffres." }, { status: 400 });
    }

    const game = games.get(code);

    if (!game) {
        return NextResponse.json({ error: "Partie introuvable. Vérifie le code." }, { status: 404 });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Le corps de la requête doit être un JSON valide." }, { status: 400 });
    }
    const nickname = normalizeNickname(body?.nickname);
    if (!nickname) {
        return NextResponse.json({ error: "Le pseudo doit contenir entre 1 et 30 caractères." }, { status: 400 });
    }

    const session = await readPlayerSession();

    if (game.status !== "lobby" || startingGames.has(code)) {
        return NextResponse.json({ error: "Cette partie a déjà commencé. Les inscriptions sont fermées." }, { status: 409 });
    }

    const playerID = crypto.randomUUID();

    const player = {
        id: playerID,
        gameId: game.id,
        nickname,
        score: 0,
        ready: false,
        readyRevision: 0,
    };

    players.set(playerID, player);

    const response = NextResponse.json(player, { status: 201 });
    assignPlayerToSession(playerID, response, session);
    return response;
}

export const POST = withGameStore(handlePOST);
export const maxDuration = 60;
