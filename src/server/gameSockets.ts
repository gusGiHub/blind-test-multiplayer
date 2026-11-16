import type { Server, Socket } from "socket.io";
import type { GameSnapshot } from "../types/gameProgress";
import { normalizeGameCode } from "../lib/gameValidation";
import { createGameScheduler } from "./gameScheduler";
import type { GameUpdate } from "../types/gameProgress";

function readIdentity(payload: unknown) {
    if (!payload || typeof payload !== "object" || !("code" in payload) || !("playerId" in payload) ||
        typeof payload.code !== "string" || typeof payload.playerId !== "string" || !payload.playerId) return null;
    const code = normalizeGameCode(payload.code);
    return code ? { code, playerId: payload.playerId } : null;
}

/** API routes own the state; this adapter only validates commands and broadcasts public views. */
export function registerGameSockets(io: Server, apiBaseUrl: string) {
    const callApi = (socket: Socket, code: string, route: string, body: unknown) => fetch(`${apiBaseUrl}/api/games/${code}/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: socket.request.headers.cookie ?? "" },
        body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(route === "start" ? 35000 : 10000),
    });

    const scheduler = createGameScheduler({
        async execute(code, action, playerId, cookie, questionNumber, round) {
            const response = await fetch(`${apiBaseUrl}/api/games/${code}/${action}`, {
                method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ playerId, questionNumber, round }), signal: AbortSignal.timeout(10000), cache: "no-store",
            });
            if (!response.ok) throw new Error("Automatic transition failed");
            return response.json() as Promise<GameUpdate>;
        },
        publish: (code, update) => { io.to(code).emit("game_updated", update); },
        failed: code => { io.to(code).emit("game_timer_error", { error: "La progression automatique est interrompue. L’hôte peut continuer avec les boutons de secours." }); },
    });
    io.httpServer?.once("close", () => scheduler.dispose());
    io.on("connection", (socket) => {
        let joining = false;
        let commanding = false;

        socket.on("join_game", async (payload: unknown) => {
            if (joining) return;
            const identity = readIdentity(payload);
            if (!identity) {
                socket.emit("join_game_error", { error: "Les informations de connexion sont invalides." });
                return;
            }
            const { code, playerId } = identity;
            if (socket.data.gameCode && socket.data.gameCode !== code) {
                socket.emit("join_game_error", { error: "Cette connexion appartient déjà à une autre partie." });
                return;
            }
            joining = true;
            let joined = false;
            try {
                const response = await callApi(socket, code, "access", { playerId });
                const data = await response.json();
                if (!socket.connected) return;
                if (!response.ok) {
                    socket.emit("join_game_error", { error: data.error });
                    return;
                }
                await socket.join(code);
                joined = true;
                // Subscribe first, then read again so a start during admission cannot be missed.
                const latest = await callApi(socket, code, "access", { playerId });
                if (!latest.ok) throw new Error("Access changed during admission");
                const snapshot: GameSnapshot = await latest.json();
                const player = snapshot.players.find(candidate => candidate.id === playerId && candidate.gameId === snapshot.game.id);
                if (!player) throw new Error("Player missing from snapshot");
                if (!socket.connected) return;
                socket.data.gameCode = code;
                socket.data.playerId = playerId;
                socket.emit("game_joined", snapshot);
                io.to(code).emit("player_joined", { player });
            } catch {
                if (joined) {
                    await socket.leave(code);
                    delete socket.data.gameCode;
                    delete socket.data.playerId;
                }
                socket.emit("join_game_error", { error: "Impossible de vérifier la partie. Réessaie dans quelques instants." });
            } finally {
                joining = false;
            }
        });

        const command = (event: string, route: "start" | "reveal" | "next" | "answer" | "playlist" | "rematch" | "ready") => {
            const errorEvent = route === "ready" ? "ready_error" : route === "start" ? "start_game_error" : route === "answer" ? "answer_error" : route === "playlist" ? "playlist_error" : "game_action_error";
            socket.on(event, async (payload: unknown) => {
                const identity = readIdentity(payload);
                if (!identity || socket.data.gameCode !== identity.code || socket.data.playerId !== identity.playerId) {
                    socket.emit(errorEvent, { error: "Rejoins la partie avec ton joueur avant de la contrôler." });
                    return;
                }
                const questionNumber = payload && typeof payload === "object" && "questionNumber" in payload ? payload.questionNumber : undefined;
                if (route !== "start" && route !== "playlist" && route !== "rematch" && route !== "ready" && (!Number.isSafeInteger(questionNumber) || (questionNumber as number) <= 0)) {
                    socket.emit(errorEvent, { error: "Le numéro de question est invalide." });
                    return;
                }
                if (commanding && route !== "answer") {
                    socket.emit(errorEvent, { error: "Une commande est déjà en cours." });
                    return;
                }
                if (route !== "answer") commanding = true;
                try {
                    const choiceId = payload && typeof payload === "object" && "choiceId" in payload ? payload.choiceId : undefined;
                    const text = payload && typeof payload === "object" && "text" in payload ? payload.text : undefined;
                    const confirmed = payload && typeof payload === "object" && "confirmed" in payload ? payload.confirmed : undefined;
                    const revision = payload && typeof payload === "object" && "revision" in payload ? payload.revision : undefined;
                    const playlistId = payload && typeof payload === "object" && "playlistId" in payload ? payload.playlistId : undefined;
                    const round = payload && typeof payload === "object" && "round" in payload ? payload.round : undefined;
                    const ready = payload && typeof payload === "object" && "ready" in payload ? payload.ready : undefined;
                    const response = await callApi(socket, identity.code, route, { playerId: identity.playerId, questionNumber, choiceId, text, confirmed, revision, playlistId, round, ready });
                    const data = await response.json();
                    if (!response.ok) {
                        socket.emit(errorEvent, { error: data.error, questionNumber, revision, round });
                        return;
                    }
                    if (route === "answer") {
                        socket.emit("answer_accepted", data);
                        if (data.confirmed !== false) {
                            // The API owns the state. Publish only aggregate participation,
                            // never the private answer contained in its access snapshot.
                            try {
                                const latest = await callApi(socket, identity.code, "access", { playerId: identity.playerId });
                                if (latest.ok) {
                                    const snapshot: GameSnapshot = await latest.json();
                                    if (snapshot.progress?.status === "question" && snapshot.progress.question.number === data.questionNumber && (snapshot.game.round ?? 0) === (data.round ?? 0) && snapshot.progress.participation) {
                                        const { answered, total } = snapshot.progress.participation;
                                        io.to(identity.code).emit("answer_count_updated", { questionNumber: data.questionNumber, round: snapshot.game.round ?? 0, answered, total });
                                    }
                                }
                            } catch { /* An unavailable counter must not invalidate an accepted answer. */ }
                        }
                    }
                    else if (route === "ready") io.to(identity.code).emit("player_ready", data);
                    else if (route === "playlist") io.to(identity.code).emit("playlist_updated", data);
                    else if (route === "rematch") {
                        scheduler.stop(identity.code);
                        io.to(identity.code).emit("game_reset", data);
                    }
                    else {
                        io.to(identity.code).emit(route === "start" ? "game_started" : "game_updated", data);
                        scheduler.schedule(data, identity.playerId, socket.request.headers.cookie ?? "");
                    }
                } catch {
                    socket.emit(errorEvent, { error: "Impossible de contacter le serveur de la partie.", questionNumber,
                        ...(payload && typeof payload === "object" && "round" in payload ? { round: payload.round } : {}),
                        ...(payload && typeof payload === "object" && "revision" in payload ? { revision: payload.revision } : {}) });
                } finally {
                    if (route !== "answer") commanding = false;
                }
            });
        };
        command("start_game", "start");
        command("reveal_answer", "reveal");
        command("next_question", "next");
        command("submit_answer", "answer");
        command("select_playlist", "playlist");
        command("rematch_game", "rematch");
        command("set_ready", "ready");
    });
}
