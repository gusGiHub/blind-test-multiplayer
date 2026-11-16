import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PlayerSession } from "./playerSession";
import type { SpotifyConnection, SpotifyPlaylist, SpotifyPlaylistTrack, SpotifyPlaybackDiagnostic } from "@/src/types/spotify";

export const SPOTIFY_PLAYBACK_SCOPES = ["streaming", "user-read-email", "user-read-private", "user-modify-playback-state"];
const SCOPES = ["playlist-read-private", "playlist-read-collaborative", ...SPOTIFY_PLAYBACK_SCOPES].join(" ");

export class SpotifyError extends Error {
    diagnostic?: SpotifyPlaybackDiagnostic;
    constructor(message: string, public status = 502, public retryAfter?: number, public code?: string) {
        super(message);
    }
}

export function getSpotifyConfig() {
    try {
        const appUrl = new URL(process.env.APP_URL ?? "http://127.0.0.1:3000");
        const loopback = ["127.0.0.1", "[::1]"].includes(appUrl.hostname);
        if ((appUrl.protocol !== "https:" && !(appUrl.protocol === "http:" && loopback)) ||
            appUrl.username || appUrl.password || appUrl.pathname !== "/" || appUrl.search || appUrl.hash) return null;
        const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
        if (!clientId) return null;
        return { clientId, appUrl: appUrl.origin, redirectUri: `${appUrl.origin}/api/spotify/callback` };
    } catch {
        return null;
    }
}

// The custom Next server may reconstruct request.url with its internal hostname.
// Use the browser Host header, but accept only our configured origin or local dev origins.
export function getRequestOrigin(request: Request): string {
    const internal = new URL(request.url);
    const host = request.headers.get("host") ?? internal.host;
    // Render terminates TLS and forwards HTTP. Trust only the configured host,
    // rather than accepting an arbitrary X-Forwarded-Host/Proto header.
    if (process.env.NODE_ENV === "production") {
        const configured = new URL(process.env.APP_URL ?? "");
        if (configured.protocol !== "https:" || host !== configured.host) throw new SpotifyError("Origine de la demande invalide.", 403);
        return configured.origin;
    }
    const external = new URL(`${internal.protocol}//${host}`);
    if (external.username || external.password || external.pathname !== "/" || external.search || external.hash) {
        throw new SpotifyError("Origine de la demande invalide.", 403);
    }
    return external.origin;
}

export function isSameOrigin(request: Request): boolean {
    try {
        const origin = getRequestOrigin(request);
        const configured = getSpotifyConfig()?.appUrl;
        const local = process.env.NODE_ENV !== "production" &&
            ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin);
        return request.headers.get("origin") === origin && (origin === configured || local);
    } catch {
        return false;
    }
}

export function beginSpotifyAuthorization(session: PlayerSession, returnTo?: string): string {
    const config = getSpotifyConfig();
    if (!config) throw new SpotifyError("La connexion Spotify n’est pas configurée.", 503);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("hex");
    session.spotifyAuthorizationId = state;
    session.spotifyAuthorization = { state, verifier, redirectUri: config.redirectUri, expiresAt: Date.now() + 10 * 60 * 1000, ...(returnTo ? { returnTo } : {}) };
    const url = new URL("https://accounts.spotify.com/authorize");
    url.search = new URLSearchParams({
        client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri,
        scope: SCOPES, state, code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), show_dialog: "true",
    }).toString();
    return url.toString();
}

export function consumeSpotifyAuthorization(session: PlayerSession, state: string | null) {
    const pending = session.spotifyAuthorization;
    if (!pending || pending.expiresAt <= Date.now() || !state || !/^[a-f0-9]{64}$/.test(state) ||
        state.length !== pending.state.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
        throw new SpotifyError("La demande de connexion est absente, expirée ou invalide.", 400);
    }
    delete session.spotifyAuthorization;
    return pending;
}

async function requestTokens(params: URLSearchParams) {
    let response: Response;
    try {
        response = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params, cache: "no-store", signal: AbortSignal.timeout(10000),
        });
    } catch {
        throw new SpotifyError("Spotify est temporairement inaccessible.");
    }
    if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new SpotifyError("Trop de demandes à Spotify. Patiente avant de réessayer.", 429,
            Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 30);
    }
    if (response.status >= 500) throw new SpotifyError("Spotify est temporairement inaccessible.");
    if (!response.ok) throw new SpotifyError("La connexion Spotify doit être renouvelée.", 401);
    const data = await response.json();
    if (!data || typeof data.access_token !== "string" || !data.access_token ||
        typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
        typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer" ||
        (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token))) {
        throw new SpotifyError("La réponse de Spotify est invalide.");
    }
    return data as { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope?: string };
}

