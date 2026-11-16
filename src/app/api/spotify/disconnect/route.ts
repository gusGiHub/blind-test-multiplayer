import { NextResponse } from "next/server";
import { readPlayerSession } from "@/src/lib/playerSession";
import { isSameOrigin } from "@/src/lib/spotify";

export async function POST(request: Request) {
    if (!isSameOrigin(request)) return NextResponse.json({ error: "Origine de la demande invalide." }, { status: 403 });
    const session = await readPlayerSession();
    if (session) {
        delete session.spotify;
        delete session.spotifyAuthorization;
        delete session.spotifyAuthorizationId;
    }
    return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "private, no-store" } });
}