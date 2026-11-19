import { withGameStore } from "@/src/lib/sharedStore";
import { NextResponse } from "next/server";
import { readPlayerSession } from "@/src/lib/playerSession";
import { completeSpotifyAuthorization, getRequestOrigin, getSpotifyConfig } from "@/src/lib/spotify";

async function handleGET(request: Request) {
    const url = new URL(request.url);
    const config = getSpotifyConfig();
    let destination = new URL("/spotify", config?.appUrl ?? url.origin);
    const session = await readPlayerSession();
    try {
        if (!config || !session || getRequestOrigin(request) !== config.appUrl) throw new Error("Invalid callback context");
        const returnTo = await completeSpotifyAuthorization(session, url.searchParams.get("state"), url.searchParams.get("code"), url.searchParams.has("error"));
        if (returnTo) destination = new URL(returnTo, config.appUrl);
    } catch {
        destination.searchParams.set("error", "authorization");
    }
    const response = NextResponse.redirect(destination, 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
}

export const GET = withGameStore(handleGET);
export const maxDuration = 60;