export async function completeSpotifyAuthorization(session: PlayerSession, state: string | null, code: string | null, denied: boolean) {
    const pending = consumeSpotifyAuthorization(session, state);
    if (denied) throw new SpotifyError("Connexion Spotify annulée.", 403);
    if (!code) throw new SpotifyError("Le code de connexion Spotify est absent.", 400);
    const config = getSpotifyConfig();
    if (!config || config.redirectUri !== pending.redirectUri) throw new SpotifyError("La configuration Spotify a changé.", 503);
    const data = await requestTokens(new URLSearchParams({
        grant_type: "authorization_code", client_id: config.clientId, code,
        redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
    }));
    if (typeof data.refresh_token !== "string" || !data.refresh_token) throw new SpotifyError("Le jeton de renouvellement Spotify est absent.");
    if (session.expiresAt <= Date.now()) throw new SpotifyError("La session a expiré.", 401);
    if (session.spotifyAuthorizationId !== pending.state) throw new SpotifyError("La connexion a été annulée ou remplacée.", 400);
    delete session.spotifyAuthorizationId;
    session.spotify = {
        accessToken: data.access_token, refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000, playlists: new Map(),
        grantedScopes: typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : [], playbackDevices: new Map(),
    };
    return pending.returnTo;
}

async function refreshSpotifyToken(session: PlayerSession, connection: SpotifyConnection): Promise<string> {
    if (connection.refreshPromise) return connection.refreshPromise;
    const config = getSpotifyConfig();
    if (!config) throw new SpotifyError("La connexion Spotify n’est pas configurée.", 503);
    connection.refreshPromise = (async () => {
        try {
            const data = await requestTokens(new URLSearchParams({
                grant_type: "refresh_token", client_id: config.clientId, refresh_token: connection.refreshToken,
            }));
            if (session.spotify !== connection || session.expiresAt <= Date.now()) throw new SpotifyError("La session Spotify a été déconnectée.", 401);
            connection.accessToken = data.access_token;
            if (data.refresh_token) connection.refreshToken = data.refresh_token;
            connection.expiresAt = Date.now() + data.expires_in * 1000;
            if (typeof data.scope === "string") connection.grantedScopes = data.scope.split(" ").filter(Boolean);
            return connection.accessToken;
        } catch (error) {
            if (error instanceof SpotifyError && error.status === 401 && session.spotify === connection) delete session.spotify;
            throw error;
        } finally {
            delete connection.refreshPromise;
        }
    })();
    return connection.refreshPromise;
}

function getCoverUrl(images: unknown): string | null {
    if (!Array.isArray(images)) return null;
    for (const image of [...images].reverse()) {
        if (typeof image?.url !== "string") continue;
        try {
            const url = new URL(image.url);
            if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
        } catch { /* Ignore invalid image URLs. */ }
    }
    return null;
}

function normalizePlaylist(value: unknown): SpotifyPlaylist | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-zA-Z0-9]+$/.test(item.id) || typeof item.name !== "string") return null;
    const owner = item.owner as { display_name?: string } | undefined;
    const entries = (item.items ?? item.tracks) as { total?: number } | undefined;
    return {
        id: item.id, name: item.name, ownerName: typeof owner?.display_name === "string" ? owner.display_name : "",
        url: `https://open.spotify.com/playlist/${item.id}`,
        trackCount: typeof entries?.total === "number" ? entries.total : null,
        coverUrl: getCoverUrl(item.images),
    };
}

async function requestSpotifyPage(session: PlayerSession, path: string, forbiddenMessage: string, signal?: AbortSignal, collection?: "tracks") {
    const connection = session.spotify;
    if (!connection) throw new SpotifyError("Connecte ton compte Spotify pour afficher tes playlists.", 401);
    let token = connection.expiresAt <= Date.now() + 30000
        ? await refreshSpotifyToken(session, connection) : connection.accessToken;
    const request = async () => {
        try {
            return await fetch(`https://api.spotify.com/v1/${path}`, {
                headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
            });
        } catch {
            throw new SpotifyError("Spotify est temporairement inaccessible.");
        }
    };
    let response = await request();
    if (response.status === 401) {
        token = await refreshSpotifyToken(session, connection);
        response = await request();
    }
    if (response.status === 401) {
        if (session.spotify === connection) delete session.spotify;
        throw new SpotifyError("Reconnecte ton compte Spotify.", 401);
    }
    if (response.status === 403) throw new SpotifyError(forbiddenMessage, 403);
    if (response.status === 404) throw new SpotifyError("Cette playlist est introuvable ou n’est plus accessible.", 404);
    if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        throw new SpotifyError("Trop de demandes à Spotify. Patiente avant de réessayer.", 429,
            Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 30);
    }
    if (!response.ok) throw new SpotifyError("Impossible de récupérer les données Spotify.");
    const payload = await response.json();
    const data = collection ? payload?.[collection] : payload;
    if (!data || !Array.isArray(data.items)) throw new SpotifyError("La liste reçue de Spotify est invalide.");
    if (session.spotify !== connection || session.expiresAt <= Date.now()) throw new SpotifyError("La session Spotify a été déconnectée.", 401);
    return { data: data as { items: unknown[]; next: unknown }, connection };
}

