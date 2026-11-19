import "server-only";
import { randomUUID } from "node:crypto";
import { games, players, sessions, gameEngines, startingGames } from "./gameStore";
import { restoreGameEngine, type EngineSnapshot } from "./gameEngine";

const TTL_SECONDS = 8 * 60 * 60;
const LOCK_MS = 90_000;
async function rpc(name: string, args: Record<string, unknown>) {
    const endpoint = new URL(process.env.SUPABASE_URL!);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/") throw new Error("Invalid database endpoint");
    const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!;
    const response = await fetch(new URL(`/rest/v1/rpc/${name}`, endpoint), {
        method: "POST", headers: { apikey: key, ...(!key.startsWith("sb_secret_") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify(args), cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Database request failed");
    return response.json();
}

/** Preserve Sets and Maps (including Spotify caches), but never persist in-flight promises. */
export function encodeStore(value: unknown): string {
    return JSON.stringify(value, (key, item) => {
        if (key === "refreshPromise" || key === "previewPending") return undefined;
        if (item instanceof Map) return { $blindTest: "Map", entries: Array.from(item) };
        if (item instanceof Set) return { $blindTest: "Set", entries: Array.from(item) };
        return item;
    });
}
export function decodeStore(value: string): unknown {
    return JSON.parse(value, (_key, item) => {
        if (item?.$blindTest === "Map") return new Map(item.entries);
        if (item?.$blindTest === "Set") return new Set(item.entries);
        return item;
    });
}

interface Snapshot {
    version: 1;
    games: typeof games; players: typeof players; sessions: typeof sessions;
    engines: [string, EngineSnapshot][];
}
function restore(raw: string | null) {
    games.clear(); players.clear(); sessions.clear(); gameEngines.clear(); startingGames.clear();
    if (!raw) return;
    const state = decodeStore(raw) as Snapshot;
    if (state.version !== 1) throw new Error("Unsupported store snapshot");
    for (const [key, value] of state.games) games.set(key, value);
    for (const [key, value] of state.players) players.set(key, value);
    for (const [key, value] of state.sessions) if (value.expiresAt > Date.now()) sessions.set(key, value);
    for (const [key, value] of state.engines) gameEngines.set(key, restoreGameEngine(value));
    // Expired sessions must not leave their games and Spotify caches alive indefinitely.
    const owners = new Set(Array.from(sessions.values()).flatMap(session => Array.from(session.playerIds)));
    for (const [code, game] of games) if (!owners.has(game.hostId)) { games.delete(code); gameEngines.delete(code); }
    const gameIds = new Set(Array.from(games.values()).map(game => game.id));
    for (const [id, player] of players) if (!gameIds.has(player.gameId)) players.delete(id);
}

/** One leased transaction for this small portfolio app; shard by game before scaling. */
export async function runWithSharedStore<T>(operation: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const namespace = process.env.DATABASE_STATE_NAMESPACE ?? "production";
    const deadline = Date.now() + 8000;
    let lease;
    do {
        lease = await rpc("blind_test_store_acquire", { p_namespace: namespace, p_token: token, p_lock_ms: LOCK_MS });
        if (lease.acquired) break;
        if (Date.now() >= deadline) throw new Error("Store busy");
        await new Promise(resolve => setTimeout(resolve, 100 + Math.floor(Math.random() * 150)));
    } while (true);
    let committed = false;
    try {
        restore(lease.snapshot ? JSON.stringify(lease.snapshot) : null);
        const result = await operation();
        const state: Snapshot = { version: 1, games, players, sessions, engines: Array.from(gameEngines, ([code, engine]) => [code, engine.exportSnapshot()]) };
        const saved = await rpc("blind_test_store_commit", { p_namespace: namespace, p_token: token, p_snapshot: JSON.parse(encodeStore(state)), p_ttl_seconds: TTL_SECONDS });
        if (saved !== true) throw new Error("Store lease expired");
        committed = true;
        return result;
    } finally {
        if (!committed) await rpc("blind_test_store_release", { p_namespace: namespace, p_token: token });
    }
}
