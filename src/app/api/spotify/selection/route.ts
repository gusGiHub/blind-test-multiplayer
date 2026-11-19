import { withGameStore } from "@/src/lib/sharedStore";
import { NextResponse } from "next/server";
import { readPlayerSession } from "@/src/lib/playerSession";
import { isSameOrigin } from "@/src/lib/spotify";

async function handlePOST(request: Request) {
    if (!isSameOrigin(request)) return NextResponse.json({ error: "Origine de la demande invalide." }, { status: 403 });
    const session = await readPlayerSession();
    if (!session?.spotify) return NextResponse.json({ error: "Connecte ton compte Spotify." }, { status: 401 });
    let body;
    try { body = await request.json(); } catch {
        return NextResponse.json({ error: "La demande est invalide." }, { status: 400 });
    }
    if (typeof body?.playlistId !== "string") return NextResponse.json({ error: "Choisis une playlist." }, { status: 400 });
    const playlist = session.spotify.playlists.get(body.playlistId);
    if (!playlist) return NextResponse.json({ error: "Choisis une playlist parmi celles de ton compte." }, { status: 403 });
    if (session.spotify.selectedPlaylist?.id !== playlist.id) delete session.spotify.questionPreview;
    session.spotify.selectedPlaylist = playlist;
    return NextResponse.json({ selectedPlaylist: playlist }, { headers: { "Cache-Control": "private, no-store" } });
}
export const POST = withGameStore(handlePOST);
export const maxDuration = 60;
