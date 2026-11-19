import type { Socket } from "socket.io-client";
import type { GameSnapshot } from "@/src/types/gameProgress";

export type GameConnection = Pick<Socket, "on" | "emit" | "connect" | "disconnect" | "connected">;
const routes: Record<string, { route: string; success: string; error: string }> = {
    start_game: { route: "start", success: "game_started", error: "start_game_error" },
    reveal_answer: { route: "reveal", success: "game_updated", error: "game_action_error" },
    next_question: { route: "next", success: "game_updated", error: "game_action_error" },
    submit_answer: { route: "answer", success: "answer_accepted", error: "answer_error" },
    select_playlist: { route: "playlist", success: "playlist_updated", error: "playlist_error" },
    rematch_game: { route: "rematch", success: "game_reset", error: "game_action_error" },
    set_ready: { route: "ready", success: "player_ready", error: "ready_error" },
};

/** Same UI events as Socket.IO; on Vercel, all authority stays in authenticated HTTP APIs. */
export function createHttpGameConnection(): GameConnection {
    const handlers = new Map<string, ((data?: unknown) => void)[]>();
    let active = false;
    let identity: { code: string; playerId: string } | null = null;
    let previous: GameSnapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let generation = 0;
    const controllers = new Set<AbortController>();
    const notify = (event: string, data?: unknown) => { if (active) for (const handler of handlers.get(event) ?? []) handler(data); };
    const request = async (route: string, payload: Record<string, unknown>) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), route === "start" ? 55000 : 15000);
        controllers.add(controller);
        try {
            const response = await fetch(`/api/games/${encodeURIComponent(String(payload.code))}/${route}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
                cache: "no-store", credentials: "same-origin", signal: controller.signal,
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? "La demande a échoué.");
            return data;
        } finally { clearTimeout(timeout); controllers.delete(controller); }
    };
    const poll = async () => {
        if (!active || !identity || polling) return;
        polling = true;
        const currentGeneration = generation;
        try {
            const snapshot: GameSnapshot = await request("access", identity);
            if (!active || currentGeneration !== generation) return;
            if (!previous) notify("game_joined", snapshot);
            else {
                const old = previous;
                const oldProgress = JSON.stringify(old.progress);
                const changedRound = (snapshot.game.round ?? 0) !== (old.game.round ?? 0);
                if (changedRound) notify("game_reset", snapshot);
                else if (old.progress?.status === "question" && snapshot.progress?.status === "question" && old.progress.question.number === snapshot.progress.question.number) {
                    const counts = snapshot.progress.participation;
                    if (counts && JSON.stringify(counts) !== JSON.stringify(old.progress.participation)) notify("answer_count_updated", { ...counts, questionNumber: snapshot.progress.question.number, round: snapshot.game.round ?? 0 });
                }
                else if (oldProgress !== JSON.stringify(snapshot.progress)) notify("game_updated", snapshot);
                // Lobby membership/readiness can change on a different Vercel instance.
                for (const player of snapshot.players) {
                    const previousPlayer = old.players.find(candidate => candidate.id === player.id);
                    if (!previousPlayer) notify("player_joined", { player });
                    if (!previousPlayer || player.readyRevision !== previousPlayer.readyRevision) notify("player_ready", { player, round: snapshot.game.round ?? 0 });
                }
                if ((snapshot.game.playlistRevision ?? 0) !== (old.game.playlistRevision ?? 0)) notify("playlist_updated", { game: snapshot.game, serverTime: snapshot.serverTime });
                // Receipts are private: only the current player's access response is used.
                if (snapshot.ownAnswer && JSON.stringify(snapshot.ownAnswer) !== JSON.stringify(old.ownAnswer)) notify("answer_accepted", snapshot.ownAnswer);
            }
            previous = snapshot;
            if (!connection.connected) { connection.connected = true; notify("game_joined", snapshot); }
        } catch (error) {
            if (active && currentGeneration === generation) {
                connection.connected = false;
                notify("connect_error", { error: error instanceof Error ? error.message : "Connexion interrompue." });
            }
        } finally {
            polling = false;
            if (active) timer = setTimeout(() => void poll(), 1000);
        }
    };
    const connection = {
        connected: false,
        on(event: string, handler: (data?: unknown) => void) { handlers.set(event, [...handlers.get(event) ?? [], handler]); return connection; },
        connect() { active = true; connection.connected = true; notify("connect"); return connection; },
        disconnect() {
            generation++; clearTimeout(timer); controllers.forEach(controller => controller.abort());
            connection.connected = false; notify("disconnect"); active = false; return connection;
        },
        emit(event: string, payload: Record<string, unknown>) {
            if (!active) return connection;
            if (event === "join_game") {
                identity = { code: String(payload.code), playerId: String(payload.playerId) };
                previous = null; generation++; clearTimeout(timer);
                if (!polling) void poll();
                return connection;
            }
            const command = routes[event];
            if (!command || !identity || payload.code !== identity.code || payload.playerId !== identity.playerId) return connection;
            const currentGeneration = generation;
            void request(command.route, payload).then(data => {
                if (currentGeneration === generation) notify(command.success, data);
            }).catch(error => {
                if (currentGeneration === generation) notify(command.error, { error: error instanceof Error ? error.message : "La demande a échoué.", questionNumber: payload.questionNumber, revision: payload.revision, round: payload.round });
            });
            return connection;
        },
    };
    return connection as unknown as GameConnection;
}
