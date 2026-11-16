import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { NextResponse } from "next/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://127.0.0.1:3000";
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

function fixture(fetchMock = async () => { throw new Error("Unexpected network request"); }, clientMocks = {}) {
    const cache = new Map();
    const sessions = new Map();
    const games = new Map(), players = new Map();
    const env = { APP_URL: origin, SPOTIFY_CLIENT_ID: "test-client" };
    let cookie;
    function load(relative) {
        const filename = path.resolve(root, relative);
        if (cache.has(filename)) return cache.get(filename);
        const loadedModule = { exports: {} };
        cache.set(filename, loadedModule.exports);
        const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
        }).outputText;
        vm.runInNewContext(source, {
            exports: loadedModule.exports, Buffer, URL, URLSearchParams, AbortSignal, AbortController, Date, Map, Set,
            process: { env }, fetch: fetchMock,
            require: (name) => {
                if (name in clientMocks) return clientMocks[name];
                if (name === "server-only") return {};
                if (name === "node:crypto") return crypto;
                if (name === "next/server") return { NextResponse };
                if (name === "next/headers") return { cookies: async () => ({ get: () => cookie ? { value: cookie } : undefined }) };
                if (name.endsWith("/gameStore")) return { sessions, games, players };
                const target = name.startsWith("@/") ? path.join(root, name.slice(2)) : path.resolve(path.dirname(filename), name);
                return load(path.relative(root, target + ".ts"));
            },
        }, { filename });
        return loadedModule.exports;
    }
    const sessionLibrary = load("src/lib/playerSession.ts");
    function createSession() {
        const session = sessionLibrary.ensurePlayerSession(new NextResponse(), null);
        cookie = session.token;
        return session;
    }
    return { load, env, sessions, games, players, createSession, useSession: (session) => { cookie = session?.token; } };
}

const request = (route, body, requestOrigin = origin) => new Request(origin + route, {
    method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const connection = () => ({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3600000, playlists: new Map() });
const playlist = { id: "playlistA", name: "Test list", owner: { display_name: "Test owner" }, items: { total: 12 } };

test("PKCE S256 and state are linked to a session, expire and cannot be replayed", () => {
    const f = fixture();
    const session = f.createSession();
    const api = f.load("src/lib/spotify.ts");
    const authorization = new URL(api.beginSpotifyAuthorization(session));
    assert.equal(authorization.origin, "https://accounts.spotify.com");
    assert.equal(authorization.searchParams.get("redirect_uri"), origin + "/api/spotify/callback");
    assert.equal(authorization.searchParams.get("code_challenge"), crypto.createHash("sha256").update(session.spotifyAuthorization.verifier).digest("base64url"));
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("scope"), "playlist-read-private playlist-read-collaborative streaming user-read-email user-read-private user-modify-playback-state");
    const state = session.spotifyAuthorization.state;
    assert.throws(() => api.consumeSpotifyAuthorization(session, "0".repeat(64)));
    assert.throws(() => api.consumeSpotifyAuthorization(session, "é".repeat(64)));
    api.consumeSpotifyAuthorization(session, state);
    assert.throws(() => api.consumeSpotifyAuthorization(session, state));
    api.beginSpotifyAuthorization(session);
    session.spotifyAuthorization.expiresAt = 0;
    assert.throws(() => api.consumeSpotifyAuthorization(session, session.spotifyAuthorization.state));
});

test("OAuth callback exchanges the code with its verifier and never exposes tokens", async () => {
    let exchanges = 0;
    const f = fixture(async (url, options) => {
        exchanges++;
        assert.equal(url, "https://accounts.spotify.com/api/token");
        assert.equal(options.body.get("code"), "returned-code");
        assert.equal(options.body.get("grant_type"), "authorization_code");
        assert.ok(options.body.get("code_verifier"));
        return json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, token_type: "Bearer" });
    });
    const session = f.createSession();
    f.load("src/lib/spotify.ts").beginSpotifyAuthorization(session);
    const state = session.spotifyAuthorization.state;
    const callback = f.load("src/app/api/spotify/callback/route.ts");
    const response = await callback.GET(new Request(`${origin}/api/spotify/callback?state=${state}&code=returned-code`));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), origin + "/spotify");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(session.spotify.accessToken, "access-secret");
    const status = await f.load("src/app/api/spotify/status/route.ts").GET();
    const data = await status.text();
    assert.ok(!data.includes("secret"));
    assert.ok(!data.includes(state));
    const replay = await callback.GET(new Request(`${origin}/api/spotify/callback?state=${state}&code=returned-code`));
    assert.ok(replay.headers.get("location").endsWith("?error=authorization"));
    assert.equal(exchanges, 1);
});