export async function getSpotifyPlaylists(session: PlayerSession, offset: number) {
    const { data, connection } = await requestSpotifyPage(session, `me/playlists?limit=20&offset=${offset}`,
        "Spotify refuse l’accès. Vérifie les permissions et la liste des utilisateurs autorisés de ton application.");
    const playlists = data.items.map(normalizePlaylist).filter((item): item is SpotifyPlaylist => item !== null);
    for (const playlist of playlists) connection.playlists.set(playlist.id, playlist);
    return { playlists, nextOffset: data.next && offset + 20 <= 100000 ? offset + 20 : null };
}

function normalizePlaylistTrack(value: unknown, position: number): SpotifyPlaylistTrack {
    const empty: SpotifyPlaylistTrack = {
        position, id: null, name: "Morceau indisponible", artists: [], albumName: null,
        durationMs: null, url: null, available: false,
    };
    if (!value || typeof value !== "object") return empty;
    const entry = value as Record<string, unknown>;
    const raw = entry.item ?? entry.track;
    if (!raw || typeof raw !== "object") return empty;
    const track = raw as Record<string, unknown>;
    if (track.type !== "track") return { ...empty, name: "Contenu non musical" };
    const album = track.album as { name?: unknown } | undefined;
    const id = typeof track.id === "string" && /^[a-zA-Z0-9]+$/.test(track.id) ? track.id : null;
    const local = entry.is_local === true || track.is_local === true;
    return {
        position, id,
        name: typeof track.name === "string" && track.name ? track.name : empty.name,
        artists: Array.isArray(track.artists) ? track.artists.flatMap((artist) =>
            artist && typeof artist.name === "string" ? [artist.name] : []) : [],
        albumName: typeof album?.name === "string" ? album.name : null,
        durationMs: typeof track.duration_ms === "number" && Number.isFinite(track.duration_ms) && track.duration_ms >= 0 ? track.duration_ms : null,
        url: id && !local ? `https://open.spotify.com/track/${id}` : null,
        available: Boolean(id) && !local && track.is_playable !== false &&
            typeof track.name === "string" && Boolean(track.name.trim()) &&
            Array.isArray(track.artists) && track.artists.some(artist => typeof artist?.name === "string" && artist.name.trim()),
    };
}

