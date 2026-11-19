import { games, gameEngines } from "./gameStore";
import { progressGame } from "./gameActions";

/** Called only after membership checks and while the shared store is locked.
 * No background timer is required after a Vercel Function returns.
 */
export function advanceOverdueGame(code: string) {
    if (process.env.VERCEL !== "1" && !process.env.SUPABASE_URL) return;
    const game = games.get(code);
    if (!game) return;
    for (let i = 0; i < 2; i++) {
        const progress = gameEngines.get(code)?.getState();
        const deadline = progress?.status === "question" ? progress.question.endsAt : progress?.status === "result" ? progress.endsAt : undefined;
        if (deadline === undefined || deadline > Date.now() || !progress || progress.status === "finished") return;
        progressGame(code, game.hostId, progress.status === "question" ? "reveal" : "next", progress.question.number);
    }
}
