import "server-only";
import type { PlayerSession } from "./playerSession";
import { games, players } from "./gameStore";

/** Recover only a player's own room, including sessions created before this feature. */
export function getCurrentGame(session: PlayerSession | null) {
    if (!session) return null;
    for (const playerId of Array.from(session.playerIds).reverse()) {
        const player = players.get(playerId);
        if (!player) continue;
        const game = Array.from(games.values()).find(candidate => candidate.id === player.gameId);
        if (game) return { code: game.code, playerId, href: `/game/${game.code}?playerId=${encodeURIComponent(playerId)}` };
    }
    return null;
}
