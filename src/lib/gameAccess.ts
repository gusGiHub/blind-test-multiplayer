import { withGameStore } from "@/src/lib/sharedStore";
import { advanceOverdueGame } from "@/src/lib/gameDeadlines";
import { NextResponse } from "next/server";
import { games, players, gameEngines } from "@/src/lib/gameStore";
import { getPublicGameProgress, getGamePlayers } from "@/src/lib/gameView";
import { normalizeGameCode } from "@/src/lib/gameValidation";
import { readPlayerSession } from "@/src/lib/playerSession";

async function getAccess(codeInput: string, playerId: unknown) {
    const code = normalizeGameCode(codeInput);
    if (!code) {
        return NextResponse.json({ error: "Le code doit contenir 5 chiffres." }, { status: 400 });
    }


    if (typeof playerId !== "string" || !playerId) {
        return NextResponse.json({ error: "L’identifiant du joueur est requis." }, { status: 400 });
    }

    const session = await readPlayerSession();
    if (!session) {
        return NextResponse.json({ error: "Session absente ou expirée. Crée ou rejoins une partie." }, { status: 401 });
    }
    if (!session.playerIds.has(playerId)) {
        return NextResponse.json({ error: "Ce joueur n’appartient pas à ta session." }, { status: 403 });
    }

    const game = games.get(code);
    if (!game) {
        return NextResponse.json({ error: "Partie introuvable." }, { status: 404 });
    }
    const player = players.get(playerId);
    if (!player || player.gameId !== game.id) {
        return NextResponse.json({ error: "Joueur introuvable dans cette partie." }, { status: 404 });
    }

    advanceOverdueGame(code);
    const gamePlayers = getGamePlayers(code);
    const answer = gameEngines.get(code)?.getAnswer(playerId);
    const ownAnswer = answer ? { ...answer, ...(game.round !== undefined ? { round: game.round } : {}) } : null;
    return NextResponse.json({ game, players: gamePlayers, progress: getPublicGameProgress(code), ownAnswer, ownReview: gameEngines.get(code)?.getOwnReview?.(playerId) ?? null, serverTime: Date.now() }, {
        headers: { "Cache-Control": "private, no-store" },
    });
}

export const readGameAccess = withGameStore(getAccess);