test("Spotify login from the lobby returns to the authenticated host room without accepting arbitrary redirects", async () => {
    const f = fixture(async () => json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, token_type: "Bearer" }));
    const session = f.createSession();
    session.playerIds.add("host-player");
    f.games.set("12345", { id: "room", code: "12345", hostId: "host-player", status: "lobby" });
    f.players.set("host-player", { id: "host-player", gameId: "room" });
    const login = f.load("src/app/api/spotify/login/route.ts");
    const form = fields => new Request(origin + "/api/spotify/login", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(fields) });
    const response = await login.POST(form({ gameCode: "12345", playerId: "host-player", returnTo: "https://evil.example" }));
    assert.equal(response.status, 303);
    assert.equal(session.spotifyAuthorization.returnTo, "/game/12345?playerId=host-player");
    const callback = f.load("src/app/api/spotify/callback/route.ts");
    const result = await callback.GET(new Request(`${origin}/api/spotify/callback?state=${session.spotifyAuthorization.state}&code=returned-code`));
    assert.equal(result.headers.get("location"), origin + "/game/12345?playerId=host-player");
    assert.ok(!result.headers.get("location").includes("secret"));
    f.createSession();
    assert.equal((await login.POST(form({ gameCode: "12345", playerId: "host-player" }))).status, 403);
    assert.equal((await login.POST(form({ gameCode: "//evil.example", playerId: "host-player" }))).status, 400);
});

test("Spotify reauthorization retains the authenticated lobby link and reports missing audio scopes", async () => {
    const scopes = "playlist-read-private playlist-read-collaborative streaming user-read-email user-read-private user-modify-playback-state";
    const f = fixture(async () => json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, token_type: "Bearer", scope: scopes }));
    const owner = f.createSession();
    owner.playerIds.add("owner-player");
    f.players.set("owner-player", { id: "owner-player", gameId: "game-id" });
    f.games.set("12345", { id: "game-id", code: "12345", status: "lobby" });
    owner.spotify = { ...connection(), grantedScopes: ["streaming", "user-modify-playback-state"] };
    const status = f.load("src/app/api/spotify/status/route.ts");
    const before = await (await status.GET()).json();
    assert.equal(before.connected, true);
    assert.equal(before.playbackAuthorized, false);
    assert.deepEqual(before.missingPlaybackScopes, ["user-read-email", "user-read-private"]);
    assert.equal(before.currentGame.href, "/game/12345?playerId=owner-player");
    f.load("src/lib/spotify.ts").beginSpotifyAuthorization(owner);
    const callback = f.load("src/app/api/spotify/callback/route.ts");
    const response = await callback.GET(new Request(`${origin}/api/spotify/callback?state=${owner.spotifyAuthorization.state}&code=returned-code`));
    assert.equal(response.status, 303);
    const after = await (await status.GET()).json();
    assert.equal(after.playbackAuthorized, true);
    assert.deepEqual(after.missingPlaybackScopes, []);
    assert.deepEqual(after.currentGame, before.currentGame);
    await f.load("src/app/api/spotify/disconnect/route.ts").POST(request("/api/spotify/disconnect"));
    assert.deepEqual((await (await status.GET()).json()).currentGame, before.currentGame);
    f.createSession();
    assert.equal((await (await status.GET()).json()).currentGame, null);
    f.useSession(owner);
    f.games.clear();
    assert.equal((await (await status.GET()).json()).currentGame, null);
});

