import { withGameStore } from "@/src/lib/sharedStore";
import { NextResponse } from "next/server";
import { readPlayerSession } from "@/src/lib/playerSession";
import { getSpotifyPlaylistTracks, SpotifyError } from "@/src/lib/spotify";

async function handleGET(request: Request, { params }: { params: Promise<{ playlistId: string }> }) {
    const { playlistId } = await params;
    const value = new URL(request.url).searchParams.get("offset") ?? "0";
    const offset = Number(value);
    if (!/^[a-zA-Z0-9]+$/.test(playlistId) || !/^\d+$/.test(value) || !Number.isSafeInteger(offset) || offset > 100000) {
        return NextResponse.json({ error: "La playlist ou la page demandée est invalide." }, { status: 400 });
    }
    const session = await readPlayerSession();
    if (!session) return NextResponse.json({ error: "Connecte ton compte Spotify." }, { status: 401 });
    try {
        return NextResponse.json(await getSpotifyPlaylistTracks(session, playlistId, offset), {
            headers: { "Cache-Control": "private, no-store" },
        });
    } catch (error) {
        const known = error instanceof SpotifyError;
        return NextResponse.json({ error: known ? error.message : "Impossible de récupérer les morceaux." }, {
            status: known ? error.status : 502,
            headers: { "Cache-Control": "private, no-store", ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
        });
    }
}
export const GET = withGameStore(handleGET);
export const maxDuration = 60;
