import "server-only";
import { games, players, gameEngines, startingGames } from "./gameStore";
import { createGameEngine, createGameEngineFromSpotifyPreview, GameEngineError } from "./gameEngine";
import { getMusicCatalog } from "./musicCatalog";
import { getGameUpdate, getGamePlayers } from "./gameView";
import type { GameUpdate, LobbyPlaylistUpdate } from "@/src/types/gameProgress";
import type { AnswerSubmission } from "@/src/types/gameplay";

import type { PlayerSession } from "./playerSession";
import { parseGameSettings } from "./gameSettings";
import { createSpotifyQuestionPreview } from "./spotifyQuestionPreview";
import { SPOTIFY_PLAYBACK_SCOPES, SpotifyError, controlSpotifyPlayback } from "./spotify";

export class GameActionError extends Error {
    constructor(message: string, public readonly status: number) { super(message); }
}

export function getHostGame(code: string, playerId: string) {
    const game = games.get(code);
    if (!game) throw new GameActionError("Partie introuvable.", 404);
    const player = players.get(playerId);
    if (!player || player.gameId !== game.id) throw new GameActionError("Joueur introuvable dans cette partie.", 404);
    if (player.id !== game.hostId) throw new GameActionError("Seul l’hôte peut contrôler la partie.", 403);
    return game;
}

export async function startGame(code: string, playerId: string, session: PlayerSession, signal?: AbortSignal): Promise<GameUpdate> {
    const game = getHostGame(code, playerId);
    if (game.status !== "lobby") throw new GameActionError("Cette partie a déjà commencé.", 409);
    if (startingGames.has(code)) throw new GameActionError("La préparation de cette partie est déjà en cours.", 409);
    if (getGamePlayers(code).some(player => !player.ready)) throw new GameActionError("Tous les joueurs doivent se déclarer prêts avant de démarrer.", 409);
    startingGames.add(code);
    try {
        const settings = parseGameSettings(game.settings);
        if (!settings) throw new GameActionError("Les paramètres de cette partie sont invalides.", 400);
        const connection = session.spotify;
        const boundPlaylist = game.playlist;
        const playlist = boundPlaylist ? connection?.playlists.get(boundPlaylist.id) : connection?.selectedPlaylist;
        if (boundPlaylist && !playlist) throw new GameActionError("Reconnecte Spotify si nécessaire, puis choisis à nouveau la playlist dans le lobby.", 409);
        let engine;
        if (connection && playlist) {
            if (!SPOTIFY_PLAYBACK_SCOPES.every(scope => connection.grantedScopes?.includes(scope))) throw new GameActionError("Reconnecte Spotify pour autoriser la lecture audio.", 403);
            if (!connection.playbackDevices?.get(code)) throw new GameActionError("Active le son Spotify dans ce lobby avant de démarrer.", 409);
            const deviceId = connection.playbackDevices.get(code)!;
            try { await controlSpotifyPlayback(session, deviceId, "transfer"); }
            catch (error) {
                if (error instanceof SpotifyError && error.code === "DEVICE_UNAVAILABLE" && connection.playbackDevices.get(code) === deviceId) connection.playbackDevices.delete(code);
                throw error;
            }
            // Each launch owns a fresh draw; an owner's preview never fixes the next game.
            const preview = await createSpotifyQuestionPreview(session, playlist.id, game.questionCount, signal, settings.excerptSeconds, settings.mode === "qcm", boundPlaylist);
            if (session.spotify !== connection || (boundPlaylist ? game.playlist?.id !== playlist.id : connection.selectedPlaylist?.id !== playlist.id) || connection.playbackDevices?.get(code) !== deviceId) {
                throw new GameActionError("La playlist ou le compte Spotify a changé pendant la préparation. Réessaie.", 409);
            }
            engine = createGameEngineFromSpotifyPreview(preview, { automatic: true, settings });
        } else {
            const catalog = getMusicCatalog();
            if (catalog.length === 0) throw new GameActionError("Connecte Spotify et sélectionne une playlist dans « Mes playlists Spotify », puis réessaie de démarrer.", 422);
            engine = createGameEngine(catalog, game.questionCount, { automatic: true, settings });
        }
        signal?.throwIfAborted();
        if (session.expiresAt <= Date.now()) throw new GameActionError("Ta session a expiré. Rejoins une nouvelle partie.", 401);
        if (games.get(code) !== game || game.status !== "lobby") throw new GameActionError("Cette partie a changé pendant sa préparation. Actualise la page.", 409);
        if (getGamePlayers(code).some(player => !player.ready)) throw new GameActionError("Un joueur n’est plus prêt. Réessaie depuis le lobby.", 409);
        // Commit only after generation succeeds. This engine owns a copy of its answers.
        gameEngines.set(code, engine);
        game.status = "question";
        game.questionSource = connection && playlist ? "spotify" : "local";
        if (playlist && connection) game.playlist = { id: playlist.id, name: playlist.name, url: playlist.url };
        return getGameUpdate(code);
    } finally {
        startingGames.delete(code);
    }
}