test("wrong session, rejected consent and disconnect during callback do not link an account", async () => {
    let finish;
    let called;
    const started = new Promise(resolve => { called = resolve; });
    const f = fixture(async () => { called(); return new Promise(resolve => { finish = resolve; }); });
    const owner = f.createSession();
    const api = f.load("src/lib/spotify.ts");
    api.beginSpotifyAuthorization(owner);
    const state = owner.spotifyAuthorization.state;
    const other = f.createSession();
    await assert.rejects(api.completeSpotifyAuthorization(other, state, "code", false));
    await assert.rejects(api.completeSpotifyAuthorization(owner, state, null, true));
    assert.equal(owner.spotify, undefined);
    f.useSession(owner);
    api.beginSpotifyAuthorization(owner);
    const pending = api.completeSpotifyAuthorization(owner, owner.spotifyAuthorization.state, "code", false);
    await started;
    await f.load("src/app/api/spotify/disconnect/route.ts").POST(request("/api/spotify/disconnect"));
    finish(json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, token_type: "Bearer" }));
    await assert.rejects(pending);
    assert.equal(owner.spotify, undefined);
});

test("playlist pagination sanitizes metadata, selection belongs to the session and disconnect preserves players", async () => {
    const f = fixture(async (url, options) => {
        assert.equal(new URL(url).origin, "https://api.spotify.com");
        assert.equal(new URL(url).searchParams.get("offset"), "20");
        assert.equal(options.headers.Authorization, "Bearer access-secret");
        return json({ items: [null, playlist, { id: "../bad", name: "bad" }], next: "https://untrusted.example/ignored" });
    });
    const session = f.createSession();
    session.playerIds.add("host");
    session.spotify = connection();
    const result = await f.load("src/app/api/spotify/playlists/route.ts").GET(new Request(origin + "/api/spotify/playlists?offset=20"));
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.playlists.length, 1);
    assert.equal(data.nextOffset, 40);
    assert.equal(data.playlists[0].url, "https://open.spotify.com/playlist/playlistA");
    assert.equal(data.playlists[0].trackCount, 12);
    assert.ok(!JSON.stringify(data).includes("secret"));
    const selection = f.load("src/app/api/spotify/selection/route.ts");
    assert.equal((await selection.POST(request("/api/spotify/selection", { playlistId: "unknown" }))).status, 403);
    assert.equal((await selection.POST(request("/api/spotify/selection", { playlistId: "playlistA" }, "https://evil.example"))).status, 403);
    assert.equal((await selection.POST(request("/api/spotify/selection", { playlistId: "playlistA" }))).status, 200);
    assert.equal(session.spotify.selectedPlaylist.id, "playlistA");
    const other = f.createSession();
    other.spotify = connection();
    assert.equal((await selection.POST(request("/api/spotify/selection", { playlistId: "playlistA" }))).status, 403);
    f.useSession(session);
    await f.load("src/app/api/spotify/disconnect/route.ts").POST(request("/api/spotify/disconnect"));
    assert.equal(session.spotify, undefined);
    assert.ok(session.playerIds.has("host"));
});

test("concurrent expired-token requests share a refresh and preserve a rotated refresh token", async () => {
    let refreshes = 0;
    const f = fixture(async (url, options) => {
        if (url.includes("/api/token")) {
            refreshes++;
            assert.equal(options.body.get("refresh_token"), "refresh-secret");
            return json({ access_token: "new-secret", refresh_token: "rotated-secret", token_type: "Bearer", expires_in: 3600 });
        }
        assert.equal(options.headers.Authorization, "Bearer new-secret");
        return json({ items: [playlist], next: null });
    });
    const session = f.createSession();
    session.spotify = connection();
    session.spotify.expiresAt = 0;
    const api = f.load("src/lib/spotify.ts");
    await Promise.all([api.getSpotifyPlaylists(session, 0), api.getSpotifyPlaylists(session, 20)]);
    assert.equal(refreshes, 1);
    assert.equal(session.spotify.refreshToken, "rotated-secret");
});

