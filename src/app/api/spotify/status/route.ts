import { withGameStore } from "@/src/lib/sharedStore";
import { NextResponse } from "next/server";
import { readPlayerSession } from "@/src/lib/playerSession";
import { getSpotifyConfig, SPOTIFY_PLAYBACK_SCOPES } from "@/src/lib/spotify";
import { getCurrentGame } from "@/src/lib/currentGame";

async function handleGET() {
    const session = await readPlayerSession();
    const config = getSpotifyConfig();
    return NextResponse.json({
        configured: Boolean(config), appUrl: config?.appUrl ?? null,
        connected: Boolean(session?.spotify),
        playbackAuthorized: SPOTIFY_PLAYBACK_SCOPES.every(scope => session?.spotify?.grantedScopes?.includes(scope)),
        missingPlaybackScopes: session?.spotify ? SPOTIFY_PLAYBACK_SCOPES.filter(scope => !session.spotify?.grantedScopes?.includes(scope)) : [],
        currentGame: getCurrentGame(session),
        selectedPlaylist: session?.spotify?.selectedPlaylist ?? null,
    }, { headers: { "Cache-Control": "private, no-store" } });
}

export const GET = withGameStore(handleGET);
export const maxDuration = 60;