export function selectGamePlaylist(code: string, playerId: string, session: PlayerSession, playlistId: string): LobbyPlaylistUpdate {
    const game = getHostGame(code, playerId);
    if (game.status !== "lobby" || startingGames.has(code)) throw new GameActionError("La playlist est verrouillée pendant le démarrage et la partie.", 409);
    const connection = session.spotify;
    if (!connection) throw new GameActionError("Connecte Spotify pour choisir la playlist.", 401);
    const playlist = connection.playlists.get(playlistId);
    if (!playlist) throw new GameActionError("Choisis une playlist parmi celles chargées depuis ton compte Spotify.", 403);
    game.playlist = { id: playlist.id, name: playlist.name, url: playlist.url };
    game.playlistRevision = (game.playlistRevision ?? 0) + 1;
    if (connection.selectedPlaylist?.id !== playlist.id) delete connection.questionPreview;
    connection.selectedPlaylist = playlist;
    return { game: { ...game, playlist: { ...game.playlist } }, serverTime: Date.now() };
}
export function setPlayerReady(code: string, playerId: string, ready: boolean) {
    const game = games.get(code);
    const player = players.get(playerId);
    if (!game || !player || player.gameId !== game.id) throw new GameActionError("Joueur introuvable dans cette partie.", 404);
    if (game.status !== "lobby" || startingGames.has(code)) throw new GameActionError("Le statut prêt est verrouillé pendant le démarrage et la partie.", 409);
    if (player.ready !== ready) {
        player.ready = ready;
        player.readyRevision = (player.readyRevision ?? 0) + 1;
    }
    return { player: { ...player }, round: game.round ?? 0 };
}

export function rematchGame(code: string, playerId: string) {
    const game = getHostGame(code, playerId);
    if (game.status !== "finished" || startingGames.has(code)) throw new GameActionError("La revanche est disponible uniquement après la fin de la partie.", 409);
    for (const player of players.values()) if (player.gameId === game.id) {
        player.score = 0;
        player.ready = false;
        player.readyRevision = (player.readyRevision ?? 0) + 1;
    }
    gameEngines.delete(code);
    game.round = (game.round ?? 0) + 1;
    game.status = "lobby";
    delete game.questionSource;
    return { game: { ...game }, players: getGamePlayers(code), progress: null, serverTime: Date.now() };
}
export function progressGame(code: string, playerId: string, action: "reveal" | "next", questionNumber: number): GameUpdate {
    const game = getHostGame(code, playerId);
    const engine = gameEngines.get(code);
    if (!engine) throw new GameActionError("Cette partie ne dispose pas de questions. Recrée une partie.", 409);
    const progress = action === "reveal" ? engine.revealAnswer(questionNumber) : engine.nextQuestion(questionNumber);
    if (action === "reveal") {
        for (const result of engine.getRoundPoints()) {
            const player = players.get(result.playerId);
            if (player?.gameId === game.id) player.score += result.points;
        }
    }
    game.status = progress.status;
    return getGameUpdate(code);
}

export function getGameActionError(error: unknown): { error: string; status: number } {
    if (error instanceof SpotifyError) return { error: error.message, status: error.status };
    if (error instanceof GameActionError) return { error: error.message, status: error.status };
    if (error instanceof GameEngineError) {
        return { error: error.message, status: ["INSUFFICIENT_TRACKS", "INSUFFICIENT_CHOICES"].includes(error.code) ? 422 : 409 };
    }
    return { error: "Impossible de modifier la partie.", status: 500 };
}
export function submitGameAnswer(code: string, playerId: string, questionNumber: number, value: string, kind: "choice" | "text" = "choice", submission?: AnswerSubmission) {
    const game = games.get(code);
    const player = players.get(playerId);
    if (!game || !player || player.gameId !== game.id) throw new GameActionError("Joueur introuvable dans cette partie.", 404);
    const engine = gameEngines.get(code);
    if (!engine) throw new GameActionError("Cette partie n’a pas commencé.", 409);
    if ((game.settings?.mode === "free") !== (kind === "text")) throw new GameActionError("Le format de réponse ne correspond pas au mode de jeu.", 400);
    return engine.submitAnswer(playerId, questionNumber, value, submission);
}
