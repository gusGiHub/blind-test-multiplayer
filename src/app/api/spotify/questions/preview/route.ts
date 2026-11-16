import { NextResponse } from "next/server";
import { readPlayerSession } from "@/src/lib/playerSession";
import { isSameOrigin, SpotifyError } from "@/src/lib/spotify";
import { createSpotifyQuestionPreview } from "@/src/lib/spotifyQuestionPreview";

export async function POST(request: Request) {
    if (!isSameOrigin(request)) return NextResponse.json({ error: "Origine de la demande invalide." }, { status: 403 });
    const session = await readPlayerSession();
    if (!session?.spotify) return NextResponse.json({ error: "Connecte ton compte Spotify." }, { status: 401 });
    let body;
    try { body = await request.json(); } catch {
        return NextResponse.json({ error: "La demande est invalide." }, { status: 400 });
    }
    if (typeof body?.playlistId !== "string" || !/^[a-zA-Z0-9]+$/.test(body.playlistId) || ![5, 10, 15].includes(body?.questionCount)) {
        return NextResponse.json({ error: "Choisis une playlist et 5, 10 ou 15 questions." }, { status: 400 });
    }
    try {
        const connection = session.spotify;
        const preview = await createSpotifyQuestionPreview(session, body.playlistId, body.questionCount, request.signal);
        if (session.spotify !== connection || connection.selectedPlaylist?.id !== preview.playlist.id) {
            throw new SpotifyError("La sélection Spotify a changé. Réessaie.", 409);
        }
        connection.questionPreview = preview;
        return NextResponse.json(preview, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        const known = error instanceof SpotifyError;
        return NextResponse.json({ error: known ? error.message : "Impossible de générer l’aperçu." }, {
            status: known ? error.status : 502,
            headers: { "Cache-Control": "private, no-store", ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
        });
    }
}