test("401 refresh retry is bounded, and temporary upstream errors retain the connection", async () => {
    let fetches = 0;
    const f = fixture(async (url) => {
        fetches++;
        return url.includes("/api/token") ? json({ access_token: "new-secret", token_type: "Bearer", expires_in: 3600 }) : json({}, 401);
    });
    const session = f.createSession();
    session.spotify = connection();
    await assert.rejects(f.load("src/lib/spotify.ts").getSpotifyPlaylists(session, 0), error => error.status === 401);
    assert.equal(fetches, 3);
    assert.equal(session.spotify, undefined);
    for (const status of [429, 503]) {
        const temp = fixture(async () => json({}, status, { "Retry-After": "42" }));
        const s = temp.createSession();
        s.spotify = connection();
        s.spotify.expiresAt = 0;
        await assert.rejects(temp.load("src/lib/spotify.ts").getSpotifyPlaylists(s, 0), error => error.status === (status === 429 ? 429 : 502));
        assert.ok(s.spotify);
    }
});

test("login creates an HttpOnly session, rejects foreign origins and avoids localhost callback", async () => {
    const f = fixture();
    const login = f.load("src/app/api/spotify/login/route.ts");
    assert.equal((await login.POST(request("/api/spotify/login", undefined, "https://evil.example"))).status, 403);
    const response = await login.POST(request("/api/spotify/login"));
    assert.equal(response.status, 303);
    assert.ok(response.headers.get("location").startsWith("https://accounts.spotify.com/authorize?"));
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    assert.equal(f.sessions.size, 1);
    const localhost = await login.POST(new Request("http://localhost:3000/api/spotify/login", { method: "POST", headers: { Origin: "http://localhost:3000" } }));
    assert.equal(localhost.headers.get("location"), origin + "/spotify?error=origin");
    assert.equal(localhost.headers.get("set-cookie"), null);
    f.env.SPOTIFY_CLIENT_ID = "";
    assert.equal((await login.POST(request("/api/spotify/login"))).headers.get("location"), origin + "/spotify?error=configuration");
});

test("playlist routes reject unauthenticated sessions and invalid offsets", async () => {
    const f = fixture();
    const route = f.load("src/app/api/spotify/playlists/route.ts");
    assert.equal((await route.GET(new Request(origin + "/api/spotify/playlists"))).status, 401);
    for (const offset of ["-1", "1.5", "NaN", "100001", "https://evil.example"]) {
        assert.equal((await route.GET(new Request(origin + "/api/spotify/playlists?offset=" + offset))).status, 400);
    }
    assert.equal((await f.load("src/app/api/spotify/selection/route.ts").POST(request("/api/spotify/selection", { playlistId: "playlistA" }))).status, 401);
});
test("custom Next hostname rewriting preserves the trusted browser origin", async () => {
    const f = fixture();
    const login = f.load("src/app/api/spotify/login/route.ts");
    const incoming = new Request("http://localhost:3000/api/spotify/login", {
        method: "POST", headers: { Host: "127.0.0.1:3000", Origin: origin },
    });
    const response = await login.POST(incoming);
    assert.equal(response.status, 303);
    assert.ok(response.headers.get("location").startsWith("https://accounts.spotify.com/authorize?"));
    const forged = new Request("http://localhost:3000/api/spotify/login", {
        method: "POST", headers: { Host: "evil.example", Origin: "http://evil.example" },
    });
    assert.equal((await login.POST(forged)).status, 403);
});

test("production OAuth accepts the configured HTTPS host behind HTTP without trusting forged proxy headers", async () => {
    const f = fixture();
    f.env.NODE_ENV = "production";
    f.env.APP_URL = "https://blind-test.example";
    const login = f.load("src/app/api/spotify/login/route.ts");
    const headers = { Host: "blind-test.example", Origin: f.env.APP_URL };
    const response = await login.POST(new Request("http://127.0.0.1:10000/api/spotify/login", { method: "POST", headers }));
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get("location")).searchParams.get("redirect_uri"), "https://blind-test.example/api/spotify/callback");
    assert.ok(response.headers.get("set-cookie").includes("Secure"));
    for (const forged of [
        { ...headers, Host: "evil.example", "X-Forwarded-Host": "blind-test.example", "X-Forwarded-Proto": "https" },
        { ...headers, Origin: "https://evil.example" },
    ]) assert.equal((await login.POST(new Request("http://127.0.0.1:10000/api/spotify/login", { method: "POST", headers: forged }))).status, 403);
});
test("playlist covers use HTTPS, tolerate absent images and do not expose arbitrary schemes", async () => {
    const f = fixture(async () => json({ items: [
        { ...playlist, images: [{ url: "https://i.scdn.co/image/large" }, { url: "https://i.scdn.co/image/small" }] },
        { ...playlist, id: "emptyCover", images: [] },
        { ...playlist, id: "invalidCover", images: [{ url: "javascript:alert(1)" }, { url: "http://insecure.example/image" }] },
    ], next: null }));
    const session = f.createSession();
    session.spotify = connection();
    const data = await f.load("src/lib/spotify.ts").getSpotifyPlaylists(session, 0);
    assert.equal(data.playlists[0].coverUrl, "https://i.scdn.co/image/small");
    assert.equal(data.playlists[1].coverUrl, null);
    assert.equal(data.playlists[2].coverUrl, null);
});

