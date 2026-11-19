import { withGameStore } from "@/src/lib/sharedStore";
import { NextResponse } from "next/server";
import { ensurePlayerSession, readPlayerSession } from "@/src/lib/playerSession";
import { beginSpotifyAuthorization, getSpotifyConfig, getRequestOrigin, isSameOrigin } from "@/src/lib/spotify";
import { games, players } from "@/src/lib/gameStore";

async function handlePOST(request: Request) {
    if (!isSameOrigin(request)) return NextResponse.json({ error: "Origine de la demande invalide." }, { status: 403 });
    const config = getSpotifyConfig();
    if (!config) return NextResponse.redirect(new URL("/spotify?error=configuration", getRequestOrigin(request)), 303);
    if (getRequestOrigin(request) !== config.appUrl) {
        return NextResponse.redirect(new URL("/spotify?error=origin", config.appUrl), 303);
    }
    const existingSession = await readPlayerSession();
    let returnTo: string | undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
        let form;
        try { form = await request.formData(); } catch { return NextResponse.json({ error: "Demande de connexion invalide." }, { status: 400 }); }
        const code = form.get("gameCode"), playerId = form.get("playerId");
        if (code !== null || playerId !== null) {
            if (typeof code !== "string" || !/^\d{5}$/.test(code) || typeof playerId !== "string") return NextResponse.json({ error: "Partie invalide." }, { status: 400 });
            const game = games.get(code), player = players.get(playerId);
            if (!existingSession?.playerIds.has(playerId) || !game || player?.gameId !== game.id || game.hostId !== playerId) return NextResponse.json({ error: "Seul l’hôte peut connecter Spotify depuis cette partie." }, { status: 403 });
            // Build the path from authenticated ownership, never from an arbitrary return URL.
            returnTo = `/game/${code}?playerId=${encodeURIComponent(playerId)}`;
        }
    }
    const response = new NextResponse(null, { status: 303, headers: { "Cache-Control": "no-store" } });
    const session = ensurePlayerSession(response, existingSession);
    response.headers.set("Location", beginSpotifyAuthorization(session, returnTo));
    return response;
}

export const POST = withGameStore(handlePOST);
export const maxDuration = 60;
