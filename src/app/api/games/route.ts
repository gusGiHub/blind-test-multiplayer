import { withGameStore } from "@/src/lib/sharedStore";
import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import type { Player, Game } from "@/src/types/game";
import { games, players } from "@/src/lib/gameStore";

import { normalizeNickname } from "@/src/lib/gameValidation";
import { parseGameSettings } from "@/src/lib/gameSettings";

import { assignPlayerToSession, readPlayerSession } from "@/src/lib/playerSession";

const MAX_CODE_ATTEMPTS = 100;

async function handlePOST(request: Request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Le corps de la requête doit être un JSON valide." }, { status: 400 });
    }

    const nickname = normalizeNickname(body?.nickname);
    const questionCount = body?.questionCount;
    const settings = parseGameSettings(body?.settings);
    if (!settings) return NextResponse.json({ error: "Paramètres invalides : extrait de 1 à 30 secondes, temps de réponse au moins égal à l’extrait (120 secondes maximum) et pause de 0 à 30 secondes." }, { status: 400 });
    if (!nickname) {
        return NextResponse.json({ error: "Le pseudo doit contenir entre 1 et 30 caractères." }, { status: 400 });
    }
    if (typeof questionCount !== "number" || ![5, 10, 15].includes(questionCount)) {
        return NextResponse.json({ error: "Choisis 5, 10 ou 15 questions." }, { status: 400 });
    }

    const session = await readPlayerSession();
    let gameCode: string | undefined;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const candidate = randomInt(10000, 100000).toString();
        if (!games.has(candidate)) {
            gameCode = candidate;
            break;
        }
    }
    if (!gameCode) {
        return NextResponse.json({
            error: "Impossible de générer un code disponible. Réessaie dans quelques instants.",
        }, { status: 503 });
    }
    const playerID = crypto.randomUUID();
    const gameID = crypto.randomUUID();
    const player: Player = {
        id: playerID,
        gameId: gameID,
        nickname,
        score: 0,
        ready: false,
        readyRevision: 0,
    };

    const game: Game = {
        id: gameID,
        code: gameCode,
        questionCount,
        status: "lobby",
        hostId: playerID,
        settings,
    };
    const selectedPlaylist = session?.spotify?.selectedPlaylist;
    if (selectedPlaylist) {
        game.playlist = { id: selectedPlaylist.id, name: selectedPlaylist.name, url: selectedPlaylist.url };
        game.playlistRevision = 0;
    }

    games.set(gameCode, game);
    players.set(playerID, player);

    const response = NextResponse.json({
        game,
        player,
    });
    assignPlayerToSession(playerID, response, session);
    return response;
}

export const POST = withGameStore(handlePOST);
export const maxDuration = 60;