test("track pages preserve positions, duplicate songs and unavailable entries using the current items endpoint", async () => {
    const song = { id: "songA", type: "track", name: "Song A", artists: [{ name: "Artist A" }, { name: "Artist B" }], album: { name: "Album A" }, duration_ms: 185000, is_playable: true };
    const f = fixture(async (url, options) => {
        assert.equal(url, "https://api.spotify.com/v1/playlists/playlistA/items?limit=20&offset=20");
        assert.equal(options.headers.Authorization, "Bearer access-secret");
        return json({ items: [{ item: song }, null, { track: song }, { item: { ...song, id: null, is_local: true }, is_local: true }, { item: { type: "episode" } }], next: "https://external.example/not-followed" });
    });
    const session = f.createSession();
    session.spotify = connection();
    session.spotify.playlists.set("playlistA", { id: "playlistA" });
    const route = f.load("src/app/api/spotify/playlists/[playlistId]/tracks/route.ts");
    const r = await route.GET(new Request(origin + "/api/spotify/playlists/playlistA/tracks?offset=20"), { params: Promise.resolve({ playlistId: "playlistA" }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    const page = await r.json();
    assert.equal(page.tracks.length, 5);
    assert.deepEqual(page.tracks.map(t => t.position), [21, 22, 23, 24, 25]);
    assert.equal(page.tracks[0].id, page.tracks[2].id);
    assert.deepEqual(page.tracks[0].artists, ["Artist A", "Artist B"]);
    assert.equal(page.tracks[0].durationMs, 185000);
    assert.equal(page.tracks[0].url, "https://open.spotify.com/track/songA");
    assert.equal(page.tracks[1].available, false);
    assert.equal(page.tracks[3].url, null);
    assert.equal(page.tracks[4].available, false);
    assert.equal(page.nextOffset, 40);
    assert.ok(!JSON.stringify(page).includes("secret"));
});

test("track routes reject unauthenticated sessions, unlisted playlists and malformed input without network access", async () => {
    const f = fixture();
    const route = f.load("src/app/api/spotify/playlists/[playlistId]/tracks/route.ts");
    const get = (id, offset = "0") => route.GET(new Request(origin + "/api/spotify/playlists/x/tracks?offset=" + offset), { params: Promise.resolve({ playlistId: id }) });
    assert.equal((await get("playlistA")).status, 401);
    const session = f.createSession();
    session.spotify = connection();
    assert.equal((await get("playlistA")).status, 403);
    const second = f.createSession();
    second.spotify = connection();
    second.spotify.playlists.set("playlistA", { id: "playlistA" });
    f.useSession(session);
    assert.equal((await get("playlistA")).status, 403);
    for (const id of ["../secret", "https://evil.example", ""]) assert.equal((await get(id)).status, 400);
    for (const offset of ["-1", "1.2", "100001"]) assert.equal((await get("playlistA", offset)).status, 400);
});

test("track API exposes a specific owner/collaborator error and propagates Spotify rate limits", async () => {
    for (const code of [403, 429]) {
        const f = fixture(async () => json({}, code, { "Retry-After": "60" }));
        const session = f.createSession();
        session.spotify = connection();
        session.spotify.playlists.set("playlistA", { id: "playlistA" });
        const r = await f.load("src/app/api/spotify/playlists/[playlistId]/tracks/route.ts").GET(
            new Request(origin + "/api/spotify/playlists/playlistA/tracks"), { params: Promise.resolve({ playlistId: "playlistA" }) });
        assert.equal(r.status, code);
        const data = await r.json();
        if (code === 403) assert.ok(data.error.includes("collaborateur"));
        if (code === 429) assert.equal(r.headers.get("retry-after"), "60");
        assert.ok(session.spotify);
    }
});

test("playlist card loads tracks only on opening, appends pagination, caches on collapse and falls back on broken covers", async () => {
    const slots = [];
    let cursor = 0;
    let cleanup;
    const jsx = (type, props, key) => ({ type, props, key });
    const mocks = {
        react: {
            useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
            useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
            useEffect(effect) { if (!cleanup) cleanup = effect(); },
        },
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "next/image": { default: "Image" },
    };
    let requests = 0;
    const f = fixture(async (url) => {
        requests++;
        assert.ok(url.includes(requests === 1 ? "offset=0" : "offset=20"));
        return json({ tracks: [{ position: requests === 1 ? 1 : 21, id: "songA", name: "Song A", artists: ["Artist A"], albumName: "Album A", durationMs: 185000, url: "https://open.spotify.com/track/songA", available: true }], nextOffset: requests === 1 ? 20 : null });
    }, mocks);
    const Card = f.load("src/app/spotify/SpotifyPlaylistCard.tsx").default;
    const props = { playlist: { id: "playlistA", name: "Test playlist", ownerName: "Owner", coverUrl: "https://i.scdn.co/image/test", url: "https://open.spotify.com/playlist/playlistA", trackCount: 21 }, selected: false, disabled: false, onSelect() {} };
    const render = () => { cursor = 0; return Card(props); };
    const nodes = (node, predicate) => {
        if (!node || typeof node !== "object") return [];
        return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, predicate))];
    };
    let tree = render();
    assert.equal(requests, 0);
    const expand = () => nodes(render(), node => node.type === "button" && node.props["aria-controls"])[0];
    expand().props.onClick();
    await new Promise(setImmediate);
    tree = render();
    assert.equal(requests, 1);
    assert.equal(nodes(tree, node => node.type === "li" && node.props.className === "track-row").length, 1);
    const more = nodes(tree, node => node.type === "button" && node.props.children === "Afficher les morceaux suivants")[0];
    more.props.onClick();
    await new Promise(setImmediate);
    tree = render();
    assert.equal(nodes(tree, node => node.type === "li" && node.props.className === "track-row").length, 2);
    expand().props.onClick();
    expand().props.onClick();
    assert.equal(requests, 2);
    const image = nodes(render(), node => node.type === "Image")[0];
    assert.equal(image.props.unoptimized, true);
    image.props.onError();
    assert.equal(nodes(render(), node => node.type === "Image").length, 0);
    cleanup();
});
function selectPreviewPlaylist(f) {
    const session = f.createSession();
    session.spotify = connection();
    const selected = { id: "playlistA", name: "Preview playlist", ownerName: "Owner", url: "https://open.spotify.com/playlist/playlistA", trackCount: 50, coverUrl: null };
    session.spotify.playlists.set(selected.id, selected);
    session.spotify.selectedPlaylist = selected;
    return session;
}
const previewSong = n => ({ item: { id: `song${n}`, type: "track", name: `Generated title ${n}`, artists: [{ name: `Artist ${n}` }], album: { name: "Album" }, is_playable: true, duration_ms: 120000 } });

