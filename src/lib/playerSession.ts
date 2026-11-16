import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { SpotifyAuthorization, SpotifyConnection } from "@/src/types/spotify";
import { sessions } from "./gameStore";

export const SESSION_COOKIE = "blind_test_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

export interface PlayerSession {
    token: string;
    playerIds: Set<string>;
    expiresAt: number;
    spotify?: SpotifyConnection;
    spotifyAuthorization?: SpotifyAuthorization;
    spotifyAuthorizationId?: string;
}

export async function readPlayerSession(): Promise<PlayerSession | null> {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    return session;
}

export function ensurePlayerSession(
    response: NextResponse,
    existingSession: PlayerSession | null
) {
    const session = existingSession && existingSession.expiresAt > Date.now()
        ? existingSession
        : {
            token: randomBytes(32).toString("hex"),
            playerIds: new Set<string>(),
            expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000,
        };

    sessions.set(session.token, session);
    response.cookies.set(SESSION_COOKIE, session.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
    });
    return session;
}

export function assignPlayerToSession(playerId: string, response: NextResponse, existingSession: PlayerSession | null) {
    const session = ensurePlayerSession(response, existingSession);
    session.playerIds.add(playerId);
}