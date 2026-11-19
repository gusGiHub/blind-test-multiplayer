import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import ts from "typescript";
import { NextResponse } from "next/server.js";

const root = path.resolve(import.meta.dirname, "..");
const origin = "https://blind-test.example";
const tracks = Array.from({ length: 8 }, (_, i) => ({ id: `track${i}`, title: `Track ${i}`, artist: `Artist ${i}`, audioPath: `/audio/${i}.mp3` }));

/** Two isolated runtimes share only the simulated Postgres RPC boundary, never their Maps. */
function cluster() {
    let clock = Date.now();
    let row = { snapshot: null, lock: null, until: 0, expires: 0 };
    let failCommit = false;
    let exchanges = 0;
    const databaseFetch = async (url, options) => {
        if (String(url) === "https://accounts.spotify.com/api/token") {
            exchanges++;
            return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer" });
        }
        assert.equal(options.headers.apikey, "sb_secret_fixture");
        assert.equal(options.headers.Authorization, undefined, "new secret keys are not user JWTs");
        const body = JSON.parse(options.body);
        const operation = new URL(url).pathname.split("/").at(-1);
        if (operation === "blind_test_store_acquire") {
            if (row.lock && row.until > clock) return Response.json({ acquired: false });
            row.lock = body.p_token; row.until = clock + body.p_lock_ms;
            return Response.json({ acquired: true, snapshot: row.expires > clock ? row.snapshot : null });
        }
        if (operation === "blind_test_store_commit") {
            if (failCommit) return Response.json(false);
            if (row.lock !== body.p_token || row.until <= clock) return Response.json(false);
            row.snapshot = body.p_snapshot; row.expires = clock + body.p_ttl_seconds * 1000; row.lock = null;
            return Response.json(true);
        }
        if (operation === "blind_test_store_release") {
            if (row.lock !== body.p_token) return Response.json(false);
            row.lock = null; return Response.json(true);
        }
        throw new Error(`Unexpected RPC ${operation}`);
    };
    const instance = (overrides = {}) => {
        const cache = new Map();
        const context = new AsyncLocalStorage();
        const env = { VERCEL: "1", NODE_ENV: "production", APP_URL: origin, SPOTIFY_CLIENT_ID: "fixture-client", SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_fixture", ...overrides };
        class Clock extends Date { static now() { return clock; } }
        function load(filename) {
            filename = path.resolve(root, filename);
            if (cache.has(filename)) return cache.get(filename);
            const exported = {};
            cache.set(filename, exported);
            const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
            vm.runInNewContext(source, { exports: exported, crypto, Map, Set, URL, URLSearchParams, Buffer, AbortSignal, Date: Clock, setTimeout, clearTimeout, fetch: databaseFetch, process: { env },
                require(name) {
                    if (name === "server-only") return {};
                    if (name === "node:crypto") return crypto;
                    if (name === "next/server") return { NextResponse };
                    if (name === "next/headers") return { cookies: async () => ({ get: () => ({ value: context.getStore()?.split("=")[1] }) }) };
                    if (name.endsWith("/musicCatalog")) return { getMusicCatalog: () => tracks };
                    const target = name.startsWith("@/") ? path.resolve(root, name.slice(2)) : path.resolve(path.dirname(filename), name);
                    return load(target + ".ts");
                },
            }, { filename });
            return exported;
        }
        const call = (pathname, body, cookie = "", method = "POST") => context.run(cookie, async () => {
            let route = pathname.split("?")[0];
            const match = route.match(/^\/api\/games\/(\d{5})(.*)$/);
            if (match) route = `/api/games/[code]${match[2]}`;
            const handler = load(`src/app${route}/route.ts`)[method];
            return handler(new Request(origin + pathname, { method, headers: { Origin: origin, Host: "blind-test.example", "Content-Type": "application/json", Cookie: cookie }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ code: match?.[1] }) });
        });
        return { call, load };
    };
    return { instance, get state() { return row.snapshot; }, get exchanges() { return exchanges; }, at(value) { clock = value; }, failCommit(value) { failCommit = value; }, expireLease() { row.until = 0; } };
}
const cookieFrom = response => response.headers.get("set-cookie").split(";")[0];