test("artist search uses the official search response shape, bounds its size and filters unrelated or invalid tracks", async () => {
    const f = fixture(async (url, options) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, "/v1/search");
        assert.equal(parsed.searchParams.get("type"), "track");
        assert.equal(parsed.searchParams.get("limit"), "10");
        assert.equal(parsed.searchParams.get("q"), 'artist:"Artist 0"');
        assert.equal(options.headers.Authorization, "Bearer access-secret");
        return json({ tracks: { items: [previewSong(0).item, { ...previewSong(1).item, artists: [{ name: "Artist 0" }, { name: "Guest" }] }, previewSong(2).item, { ...previewSong(3).item, artists: [{ name: "Artist 0" }], is_local: true }, null] } });
    });
    const session = f.createSession();
    session.spotify = connection();
    const result = await f.load("src/lib/spotify.ts").searchSpotifyArtistTracks(session, "Artist 0");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), [
        { id: "song0", title: "Generated title 0", artists: ["Artist 0"] },
        { id: "song1", title: "Generated title 1", artists: ["Artist 0", "Guest"] },
    ]);
});

test("automatic preview reads all playlist pages and creates distinct questions from titles and artists", async () => {
    const offsets = [];
    const f = fixture(async url => {
        const params = new URL(url).searchParams;
        assert.equal(params.get("limit"), "50");
        const offset = Number(params.get("offset"));
        offsets.push(offset);
        return offset === 0 ? json({ items: [0, 1, 2, 3].map(previewSong).concat([previewSong(0), null]), next: "https://untrusted.example/not-followed" })
            : json({ items: [4, 5, 6].map(previewSong), next: null });
    });
    selectPreviewPlaylist(f);
    const response = await f.load("src/app/api/spotify/questions/preview/route.ts").POST(request("/api/spotify/questions/preview", { playlistId: "playlistA", questionCount: 5 }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const preview = await response.json();
    assert.deepEqual(offsets, [0, 50]);
    assert.equal(preview.eligibleTrackCount, 7);
    assert.equal(preview.questions.length, 5);
    assert.equal(new Set(preview.questions.map(q => q.track.id)).size, 5);
    for (const [index, question] of preview.questions.entries()) {
        const number = Number(question.track.id.slice(4));
        assert.equal(question.number, index + 1);
        assert.equal(question.answer.title, `Generated title ${number}`);
        assert.deepEqual(question.answer.artists, [`Artist ${number}`]);
        assert.equal(question.track.url, `https://open.spotify.com/track/song${number}`);
        assert.ok(question.prompt.length > 0);
        assert.equal(question.audioPath, undefined);
    }
    assert.ok(!JSON.stringify(preview).includes("secret"));
});

test("preview excludes unavailable, local, non-musical and incomplete entries and fails instead of repeating songs", async () => {
    const f = fixture(async () => json({ items: [
        previewSong(0), previewSong(0), previewSong(0), null,
        { item: { ...previewSong(1).item, is_playable: false } },
        { item: { ...previewSong(2).item, is_local: true } },
        { item: { ...previewSong(3).item, name: " " } },
        { item: { ...previewSong(4).item, artists: [] } },
        { item: { type: "episode", name: "Podcast" } },
    ], next: null }));
    const session = selectPreviewPlaylist(f);
    const response = await f.load("src/app/api/spotify/questions/preview/route.ts").POST(request("/api/spotify/questions/preview", { playlistId: "playlistA", questionCount: 5 }));
    assert.equal(response.status, 422);
    assert.ok((await response.json()).error.includes("1 morceau"));
    assert.equal(session.spotify.previewPending, undefined);
});

test("preview requires the current session selection and rejects malformed or cross-origin requests before Spotify", async () => {
    const f = fixture();
    const route = f.load("src/app/api/spotify/questions/preview/route.ts");
    const valid = { playlistId: "playlistA", questionCount: 5 };
    assert.equal((await route.POST(request("/api/spotify/questions/preview", valid))).status, 401);
    const session = selectPreviewPlaylist(f);
    assert.equal((await route.POST(request("/api/spotify/questions/preview", valid, "https://evil.example"))).status, 403);
    for (const body of [null, {}, { ...valid, questionCount: 6 }, { ...valid, questionCount: "5" }, { ...valid, playlistId: "../private" }]) {
        assert.equal((await route.POST(request("/api/spotify/questions/preview", body))).status, 400);
    }
    assert.equal((await route.POST(new Request(origin + "/api/spotify/questions/preview", { method: "POST", headers: { Origin: origin }, body: "{" }))).status, 400);
    session.spotify.selectedPlaylist = undefined;
    assert.equal((await route.POST(request("/api/spotify/questions/preview", valid))).status, 400);
    session.spotify.selectedPlaylist = { id: "playlistB" };
    assert.equal((await route.POST(request("/api/spotify/questions/preview", valid))).status, 409);
});

test("preview rejects concurrent generation and discards a result if selection changes or account disconnects", async () => {
    for (const disconnect of [false, true]) {
        let release;
        let notify;
        const started = new Promise(resolve => { notify = resolve; });
        const f = fixture(async () => { notify(); return new Promise(resolve => { release = resolve; }); });
        const session = selectPreviewPlaylist(f);
        const connectionBefore = session.spotify;
        const api = f.load("src/lib/spotifyQuestionPreview.ts");
        const first = api.createSpotifyQuestionPreview(session, "playlistA", 5);
        await started;
        await assert.rejects(api.createSpotifyQuestionPreview(session, "playlistA", 5), error => error.status === 409);
        if (disconnect) delete session.spotify;
        else session.spotify.selectedPlaylist = { id: "playlistB" };
        release(json({ items: [0, 1, 2, 3, 4].map(previewSong), next: null }));
        await assert.rejects(first, error => error.status === (disconnect ? 401 : 409));
        assert.equal(connectionBefore.previewPending, undefined);
    }
});

test("preview never silently samples only the first part of an oversized playlist and releases its lock on upstream errors", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return json({ items: [previewSong(calls)], next: "more" }); });
    const session = selectPreviewPlaylist(f);
    await assert.rejects(f.load("src/lib/spotifyQuestionPreview.ts").createSpotifyQuestionPreview(session, "playlistA", 5), error => error.status === 422);
    assert.equal(calls, 100);
    assert.equal(session.spotify.previewPending, undefined);
    const limited = fixture(async () => json({}, 429, { "Retry-After": "60" }));
    const s = selectPreviewPlaylist(limited);
    const response = await limited.load("src/app/api/spotify/questions/preview/route.ts").POST(request("/api/spotify/questions/preview", { playlistId: "playlistA", questionCount: 5 }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(s.spotify.previewPending, undefined);
});

test("preview panel generates without manual questions, blocks a double submit and displays the server answers", async () => {
    const slots = [];
    let cursor = 0;
    let cleanup;
    let release;
    let requests = 0;
    const jsx = (type, props, key) => ({ type, props, key });
    const mocks = {
        react: {
            useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
            useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
            useId() { return "preview-id"; },
            useEffect(effect) { if (!cleanup) cleanup = effect(); },
        },
        "react/jsx-runtime": { jsx, jsxs: jsx },
    };
    const f = fixture(async (url, options) => {
        requests++;
        assert.equal(url, "/api/spotify/questions/preview");
        assert.deepEqual(JSON.parse(options.body), { playlistId: "playlistA", questionCount: 5 });
        return new Promise(resolve => { release = resolve; });
    }, mocks);
    const Panel = f.load("src/app/spotify/SpotifyQuestionPreviewPanel.tsx").default;
    const render = () => { cursor = 0; return Panel({ playlist: { id: "playlistA", name: "My playlist" }, disabled: false }); };
    const nodes = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
    const text = node => typeof node === "string" || typeof node === "number" ? String(node) : !node || typeof node !== "object" ? "" : [node.props?.children].flat(Infinity).map(text).join(" ");
    const form = nodes(render()).find(node => node.type === "form");
    form.props.onSubmit({ preventDefault() {} });
    form.props.onSubmit({ preventDefault() {} });
    assert.equal(requests, 1);
    assert.equal(nodes(render()).find(node => node.type === "button").props.disabled, true);
    release(json({ questionCount: 5, eligibleTrackCount: 10, questions: [{ number: 1, prompt: "Identify this song", answer: { title: "From Spotify", artists: ["Artist"] }, track: { id: "song1", url: "https://open.spotify.com/track/song1" } }] }));
    await new Promise(setImmediate);
    const tree = render();
    assert.ok(text(tree).includes("From Spotify"));
    assert.ok(text(tree).includes("Artist"));
    assert.equal(nodes(tree).filter(node => node.type === "input" || node.type === "textarea").length, 0);
    assert.equal(nodes(tree).filter(node => node.type === "audio").length, 0);
    assert.equal(nodes(tree).find(node => node.type === "button").props.disabled, false);
    cleanup();
});
