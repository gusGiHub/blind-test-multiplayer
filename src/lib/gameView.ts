import "server-only";
import { games, players, gameEngines } from "./gameStore";
import type { GameProgress, GameUpdate } from "@/src/types/gameProgress";

export function getGamePlayers(code: string) {
    const game = games.get(code);
    return Array.from(players.values()).filter(player => player.gameId === game?.id).map(player => ({ ...player, ...(game?.settings?.revealMode === "end" && game.status !== "finished" ? { score: 0 } : {}) }));
}

export function getPublicGameProgress(code: string): GameProgress | null {
    const engine = gameEngines.get(code);
    if (!engine) return null;
    const progress = engine.getState();
    const participants = getGamePlayers(code);
    if (progress.status === "question") {
        const answered = participants.filter(player => {
            const receipt = engine.getAnswer(player.id);
            return receipt !== null && receipt.confirmed !== false;
        }).length;
        return { ...progress, participation: { answered, total: participants.length } };
    }
    if (progress.status === "result") {
        if (!progress.answer) return progress;
        const points = new Map(engine.getRoundPoints().map(result => [result.playerId, result]));
        return { ...progress, scores: participants.map(player => ({
            playerId: player.id, nickname: player.nickname, total: player.score,
            points: points.get(player.id)?.points ?? 0, correct: points.get(player.id)?.correct ?? false,
        })) };
    }
    if (progress.status === "finished") {
        const sorted = participants.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        let rank = 1;
        return { ...progress, ranking: sorted.map((player, index) => {
            if (index > 0 && sorted[index - 1].score !== player.score) rank = index + 1;
            return { playerId: player.id, nickname: player.nickname, score: player.score, rank };
        }) };
    }
    return progress;
}

export function getGameUpdate(code: string): GameUpdate {
    return { game: { ...games.get(code)! }, progress: getPublicGameProgress(code)!, players: getGamePlayers(code), serverTime: Date.now() };
}
