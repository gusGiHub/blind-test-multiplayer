import "server-only";
import { NextResponse } from "next/server";
import { readPlayerSession } from "./playerSession";
import { gameEngines } from "./gameStore";
import { getHostGame, GameActionError } from "./gameActions";
import { normalizeGameCode } from "./gameValidation";
import { isSameOrigin, getSpotifyAccessToken, SPOTIFY_PLAYBACK_SCOPES, controlSpotifyPlayback, renewSpotifyPlaybackToken, SpotifyError } from "./spotify";

export async function handleGamePlayback(request: Request, params: Promise<{ code: string }>, action: "token" | "device" | "play") {
    const headers = { "Cache-Control": "private, no-store" };
    if (!isSameOrigin(request)) return NextResponse.json({ error: "Origine de la demande invalide." }, { status: 403, headers });
    const code = normalizeGameCode((await params).code);
    if (!code) return NextResponse.json({ error: "Code invalide." }, { status: 400, headers });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Demande invalide." }, { status: 400, headers }); }
    if (typeof body?.playerId !== "string") return NextResponse.json({ error: "Joueur invalide." }, { status: 400, headers });
    const session = await readPlayerSession();
    if (!session) return NextResponse.json({ error: "Reconnecte ta session." }, { status: 401, headers });
    if (!session.playerIds.has(body.playerId)) return NextResponse.json({ error: "Ce joueur ne fait pas partie de ta session." }, { status: 403, headers });
    try {
        getHostGame(code, body.playerId);
        const connection = session.spotify;
        if (!connection) throw new SpotifyError("Connecte Spotify avant d’activer le son.", 401);
        const token = await getSpotifyAccessToken(session, SPOTIFY_PLAYBACK_SCOPES);
        if (action === "token") return NextResponse.json({ accessToken: token, expiresAt: connection.expiresAt }, { headers });
        connection.playbackDevices ??= new Map();
        if (action === "device") {
            if (body.deviceId === null) {
                if (connection.playbackDevices.get(code) === body.expectedDeviceId) connection.playbackDevices.delete(code);
                return NextResponse.json({ ready: false }, { headers });
            }
            if (typeof body.deviceId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(body.deviceId)) throw new SpotifyError("Lecteur Spotify invalide.", 400);
            if (body.recover !== undefined && typeof body.recover !== "boolean") throw new SpotifyError("Demande d’activation invalide.", 400);
            if (body.recover === true) {
                request.signal.throwIfAborted();
                await renewSpotifyPlaybackToken(session);
                if (session.spotify !== connection || request.signal.aborted) throw new SpotifyError("Activation du lecteur annulée.", 409);
            }
            // An SDK ID alone is insufficient: make Spotify accept the browser device first.
            await controlSpotifyPlayback(session, body.deviceId, "transfer", undefined, 0, request.signal);
            if (request.signal.aborted) throw new SpotifyError("Activation du lecteur annulée.", 409);
            if (session.spotify !== connection) throw new SpotifyError("La connexion Spotify a changé. Réactive le son.", 409);
            connection.playbackDevices.set(code, body.deviceId);
            return NextResponse.json({ ready: true }, { headers });
        }
        if (!Number.isSafeInteger(body.questionNumber) || body.questionNumber <= 0) throw new SpotifyError("Question invalide.", 400);
        const engine = gameEngines.get(code);
        const progress = engine?.getState();
        const playback = engine?.getPlayback();
        if (!progress || progress.status !== "question" || progress.question.number !== body.questionNumber || !playback || Date.now() < playback.startsAt || Date.now() >= playback.endsAt) throw new SpotifyError("La lecture est fermée pour cette question.", 409);
        const deviceId = connection.playbackDevices.get(code);
        if (!deviceId) throw new SpotifyError("Active le son Spotify dans le lobby.", 409);
        try {
            await controlSpotifyPlayback(session, deviceId, "play", playback.trackId, playback.offsetMs + Math.max(0, Date.now() - playback.startsAt));
        } catch (error) {
            if (error instanceof SpotifyError && error.code === "DEVICE_UNAVAILABLE" && connection.playbackDevices.get(code) === deviceId) connection.playbackDevices.delete(code);
            throw error;
        }
        const latest = engine!.getState();
        if (latest.status !== "question" || latest.question.number !== body.questionNumber || Date.now() >= playback.endsAt) {
            if (latest.status !== "question" || latest.question.number === body.questionNumber) await controlSpotifyPlayback(session, deviceId, "pause");
            throw new SpotifyError("La question est terminée.", 409);
        }
        return NextResponse.json({ playing: true, endsAt: playback.endsAt }, { headers });
    } catch (error) {
        const known = error instanceof SpotifyError || error instanceof GameActionError;
        return NextResponse.json({ error: known ? error.message : "Le lecteur Spotify ne répond pas. Réessaie.", ...(error instanceof SpotifyError && error.code ? { code: error.code } : {}),
            ...(error instanceof SpotifyError && error.diagnostic ? { diagnostic: { ...error.diagnostic, recovery: body.recover === true } } : {})
        }, { status: known ? error.status : 502, headers });
    }
}
