import type { GameUpdate } from "../types/gameProgress";

interface ScheduledGame { update: GameUpdate; playerId: string; cookie: string; timer?: ReturnType<typeof setTimeout>; retries: number; }
export function createGameScheduler(options: {
    execute: (code: string, action: "reveal" | "next", playerId: string, cookie: string, questionNumber: number, round: number) => Promise<GameUpdate>;
    publish: (code: string, update: GameUpdate) => void;
    failed: (code: string) => void;
    now?: () => number;
}) {
    const games = new Map<string, ScheduledGame>();
    const now = options.now ?? Date.now;
    const stop = (code: string) => { const entry = games.get(code); if (entry?.timer) clearTimeout(entry.timer); games.delete(code); };
    const run = async (code: string, entry: ScheduledGame) => {
        if (games.get(code) !== entry) return;
        const progress = entry.update.progress;
        if (progress.status === "finished") return;
        try {
            const update = await options.execute(code, progress.status === "question" ? "reveal" : "next", entry.playerId, entry.cookie, progress.question.number, entry.update.game.round ?? 0);
            if (games.get(code) !== entry) return;
            options.publish(code, update);
            schedule(update, entry.playerId, entry.cookie);
        } catch {
            if (games.get(code) !== entry) return;
            if (++entry.retries <= 3) { entry.timer = setTimeout(() => void run(code, entry), 1000); entry.timer.unref?.(); }
            else { stop(code); options.failed(code); }
        }
    };
    const schedule = (update: GameUpdate, playerId: string, cookie: string) => {
        const code = update.game.code;
        stop(code);
        const progress = update.progress;
        const deadline = progress.status === "question" ? progress.question.endsAt : progress.status === "result" ? progress.endsAt : undefined;
        if (deadline === undefined) return;
        const entry: ScheduledGame = { update, playerId, cookie, retries: 0 };
        games.set(code, entry);
        entry.timer = setTimeout(() => void run(code, entry), Math.max(0, deadline - now()));
        entry.timer.unref?.();
    };
    return { schedule, stop, dispose: () => { for (const code of games.keys()) stop(code); } };
}