test("Vercel persists admission, concurrent answers, automatic transitions and private corrections across cold instances", async () => {
    const c = cluster();
    const a = c.instance(), b = c.instance();
    const created = await a.call("/api/games", { nickname: "Host", questionCount: 5, settings: { mode: "qcm", excerptSeconds: 1, responseSeconds: 2, pauseSeconds: 1, excerptPosition: "start", scoring: "speed", revealMode: "end" } });
    assert.equal(created.status, 200);
    const { game, player: host } = await created.json();
    const hostCookie = cookieFrom(created);
    const joined = await b.call(`/api/games/${game.code}/join`, { nickname: "Guest" });
    assert.equal(joined.status, 201);
    const guest = await joined.json(), guestCookie = cookieFrom(joined);
    const route = action => `/api/games/${game.code}/${action}`;
    for (const [player, cookie, node] of [[host, hostCookie, b], [guest, guestCookie, a]]) {
        assert.equal((await node.call(route("ready"), { playerId: player.id, ready: true }, cookie)).status, 200);
    }
    assert.equal((await a.call(route("access"), { playerId: guest.id }, hostCookie)).status, 403);
    const started = await b.call(route("start"), { playerId: host.id }, hostCookie);
    assert.equal(started.status, 201);
    let progress = (await started.json()).progress;
    const choiceId = c.state.engines[0][1].correctChoiceId;
    c.at(progress.question.startsAt + 500);
    const answers = await Promise.all([[host, hostCookie, a], [guest, guestCookie, b]].map(([player, cookie, node]) => node.call(route("answer"), { playerId: player.id, questionNumber: 1, choiceId }, cookie)));
    assert.deepEqual(answers.map(response => response.status), [200, 200]);
    const snapshot = async (node = c.instance()) => {
        const response = await node.call(route("access"), { playerId: host.id }, hostCookie);
        assert.equal(response.status, 200);
        return response.json();
    };
    const question = await snapshot();
    assert.equal(question.progress.participation.answered, 2);
    assert.equal(question.ownAnswer.choiceId, choiceId);
    assert.equal(question.ownReview, null);
    assert.ok(!JSON.stringify(question).includes("correctChoiceId"));
    c.at(progress.question.endsAt);
    let result = await snapshot();
    assert.equal(result.progress.status, "result");
    assert.equal(result.progress.answer, undefined);
    const scores = c.state.players.entries.map(([, player]) => player.score);
    assert.deepEqual(scores, [17, 17]);
    await snapshot(b);
    assert.deepEqual(c.state.players.entries.map(([, player]) => player.score), scores, "polls cannot award points twice");
    for (let number = 1; number <= 5; number++) {
        c.at(result.progress.endsAt);
        let next = await snapshot();
        if (number === 5) { result = next; break; }
        assert.equal(next.progress.question.number, number + 1);
        const unchanged = await snapshot();
        assert.deepEqual(unchanged.progress.question.choices, next.progress.question.choices, "cold starts retain the exact QCM draw");
        c.at(next.progress.question.endsAt);
        result = await snapshot();
    }
    assert.equal(result.progress.status, "finished");
    assert.equal(result.ownReview[0].points, 17);
    assert.equal(result.ownReview.length, 5);
    assert.equal((await a.call(route("rematch"), { playerId: host.id }, hostCookie)).status, 200);
    assert.equal((await snapshot()).game.status, "lobby");
    assert.equal((await snapshot()).game.round, 1);
});

test("Spotify PKCE and its session survive changing Vercel instances without exposing tokens", async () => {
    const c = cluster(), a = c.instance(), b = c.instance();
    const login = await a.call("/api/spotify/login", {});
    assert.equal(login.status, 303);
    const cookie = cookieFrom(login);
    const authorization = new URL(login.headers.get("location"));
    const state = authorization.searchParams.get("state");
    const callback = await b.call(`/api/spotify/callback?code=fixture-code&state=${state}`, undefined, cookie, "GET");
    assert.equal(callback.headers.get("location"), origin + "/spotify");
    const status = await (await c.instance().call("/api/spotify/status", undefined, cookie, "GET")).json();
    assert.equal(status.connected, true);
    assert.equal(status.configured, true);
    assert.ok(!JSON.stringify(status).includes("private-"));
    const replay = await a.call(`/api/spotify/callback?code=fixture-code&state=${state}`, undefined, cookie, "GET");
    assert.ok(replay.headers.get("location").includes("error=authorization"));
    assert.equal(c.exchanges, 1);
});

test("missing database settings and rejected commits fail closed instead of acknowledging lost state", async () => {
    const c = cluster();
    const missing = await c.instance({ SUPABASE_SECRET_KEY: "" }).call("/api/games", { nickname: "Host", questionCount: 5 });
    assert.equal(missing.status, 503);
    assert.ok((await missing.json()).error.includes("Supabase"));
    c.failCommit(true);
    const failed = await c.instance().call("/api/games", { nickname: "Host", questionCount: 5 });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("set-cookie"), null);
    assert.equal(c.state, null);
    assert.ok(!(await failed.text()).includes("sb_secret"));
    c.failCommit(false);
    assert.equal((await c.instance().call("/api/games", { nickname: "Host", questionCount: 5 })).status, 200);
});

test("an expired lease cannot overwrite a newer instance's commit", async () => {
    const c = cluster(), a = c.instance(), b = c.instance();
    const session = token => ({ token, expiresAt: Date.now() + 60000, playerIds: new Set() });
    await assert.rejects(a.load("src/lib/databaseStore.ts").runWithSharedStore(async () => {
        a.load("src/lib/gameStore.ts").sessions.set("old", session("old"));
        c.expireLease();
        await b.load("src/lib/databaseStore.ts").runWithSharedStore(async () => {
            b.load("src/lib/gameStore.ts").sessions.set("new", session("new"));
        });
    }), /lease expired/);
    assert.deepEqual(c.state.sessions.entries.map(([token]) => token), ["new"]);
});

test("expired persisted sessions cannot regain access after a cold start", async () => {
    const c = cluster(), a = c.instance();
    const created = await a.call("/api/games", { nickname: "Host", questionCount: 5 });
    const { game, player } = await created.json();
    const cookie = cookieFrom(created);
    c.at(Date.now() + 9 * 60 * 60 * 1000);
    const access = await c.instance().call(`/api/games/${game.code}/access`, { playerId: player.id }, cookie);
    assert.equal(access.status, 401);
    assert.equal(c.state.sessions.entries.length, 0);
    assert.equal(c.state.games.entries.length, 0);
});