export async function getSpotifyPlaylistTracks(session: PlayerSession, playlistId: string, offset: number, limit: 20 | 50 = 20, signal?: AbortSignal) {
    if (!session.spotify) throw new SpotifyError("Connecte ton compte Spotify.", 401);
    if (!/^[a-zA-Z0-9]+$/.test(playlistId) || !session.spotify.playlists.has(playlistId)) {
        throw new SpotifyError("Choisis une playlist parmi celles de ton compte.", 403);
    }
    const { data } = await requestSpotifyPage(session, `playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
        "Spotify autorise les morceaux uniquement pour les playlists dont tu es propriétaire ou collaborateur. Cette playlist peut aussi ne plus être accessible.", signal);
    return {
        tracks: data.items.map((item, index) => normalizePlaylistTrack(item, offset + index + 1)),
        nextOffset: data.next && offset + limit <= 100000 ? offset + limit : null,
    };
}

export async function searchSpotifyArtistTracks(session: PlayerSession, artist: string, signal?: AbortSignal) {
    const name = artist.trim().slice(0, 200).replace(/["\\]/g, " ");
    if (!name) return [];
    const query = new URLSearchParams({ q: `artist:"${name}"`, type: "track", limit: "10" });
    const { data } = await requestSpotifyPage(session, `search?${query}`, "Spotify refuse la recherche des propositions QCM.", signal, "tracks");
    return data.items.map((item, index) => normalizePlaylistTrack({ item }, index + 1))
        .filter(track => track.available && track.artists.some(value => value.trim().toLocaleLowerCase() === artist.trim().toLocaleLowerCase()))
        .map(track => ({ id: track.id!, title: track.name, artists: [...track.artists] }));
}
export async function getSpotifyAccessToken(session: PlayerSession, requiredScopes: readonly string[] = []): Promise<string> {
    const connection = session.spotify;
    if (!connection) throw new SpotifyError("Connecte ton compte Spotify.", 401);
    if (!requiredScopes.every(scope => connection.grantedScopes?.includes(scope))) {
        throw new SpotifyError("Reconnecte Spotify pour autoriser la lecture audio, puis sélectionne à nouveau ta playlist.", 403);
    }
    const token = connection.expiresAt <= Date.now() + 30000 ? await refreshSpotifyToken(session, connection) : connection.accessToken;
    if (session.spotify !== connection || session.expiresAt <= Date.now()) throw new SpotifyError("La session Spotify a expiré.", 401);
    return token;
}

/** Recover a cached access token without replacing the connection or its playlist. */
export async function renewSpotifyPlaybackToken(session: PlayerSession): Promise<void> {
    const connection = session.spotify;
    if (!connection) throw new SpotifyError("Connecte ton compte Spotify.", 401);
    if (!SPOTIFY_PLAYBACK_SCOPES.every(scope => connection.grantedScopes?.includes(scope))) throw new SpotifyError("Reconnecte Spotify pour autoriser la lecture audio.", 403);
    if (connection.lastPlaybackRecoveryAt !== undefined && Date.now() - connection.lastPlaybackRecoveryAt < 30000) {
        throw new SpotifyError("Une récupération du lecteur vient déjà d’être tentée. Patiente 30 secondes avant de réessayer.", 429, 30);
    }
    connection.lastPlaybackRecoveryAt = Date.now();
    await refreshSpotifyToken(session, connection);
}

async function playbackFailureReason(response: Response): Promise<string> {
    let data;
    try { data = await response.json(); } catch { return "NON_JSON_RESPONSE"; }
    const error = data?.error;
    // Classify a known reason instead of forwarding Spotify's arbitrary message.
    const reason = typeof error?.reason === "string" ? error.reason : "";
    const known = ["NO_ACTIVE_DEVICE", "DEVICE_NOT_FOUND", "PREMIUM_REQUIRED", "INSUFFICIENT_SCOPE", "RESTRICTION_VIOLATED", "RATE_LIMITED", "TOKEN_EXPIRED", "INVALID_TOKEN", "UNKNOWN_ERROR"];
    if (known.includes(reason)) return reason;
    const message = typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "";
    if (/no active device/i.test(message)) return "NO_ACTIVE_DEVICE";
    if (/device.*not found|device.*unavailable/i.test(message)) return "DEVICE_NOT_FOUND";
    if (/not found/i.test(message)) return "NOT_FOUND";
    if (/premium/i.test(message)) return "PREMIUM_REQUIRED";
    if (/scope/i.test(message)) return "INSUFFICIENT_SCOPE";
    if (/restriction/i.test(message)) return "RESTRICTION_VIOLATED";
    if (/rate limit|too many requests/i.test(message)) return "RATE_LIMITED";
    if (/token.*expired/i.test(message)) return "TOKEN_EXPIRED";
    if (/invalid.*token/i.test(message)) return "INVALID_TOKEN";
    return "UNRECOGNIZED_RESPONSE";
}

export async function controlSpotifyPlayback(session: PlayerSession, deviceId: string, action: "play" | "pause" | "transfer", trackId?: string, positionMs = 0, signal?: AbortSignal) {
    let token = await getSpotifyAccessToken(session, SPOTIFY_PLAYBACK_SCOPES);
    const request = () => fetch(action === "transfer" ? "https://api.spotify.com/v1/me/player" : `https://api.spotify.com/v1/me/player/${action}?device_id=${encodeURIComponent(deviceId)}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(action === "play" ? { body: JSON.stringify({ uris: [`spotify:track:${trackId}`], position_ms: Math.max(0, Math.floor(positionMs)) }) } : {}),
        ...(action === "transfer" ? { body: JSON.stringify({ device_ids: [deviceId], play: false }) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), cache: "no-store",
    });
    let response = await request();
    if (response.status === 401 && session.spotify) {
        token = await refreshSpotifyToken(session, session.spotify);
        response = await request();
    }
    if (response.ok) return;
    const diagnostic: SpotifyPlaybackDiagnostic = { operation: action, spotifyStatus: response.status, reason: await playbackFailureReason(response) };
    const failure = response.status === 403 ? new SpotifyError("Spotify refuse la lecture. Un compte Premium et les autorisations de lecture sont nécessaires.", 403)
        : response.status === 404 ? new SpotifyError("Spotify n’a pas encore activé ce lecteur. Réessaie l’activation du son sur cette page.", 409, undefined, "DEVICE_UNAVAILABLE")
        : response.status === 429 ? new SpotifyError("Spotify reçoit trop de demandes. Patiente avant de réessayer.", 429)
        : new SpotifyError("Impossible de contrôler la lecture Spotify.", response.status === 401 ? 401 : 502);
    failure.diagnostic = diagnostic;
    throw failure;
}
