import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { io as clientSocket } from "socket.io-client";
import ts from "typescript";
import { NextResponse } from "next/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracks = Array.from({ length: 8 }, (_, n) => ({
    id: `fixture-${n}`, title: `Private answer ${n}`, artist: `Private artist ${n}`, audioPath: `/audio/fixture-${n}.mp3`,
}));

function fixture(initialCatalog = tracks, spotifyFetch) {
    let catalog = initialCatalog;
    let clock = Date.now();
    const transfers = [];
    let transferStatus = 204;
    let transferBody;
    let searchFetch;
    let draw = (...args) => crypto.randomInt(...args);
    class FixtureDate extends Date { static now() { return clock; } }
    const cache = new Map();
    const context = new AsyncLocalStorage();
    function load(relative) {
        const filename = path.resolve(root, relative);
        if (cache.has(filename)) return cache.get(filename);
        const exported = {};
        cache.set(filename, exported);
        const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        vm.runInNewContext(compiled, {
            exports: exported, crypto, Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout, Date: FixtureDate, fetch: (url, options) => {
                if (String(url) === "https://api.spotify.com/v1/me/player") { transfers.push(JSON.parse(options.body)); return Promise.resolve(transferBody === undefined ? new Response(null, { status: transferStatus }) : Response.json(transferBody, { status: transferStatus })); }
                if (String(url).startsWith("https://api.spotify.com/v1/search?")) {
                    if (searchFetch) return searchFetch(url, options);
                    const artist = new URL(url).searchParams.get("q").match(/^artist:"(.*)"$/)[1];
                    return Promise.resolve(Response.json({ tracks: { items: Array.from({ length: 4 }, (_, i) => ({ id: `external${artist.replace(/[^a-zA-Z0-9]/g, "")}${i}`, type: "track", name: `External ${i} for ${artist}`, artists: [{ name: artist }], duration_ms: 120000, is_playable: true })) } }));
                }
                return spotifyFetch && String(url).startsWith("https://") ? spotifyFetch(url, options) : fetch(url, options);
            },
            console: { log() {} }, process: { env: { NODE_ENV: "test", APP_URL: "http://127.0.0.1:3000", SPOTIFY_CLIENT_ID: "test-client" } },
            require(name) {
                if (name === "server-only") return {};
                if (name === "node:crypto") return { ...crypto, randomInt: (...args) => draw(...args) };
                if (name === "next/server") return { NextResponse };
                if (name === "next/headers") return { cookies: async () => ({ get: name => {
                    const cookie = context.getStore()?.get("cookie") ?? "";
                    const value = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1);
                    return value ? { value } : undefined;
                } }) };
                if (name.endsWith("/musicCatalog")) return { getMusicCatalog: () => catalog };
                const target = name.startsWith("@/") ? path.join(root, name.slice(2)) : path.resolve(path.dirname(filename), name);
                return load(path.relative(root, target + ".ts"));
            },
        }, { filename });
        return exported;
    }
    const dispatch = request => context.run(request.headers, async () => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/spotify/questions/preview") return load("src/app/api/spotify/questions/preview/route.ts").POST(request);
        if (pathname === "/api/spotify/selection") return load("src/app/api/spotify/selection/route.ts").POST(request);
        if (pathname === "/api/games") return load("src/app/api/games/route.ts").POST(request);
        const playback = pathname.match(/^\/api\/games\/(\d{5})\/playback\/(token|device|play)$/);
        if (playback) return load(`src/app/api/games/[code]/playback/${playback[2]}/route.ts`).POST(request, { params: Promise.resolve({ code: playback[1] }) });
        const match = pathname.match(/^\/api\/games\/(\d{5})(?:\/(join|access|start|reveal|next|answer|playlist|rematch|ready))?$/);
        assert.ok(match, pathname);
        const relative = match[2] ? `src/app/api/games/[code]/${match[2]}/route.ts` : "src/app/api/games/[code]/route.ts";
        return load(relative)[request.method](request, { params: Promise.resolve({ code: match[1] }) });
    });
    const call = (pathname, body, cookie, method = "POST") => dispatch(new Request("http://127.0.0.1:3000" + pathname, {
        method, headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }));
    return { load, dispatch, call, store: load("src/lib/gameStore.ts"), transfers, setDraw: value => { draw = value; }, setSearchFetch: value => { searchFetch = value; }, setTransferStatus: value => { transferStatus = value; }, setTransferBody: value => { transferBody = value; }, setCatalog: value => { catalog = value; }, advance: ms => { clock += ms; } };
}

async function createPlayers(f, settings, readyByDefault = true) {
    const r = await f.call("/api/games", { nickname: "Host", questionCount: 5, ...(settings ? { settings } : {}) });
    assert.equal(r.status, 200);
    const { game, player: host } = await r.json();
    const ownerCookie = r.headers.get("set-cookie").split(";")[0];
    const joined = await f.call(`/api/games/${game.code}/join`, { nickname: "Guest" });
    assert.equal(joined.status, 201);
    const guest = await joined.json();
    const guestCookie = joined.headers.get("set-cookie").split(";")[0];
    if (readyByDefault) {
        for (const [player, cookie] of [[host, ownerCookie], [guest, guestCookie]]) {
            assert.equal((await f.call(`/api/games/${game.code}/ready`, { playerId: player.id, ready: true }, cookie)).status, 200);
        }
    }
    return { game, host, guest, ownerCookie, guestCookie };
}
const event = (socket, name) => new Promise((resolve, reject) => {
    const listener = data => { clearTimeout(timeout); resolve(data); };
    const timeout = setTimeout(() => { socket.off(name, listener); reject(Error(`Timeout: ${name}`)); }, 5000);
    socket.once(name, listener);
});

for (const mode of ["qcm", "free"]) test(`${mode} final personal review is session-private and restored on Socket.IO admission`, async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, { mode, excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 0, excerptPosition: "start", revealMode: "end", scoring: "speed" });
    const base = `/api/games/${game.code}`;
    let update = await (await f.call(base + "/start", { playerId: host.id }, ownerCookie)).json();
    let firstSubmission;
    for (let number = 1; number <= 5; number++) {
        const question = update.progress.question;
        f.advance(2000);
        const title = tracks.find(track => track.audioPath === question.audioPath).title;
        const value = mode === "free" ? { text: title.replace("answer", "answr") } : { choiceId: question.choices.find(choice => choice.title === title).id, confirmed: number !== 1, revision: 1 };
        if (number === 1) firstSubmission = mode === "free" ? value.text : value.choiceId;
        if (number <= 2) await f.call(base + "/answer", { playerId: guest.id, questionNumber: number, ...value }, guestCookie);
        if (number === 1) await f.call(base + "/answer", { playerId: host.id, questionNumber: number, ...(mode === "free" ? { text: "Unrelated private submission" } : { choiceId: question.choices.find(choice => choice.id !== value.choiceId).id }) }, ownerCookie);
        await f.call(base + "/reveal", { playerId: host.id, questionNumber: number }, ownerCookie);
        assert.equal((await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json()).ownReview, null);
        update = await (await f.call(base + "/next", { playerId: host.id, questionNumber: number }, ownerCookie)).json();
    }
    const own = await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json();
    const other = await (await f.call(base + "/access", { playerId: host.id }, ownerCookie)).json();
    assert.equal(own.ownReview.length, 5);
    assert.equal(mode === "free" ? own.ownReview[0].text : own.ownReview[0].choiceId, firstSubmission);
    assert.equal(own.ownReview[0].automatic, mode === "qcm");
    assert.equal(own.ownReview[0].bonusPoints, mode === "qcm" ? 0 : 9);
    assert.equal(own.ownReview[1].bonusPoints, 9);
    assert.equal(own.ownReview[2].answered, false);
    assert.equal(other.ownReview[0].correct, false);
    assert.equal(own.ownReview.reduce((sum, item) => sum + item.points, 0), own.players.find(player => player.id === guest.id).score);
    assert.equal((await f.call(base + "/access", { playerId: host.id }, guestCookie)).status, 403);
    assert.equal((await f.call(base + "/access", { playerId: guest.id })).status, 401);
    assert.equal(update.ownReview, undefined);
    assert.ok(update.progress.review.every(round => round.results.every(result => result.text === undefined && result.choiceId === undefined)));
    assert.ok(!JSON.stringify(update).includes("Unrelated private submission"));
    const connect = await startTransport(f, t);
    const returning = await connect(guestCookie);
    const admitted = event(returning, "game_joined");
    returning.emit("join_game", { code: game.code, playerId: guest.id });
    assert.deepEqual((await admitted).ownReview, own.ownReview);
    await f.call(base + "/rematch", { playerId: host.id }, ownerCookie);
    assert.equal((await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json()).ownReview, null);
});

test("readiness belongs to each session, gates start on the server and locks once the game starts", async () => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, undefined, false);
    const base = `/api/games/${game.code}`;
    assert.equal(host.ready, false);
    assert.equal(guest.ready, false);
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 409);
    assert.equal(f.store.gameEngines.size, 0);
    assert.equal((await f.call(base + "/ready", { playerId: host.id, ready: true })).status, 401);
    assert.equal((await f.call(base + "/ready", { playerId: host.id, ready: true }, guestCookie)).status, 403);
    for (const ready of [undefined, null, 1, "true"]) assert.equal((await f.call(base + "/ready", { playerId: host.id, ready }, ownerCookie)).status, 400);
    const first = await (await f.call(base + "/ready", { playerId: host.id, ready: true }, ownerCookie)).json();
    const duplicate = await (await f.call(base + "/ready", { playerId: host.id, ready: true }, ownerCookie)).json();
    assert.equal(first.player.readyRevision, duplicate.player.readyRevision, "setting the same state twice is idempotent");
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 409);
    await f.call(base + "/ready", { playerId: guest.id, ready: true }, guestCookie);
    await f.call(base + "/ready", { playerId: guest.id, ready: false }, guestCookie);
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 409);
    await f.call(base + "/ready", { playerId: guest.id, ready: true }, guestCookie);
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 201);
    assert.equal((await f.call(base + "/ready", { playerId: guest.id, ready: false }, guestCookie)).status, 409);
    const other = await createPlayers(f, undefined, false);
    assert.equal((await f.call(`/api/games/${other.game.code}/ready`, { playerId: host.id, ready: true }, ownerCookie)).status, 404);
});

test("ready states broadcast to the room, survive reconnects and ignore commands from a previous rematch", async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, undefined, false);
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie), member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const admitted = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await admitted;
    }
    const denied = event(member, "ready_error");
    member.emit("set_ready", { code: game.code, playerId: host.id, ready: true, round: 0 });
    await denied;
    const updated = [event(owner, "player_ready"), event(member, "player_ready")];
    member.emit("set_ready", { code: game.code, playerId: guest.id, ready: true, round: 0 });
    const [one, two] = await Promise.all(updated);
    assert.deepEqual(one, two);
    assert.equal(one.player.id, guest.id);
    assert.equal(one.player.ready, true);
    assert.equal(one.player.readyRevision, 1);
    assert.equal(one.round, 0);
    assert.ok(!JSON.stringify(one).includes("spotify"));
    member.disconnect();
    const returning = await connect(guestCookie);
    const admitted = event(returning, "game_joined");
    returning.emit("join_game", { code: game.code, playerId: guest.id });
    assert.equal((await admitted).players.find(player => player.id === guest.id).ready, true);
    const base = `/api/games/${game.code}`;
    await f.call(base + "/ready", { playerId: host.id, ready: true }, ownerCookie);
    await f.call(base + "/start", { playerId: host.id }, ownerCookie);
    for (let questionNumber = 1; questionNumber <= 5; questionNumber++) {
        await f.call(base + "/reveal", { playerId: host.id, questionNumber }, ownerCookie);
        await f.call(base + "/next", { playerId: host.id, questionNumber }, ownerCookie);
    }
    const reset = await (await f.call(base + "/rematch", { playerId: host.id }, ownerCookie)).json();
    assert.ok(reset.players.every(player => player.ready === false));
    assert.equal((await f.call(base + "/ready", { playerId: guest.id, ready: true, round: 0 }, guestCookie)).status, 409);
    assert.equal((await f.call(base + "/start", { playerId: host.id, round: 1 }, ownerCookie)).status, 409);
});

test("hidden corrections and scores stay private through every API until the final review", async () => {
    const f = fixture();
    const settings = { mode: "free", excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 5, excerptPosition: "start", revealMode: "end", scoring: "speed" };
    for (const invalid of [{ revealMode: "never" }, { scoring: "anything" }]) {
        assert.equal((await f.call("/api/games", { nickname: "Host", questionCount: 5, settings: { ...settings, ...invalid } })).status, 400);
    }
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, settings);
    const base = `/api/games/${game.code}`;
    let update = await (await f.call(base + "/start", { playerId: host.id }, ownerCookie)).json();
    for (let number = 1; number <= 5; number++) {
        const title = tracks.find(track => track.audioPath === update.progress.question.audioPath).title;
        f.advance(2000);
        assert.equal((await f.call(base + "/answer", { playerId: guest.id, questionNumber: number, text: title }, guestCookie)).status, 200);
        const pause = await (await f.call(base + "/reveal", { playerId: host.id, questionNumber: number }, ownerCookie)).json();
        assert.equal(pause.progress.answer, undefined);
        assert.equal(pause.progress.scores, undefined);
        assert.equal(pause.progress.review, undefined);
        assert.ok(pause.players.every(player => player.score === 0));
        assert.ok(f.store.players.get(guest.id).score > 0, "scores exist privately on the server");
        for (const snapshot of [await (await f.call(base, undefined, undefined, "GET")).json(), await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json()]) {
            assert.ok(snapshot.players.every(player => player.score === 0));
            assert.equal(snapshot.progress?.answer, undefined);
            assert.equal(snapshot.progress?.scores, undefined);
        }
        update = await (await f.call(base + "/next", { playerId: host.id, questionNumber: number }, ownerCookie)).json();
    }
    assert.equal(update.progress.status, "finished");
    assert.equal(update.progress.review.length, 5);
    assert.equal(update.progress.ranking[0].playerId, guest.id);
    assert.equal(update.progress.ranking[0].score, 95);
    assert.equal(update.players.find(player => player.id === guest.id).score, 95);
    assert.equal(update.progress.review[0].results[0].points, 19);
});

test("Socket.IO rematch keeps the room and players, resets scores and rejects commands from the previous game", async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const base = `/api/games/${game.code}`;
    assert.equal((await f.call(base + "/rematch", { playerId: host.id }, ownerCookie)).status, 409);
    f.setDraw((...args) => args.length === 2 ? crypto.randomInt(...args) : 0);
    const started = await (await f.call(base + "/start", { playerId: host.id }, ownerCookie)).json();
    const firstPath = started.progress.question.audioPath;
    const firstEngine = f.store.gameEngines.get(game.code);
    for (let number = 1; number <= 5; number++) {
        await f.call(base + "/reveal", { playerId: host.id, questionNumber: number }, ownerCookie);
        await f.call(base + "/next", { playerId: host.id, questionNumber: number }, ownerCookie);
    }
    f.store.players.get(guest.id).score = 42;
    assert.equal((await f.call(base + "/rematch", { playerId: guest.id }, guestCookie)).status, 403);
    assert.equal((await f.call(base + "/rematch", { playerId: host.id }, guestCookie)).status, 403);
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie), member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const admitted = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await admitted;
    }
    const resets = [event(owner, "game_reset"), event(member, "game_reset")];
    owner.emit("rematch_game", { code: game.code, playerId: host.id, round: 0 });
    const [reset, otherReset] = await Promise.all(resets);
    assert.deepEqual(reset, otherReset);
    assert.equal(reset.game.code, game.code);
    assert.equal(reset.game.id, game.id);
    assert.equal(reset.game.hostId, host.id);
    assert.equal(reset.game.round, 1);
    assert.deepEqual(reset.game.settings, game.settings);
    assert.equal(reset.game.status, "lobby");
    assert.equal(reset.progress, null);
    assert.deepEqual(reset.players.map(player => player.id).sort(), [host.id, guest.id].sort());
    assert.ok(reset.players.every(player => player.score === 0));
    assert.ok(reset.players.every(player => player.ready === false));
    assert.equal(f.store.gameEngines.has(game.code), false);
    assert.equal((await f.call(base + "/rematch", { playerId: host.id, round: 0 }, ownerCookie)).status, 409);
    f.setDraw((...args) => args.length === 2 ? crypto.randomInt(...args) : args[0] - 1);
    for (const [player, cookie] of [[host, ownerCookie], [guest, guestCookie]]) {
        await f.call(base + "/ready", { playerId: player.id, ready: true, round: 1 }, cookie);
    }
    const nextStarted = event(member, "game_started");
    owner.emit("start_game", { code: game.code, playerId: host.id, round: 1 });
    const next = await nextStarted;
    assert.equal(next.progress.question.number, 1);
    assert.notEqual(next.progress.question.audioPath, firstPath);
    assert.notEqual(f.store.gameEngines.get(game.code), firstEngine);
    assert.equal((await f.call(base + "/reveal", { playerId: host.id, questionNumber: 1, round: 0 }, ownerCookie)).status, 409);
    assert.equal(f.store.gameEngines.get(game.code).getState().status, "question");
    f.advance(2000);
    const receipt = await (await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, round: 1, choiceId: next.progress.question.choices[0].id }, guestCookie)).json();
    const snapshot = await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json();
    assert.equal(receipt.round, 1);
    assert.deepEqual(receipt, snapshot.ownAnswer);
});

for (const mode of ["qcm", "free"]) test(`${mode} participation broadcasts only validated answer counts and restores them on rejoin`, async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, { mode, excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 5, excerptPosition: "start", revealMode: "end" });
    const base = `/api/games/${game.code}`;
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie), member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const admitted = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await admitted;
    }
    const started = event(member, "game_started");
    owner.emit("start_game", { code: game.code, playerId: host.id });
    const update = await started;
    assert.deepEqual(update.progress.participation, { answered: 0, total: 2 });
    f.advance(2000);
    const value = mode === "qcm" ? { choiceId: update.progress.question.choices[0].id, confirmed: true, revision: 2 } : { text: "Private title guess" };
    if (mode === "qcm") {
        const draft = event(member, "answer_accepted");
        member.emit("submit_answer", { code: game.code, playerId: guest.id, questionNumber: 1, ...value, confirmed: false, revision: 1 });
        await draft;
        const snapshot = await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json();
        assert.deepEqual(snapshot.progress.participation, { answered: 0, total: 2 });
    }
    let counts = [event(owner, "answer_count_updated"), event(member, "answer_count_updated")];
    member.emit("submit_answer", { code: game.code, playerId: guest.id, questionNumber: 1, ...value });
    const shared = await Promise.all(counts);
    assert.deepEqual(shared[0], { questionNumber: 1, round: 0, answered: 1, total: 2 });
    assert.deepEqual(shared[0], shared[1]);
    assert.deepEqual(Object.keys(shared[0]).sort(), ["answered", "questionNumber", "round", "total"]);
    assert.equal(f.store.players.get(guest.id).score, 0);
    const returning = await connect(guestCookie);
    const admission = event(returning, "game_joined");
    returning.emit("join_game", { code: game.code, playerId: guest.id });
    assert.deepEqual((await admission).progress.participation, { answered: 1, total: 2 });
    counts = [event(owner, "answer_count_updated"), event(member, "answer_count_updated")];
    owner.emit("submit_answer", { code: game.code, playerId: host.id, questionNumber: 1, ...value });
    assert.ok((await Promise.all(counts)).every(count => count.answered === 2 && count.total === 2));
    const snapshot = await (await f.call(base + "/access", { playerId: host.id }, ownerCookie)).json();
    assert.equal(snapshot.progress.status, "question", "all answers do not end the timer early");
    assert.deepEqual(snapshot.progress.participation, { answered: 2, total: 2 });
    await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, ...value }, guestCookie);
    assert.deepEqual((await (await f.call(base + "/access", { playerId: host.id }, ownerCookie)).json()).progress.participation, { answered: 2, total: 2 });
    await f.call(base + "/reveal", { playerId: host.id, questionNumber: 1 }, ownerCookie);
    const next = await (await f.call(base + "/next", { playerId: host.id, questionNumber: 1 }, ownerCookie)).json();
    assert.deepEqual(next.progress.participation, { answered: 0, total: 2 });
});

test("creation validates settings, keeps old defaults and applies custom durations to the engine", async () => {
    const f = fixture();
    const defaults = { mode: "qcm", excerptSeconds: 30, responseSeconds: 30, pauseSeconds: 5, excerptPosition: "random" };
    for (const invalid of [null, [], {}, { ...defaults, mode: "unknown" }, { ...defaults, excerptSeconds: 31 }, { ...defaults, excerptSeconds: 0 }, { ...defaults, excerptSeconds: "10" }, { ...defaults, excerptSeconds: 1.5 }, { ...defaults, pauseSeconds: -1 }, { ...defaults, pauseSeconds: 31 }, { ...defaults, excerptPosition: "end" }]) {
        assert.equal((await f.call("/api/games", { nickname: "Host", questionCount: 5, settings: invalid })).status, 400);
    }
    assert.equal(f.store.games.size, 0);
    const old = await createPlayers(f);
    assert.deepEqual(old.game.settings, defaults);
    const settings = { mode: "free", excerptSeconds: 7, pauseSeconds: 0, excerptPosition: "middle" };
    const { game, host, ownerCookie } = await createPlayers(f, settings);
    assert.deepEqual(game.settings, { ...settings, responseSeconds: settings.excerptSeconds });
    const start = await (await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).json();
    assert.equal(start.progress.question.endsAt - start.progress.question.startsAt, 7000);
    assert.equal(start.progress.question.mode, "free");
    assert.equal(start.progress.question.choices, undefined);
});

test("free answers cross real sockets privately, survive rejoin and are scored by the server", async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, { mode: "free", excerptSeconds: 10, pauseSeconds: 3, excerptPosition: "start" });
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie), member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const admitted = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await admitted;
    }
    const started = event(member, "game_started");
    owner.emit("start_game", { code: game.code, playerId: host.id });
    const update = await started;
    const title = tracks.find(track => track.audioPath === update.progress.question.audioPath).title;
    f.advance(2000);
    const base = `/api/games/${game.code}`;
    assert.equal((await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, choiceId: "fake" }, guestCookie)).status, 400);
    for (const body of [{ text: "a".repeat(201) }, { text: title, choiceId: "fake" }]) assert.equal((await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, ...body }, guestCookie)).status, 400);
    const ack = event(member, "answer_accepted");
    const leaked = [];
    owner.on("answer_accepted", value => leaked.push(value));
    member.emit("submit_answer", { code: game.code, playerId: guest.id, questionNumber: 1, text: title.toUpperCase() });
    assert.deepEqual(await ack, { questionNumber: 1, text: title.toUpperCase() });
    const own = await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json();
    const other = await (await f.call(base + "/access", { playerId: host.id }, ownerCookie)).json();
    assert.equal(own.ownAnswer.text, title.toUpperCase());
    assert.equal(other.ownAnswer, null);
    assert.equal(own.players.find(player => player.id === guest.id).score, 0);
    const result = await (await f.call(base + "/reveal", { playerId: host.id, questionNumber: 1 }, ownerCookie)).json();
    assert.equal(result.progress.scores.find(score => score.playerId === guest.id).points, 10);
    assert.equal(result.progress.endsAt - result.serverTime, 3000);
    assert.equal(leaked.length, 0);
});

test("response settings are validated and Spotify cannot resume after the excerpt while text answers stay open", async () => {
    let playCalls = 0;
    const f = fixture([], async url => {
        if (String(url).includes("/me/player/")) { playCalls++; return new Response(null, { status: 204 }); }
        return Response.json({ items: spotifyItems(), next: null });
    });
    const settings = { mode: "free", excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 2, excerptPosition: "start" };
    for (const responseSeconds of [4, -1, 0, 121, "10", 10.5, null]) {
        assert.equal((await f.call("/api/games", { nickname: "Host", questionCount: 5, settings: { ...settings, responseSeconds } })).status, 400);
    }
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, settings);
    attachSpotify(f, ownerCookie);
    const base = `/api/games/${game.code}`;
    const started = await (await f.call(base + "/start", { playerId: host.id }, ownerCookie)).json();
    assert.equal(started.progress.question.endsAt - started.progress.question.audioEndsAt, 5000);
    f.advance(7500); // 1.5s preparation + 6s: audio over, response deadline still open
    const play = await f.call(base + "/playback/play", { playerId: host.id, questionNumber: 1 }, ownerCookie);
    assert.equal(play.status, 409);
    assert.equal(playCalls, 0);
    const response = await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, text: "Some title" }, guestCookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, "Some title");
    f.advance(4000);
    assert.equal((await f.call(base + "/answer", { playerId: host.id, questionNumber: 1, text: "Late title" }, ownerCookie)).status, 409);
});

test("authenticated votes stay private and revealing a round awards points exactly once", async () => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const base = `/api/games/${game.code}`;
    const started = await (await f.call(base + "/start", { playerId: host.id }, ownerCookie)).json();
    const question = started.progress.question;
    const track = tracks.find(track => track.audioPath === question.audioPath);
    const choiceId = question.choices.find(choice => choice.title === track.title).id;
    f.advance(2000);
    assert.equal((await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, choiceId }, ownerCookie)).status, 403);
    const accepted = await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, choiceId }, guestCookie);
    assert.equal(accepted.status, 200);
    assert.ok(!JSON.stringify(await accepted.json()).includes("correct"));
    const access = async (playerId, cookie) => (await f.call(base + "/access", { playerId }, cookie)).json();
    const own = await access(guest.id, guestCookie);
    const other = await access(host.id, ownerCookie);
    assert.equal(own.ownAnswer.choiceId, choiceId);
    assert.equal(other.ownAnswer, null);
    assert.equal(own.players.find(player => player.id === guest.id).score, 0);
    const revealed = await (await f.call(base + "/reveal", { playerId: host.id, questionNumber: 1 }, ownerCookie)).json();
    assert.equal(revealed.progress.scores.find(score => score.playerId === guest.id).points, 10);
    assert.equal((await f.call(base + "/reveal", { playerId: host.id, questionNumber: 1 }, ownerCookie)).status, 409);
    assert.equal((await access(guest.id, guestCookie)).players.find(player => player.id === guest.id).score, 10);
});

test("QCM confirmation locks a draft, validates protocol fields and keeps identity checks", async () => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const base = `/api/games/${game.code}`;
    const start = await (await f.call(base + "/start", { playerId: host.id }, ownerCookie)).json();
    const [a, b] = start.progress.question.choices;
    f.advance(2000);
    const body = { playerId: guest.id, questionNumber: 1, choiceId: a.id, confirmed: false, revision: 1 };
    assert.equal((await f.call(base + "/answer", body, ownerCookie)).status, 403);
    for (const change of [{ revision: 0 }, { revision: "1" }, { confirmed: "false" }, { revision: undefined }, { text: "Title" }]) {
        assert.equal((await f.call(base + "/answer", { ...body, ...change }, guestCookie)).status, 400);
    }
    assert.equal((await f.call(base + "/answer", body, guestCookie)).status, 200);
    const confirmed = await (await f.call(base + "/answer", { ...body, choiceId: b.id, confirmed: true, revision: 2 }, guestCookie)).json();
    assert.equal(confirmed.confirmed, true);
    assert.equal((await f.call(base + "/answer", { ...body, revision: 3 }, guestCookie)).status, 409);
    const snapshot = await (await f.call(base + "/access", { playerId: guest.id }, guestCookie)).json();
    assert.deepEqual(snapshot.ownAnswer, confirmed);
});

test("rapid Socket.IO preselections survive rejoin and the last unconfirmed choice scores on timeout", async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie), member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const joined = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await joined;
    }
    const started = event(member, "game_started");
    owner.emit("start_game", { code: game.code, playerId: host.id });
    const q = (await started).progress.question;
    const title = tracks.find(track => track.audioPath === q.audioPath).title;
    const correct = q.choices.find(choice => choice.title === title).id;
    const wrong = q.choices.find(choice => choice.id !== correct).id;
    f.advance(2000);
    const leaked = [];
    owner.on("answer_accepted", receipt => leaked.push(receipt));
    const receipts = await new Promise((resolve, reject) => {
        const values = [];
        const timeout = setTimeout(() => reject(Error("missing draft receipts")), 5000);
        const receive = receipt => { values.push(receipt); if (values.length === 2) { clearTimeout(timeout); member.off("answer_accepted", receive); resolve(values); } };
        member.on("answer_accepted", receive);
        member.emit("submit_answer", { code: game.code, playerId: guest.id, questionNumber: 1, choiceId: wrong, confirmed: false, revision: 1 });
        member.emit("submit_answer", { code: game.code, playerId: guest.id, questionNumber: 1, choiceId: correct, confirmed: false, revision: 2 });
    });
    assert.equal(receipts.length, 2);
    assert.equal(leaked.length, 0);
    member.disconnect();
    const rejoined = await connect(guestCookie);
    const joined = event(rejoined, "game_joined");
    rejoined.emit("join_game", { code: game.code, playerId: guest.id });
    const snapshot = await joined;
    assert.deepEqual(snapshot.ownAnswer, { questionNumber: 1, choiceId: correct, confirmed: false, revision: 2 });
    assert.equal(snapshot.players.find(player => player.id === guest.id).score, 0);
    f.advance(30000);
    assert.equal((await f.call(`/api/games/${game.code}/answer`, { playerId: host.id, questionNumber: 1, choiceId: wrong, confirmed: false, revision: 1 }, ownerCookie)).status, 409);
    const revealed = event(rejoined, "game_updated");
    owner.emit("reveal_answer", { code: game.code, playerId: host.id, questionNumber: 1 });
    const result = await revealed;
    assert.equal(result.progress.scores.find(score => score.playerId === guest.id).points, 10);
    const finalSnapshot = await (await f.call(`/api/games/${game.code}/access`, { playerId: guest.id }, guestCookie)).json();
    assert.equal(finalSnapshot.ownAnswer.confirmed, true);
    assert.equal(finalSnapshot.ownAnswer.choiceId, correct);
});

test("a title without its Spotify feat suffix receives ten points through the API", async () => {
    const title = "Pornstar Martini (feat. Luidji)";
    const f = fixture(tracks.map(track => ({ ...track, title })));
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f, { mode: "free", excerptSeconds: 10, pauseSeconds: 2, excerptPosition: "start" });
    const base = `/api/games/${game.code}`;
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 201);
    f.advance(2000);
    const accepted = await f.call(base + "/answer", { playerId: guest.id, questionNumber: 1, text: "Pornstar martini" }, guestCookie);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).text, "Pornstar martini");
    const result = await (await f.call(base + "/reveal", { playerId: host.id, questionNumber: 1 }, ownerCookie)).json();
    assert.equal(result.progress.answer.title, title);
    const score = result.progress.scores.find(score => score.playerId === guest.id);
    assert.equal(score.correct, true);
    assert.equal(score.points, 10);
    assert.equal(score.total, 10);
});

async function startTransport(f, t) {
    const server = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const response = await f.dispatch(new Request(`http://127.0.0.1${req.url}`, {
                method: req.method, headers: req.headers,
                ...(req.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
            }));
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(await response.text());
        } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
    const io = new Server(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    f.load("src/server/gameSockets.ts").registerGameSockets(io, base);
    const clients = [];
    t.after(async () => {
        clients.forEach(socket => socket.disconnect());
        server.closeAllConnections();
        await new Promise(resolve => io.close(resolve));
    });
    return async (cookie) => {
        const socket = clientSocket(base, { autoConnect: false, reconnection: false, transports: ["websocket"], extraHeaders: cookie ? { Cookie: cookie } : {} });
        clients.push(socket);
        const connected = event(socket, "connect");
        socket.connect();
        await connected;
        return socket;
    };
}

const assertNoAnswers = value => {
    const body = JSON.stringify(value);
    if (value.progress?.status === "question") {
        assert.equal(value.progress.answer, undefined);
        assert.equal(value.progress.question.choices.length, 4);
        assert.ok(!body.includes("correctChoiceId"));
    }
    assert.ok(!body.includes("accessToken"));
};

test("empty catalog fails without changing the lobby, players or session; retry can succeed", async () => {
    const f = fixture([]);
    const { game, host, ownerCookie } = await createPlayers(f);
    const response = await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie);
    assert.equal(response.status, 422);
    assert.ok((await response.json()).error.includes("Spotify"));
    assert.equal(f.store.games.get(game.code).status, "lobby");
    assert.equal(f.store.players.size, 2);
    assert.equal(f.store.sessions.size, 2);
    assert.equal(f.store.gameEngines.size, 0);
    f.setCatalog(tracks);
    assert.equal((await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).status, 201);
});

test("HTTP commands enforce session ownership, host role and valid question numbers", async () => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    for (const action of ["start", "reveal", "next"]) {
        const body = { playerId: host.id, questionNumber: 1 };
        assert.equal((await f.call(`/api/games/${game.code}/${action}`, body)).status, 401);
        assert.equal((await f.call(`/api/games/${game.code}/${action}`, body, guestCookie)).status, 403);
        assert.equal((await f.call(`/api/games/${game.code}/${action}`, { ...body, playerId: guest.id }, guestCookie)).status, 403);
    }
    assert.equal((await f.call(`/api/games/${game.code}/reveal`, { playerId: host.id, questionNumber: 0 }, ownerCookie)).status, 400);
    assert.equal((await f.call(`/api/games/${game.code}/next`, null, ownerCookie)).status, 400);
    const starts = await Promise.all([1, 2].map(() => f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)));
    assert.deepEqual(starts.map(r => r.status).sort(), [201, 409]);
    const initial = await (await f.call(`/api/games/${game.code}/access`, { playerId: host.id }, ownerCookie)).json();
    assertNoAnswers(initial);
    assert.equal((await f.call(`/api/games/${game.code}/next`, { playerId: host.id, questionNumber: 1 }, ownerCookie)).status, 409);
    const reveals = await Promise.all([1, 2].map(() => f.call(`/api/games/${game.code}/reveal`, { playerId: host.id, questionNumber: 1 }, ownerCookie)));
    assert.deepEqual(reveals.map(r => r.status).sort(), [200, 409]);
    assert.equal((await f.call(`/api/games/${game.code}/next`, { playerId: host.id, questionNumber: 1 }, ownerCookie)).status, 200);
    assert.equal((await f.call(`/api/games/${game.code}/reveal`, { playerId: host.id, questionNumber: 1 }, ownerCookie)).status, 409);
    const publicData = await (await f.call(`/api/games/${game.code}`, undefined, undefined, "GET")).json();
    assert.equal(publicData.progress, undefined);
    assertNoAnswers(publicData);
});

test("lobby playlist selection is host-only, room-bound and locked during or after start", async () => {
    const f = fixture([], async url => {
        assert.ok(String(url).includes("/playlists/playlistB/items"), "start must use the room choice, not the changed personal default");
        return Response.json({ items: spotifyItems(), next: null });
    });
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    session.spotify.playlists.set("playlistB", { ...session.spotify.selectedPlaylist, id: "playlistB", name: "Room playlist", url: "https://open.spotify.com/playlist/playlistB" });
    const base = `/api/games/${game.code}`;
    const body = { playerId: host.id, playlistId: "playlistB" };
    assert.equal((await f.call(base + "/playlist", body)).status, 401);
    assert.equal((await f.call(base + "/playlist", body, guestCookie)).status, 403);
    assert.equal((await f.call(base + "/playlist", { ...body, playerId: guest.id }, guestCookie)).status, 403);
    assert.equal((await f.call(base + "/playlist", { ...body, playlistId: "unknown" }, ownerCookie)).status, 403);
    assert.equal((await f.call(base + "/playlist", { ...body, playlistId: "../bad" }, ownerCookie)).status, 400);
    const selected = await (await f.call(base + "/playlist", body, ownerCookie)).json();
    assert.equal(selected.game.playlist.id, "playlistB");
    assert.equal(selected.game.playlistRevision, 1);
    assert.ok(!JSON.stringify(selected).includes("private-access"));
    f.store.startingGames.add(game.code);
    assert.equal((await f.call(base + "/playlist", { ...body, playlistId: "playlistA" }, ownerCookie)).status, 409);
    f.store.startingGames.delete(game.code);
    await f.call("/api/spotify/selection", { playlistId: "playlistA" }, ownerCookie);
    assert.equal(session.spotify.selectedPlaylist.id, "playlistA");
    assert.equal(f.store.games.get(game.code).playlist.id, "playlistB");
    const start = await f.call(base + "/start", { playerId: host.id }, ownerCookie);
    assert.equal(start.status, 201);
    assert.equal((await start.json()).game.playlist.name, "Room playlist");
    assert.equal((await f.call(base + "/playlist", { ...body, playlistId: "playlistA" }, ownerCookie)).status, 409);
});

test("Socket.IO broadcasts playlist changes to guests and restores them on rejoin", async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    attachSpotify(f, ownerCookie);
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie), member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const ready = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await ready;
    }
    const changed = [event(owner, "playlist_updated"), event(member, "playlist_updated")];
    owner.emit("select_playlist", { code: game.code, playerId: host.id, playlistId: "playlistA" });
    const [own, shared] = await Promise.all(changed);
    assert.deepEqual(shared, own);
    assert.equal(shared.game.playlist.id, "playlistA");
    assert.equal(shared.game.playlistRevision, 1);
    assert.equal(shared.progress, undefined, "a playlist change must not start the game or schedule a round");
    assert.ok(!JSON.stringify(shared).includes("private-access"));
    const denied = event(member, "playlist_error");
    member.emit("select_playlist", { code: game.code, playerId: guest.id, playlistId: "playlistA" });
    await denied;
    const returning = await connect(guestCookie);
    const joined = event(returning, "game_joined");
    returning.emit("join_game", { code: game.code, playerId: guest.id });
    assert.equal((await joined).game.playlist.id, "playlistA");
    assert.equal(f.store.games.get(game.code).status, "lobby");
});

test("real Socket.IO clients share the whole progression, rejoin current states and cannot control another player", async t => {
    const f = fixture();
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie);
    const member = await connect(guestCookie);
    const anonymous = await connect();
    let ready = event(anonymous, "join_game_error");
    anonymous.emit("join_game", { code: game.code, playerId: host.id });
    await ready;
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        ready = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        const snapshot = await ready;
        assert.equal(snapshot.game.status, "lobby");
        assert.equal(snapshot.progress, null);
    }
    ready = event(member, "start_game_error");
    member.emit("start_game", { code: game.code, playerId: host.id });
    await ready;
    let updates = [event(owner, "game_started"), event(member, "game_started")];
    owner.emit("start_game", { code: game.code, playerId: host.id });
    const started = await Promise.all(updates);
    assert.deepEqual(started[0], started[1]);
    assertNoAnswers(started[0]);
    const paths = new Set();
    const excludedEvents = [];
    anonymous.on("game_updated", data => excludedEvents.push(data));
    for (let number = 1; number <= 5; number++) {
        const snapshot = await (await f.call(`/api/games/${game.code}/access`, { playerId: guest.id }, guestCookie)).json();
        assert.equal(snapshot.progress.question.number, number);
        assertNoAnswers(snapshot);
        paths.add(snapshot.progress.question.audioPath);
        if (number === 2) {
            const rejoined = await connect(guestCookie);
            ready = event(rejoined, "game_joined");
            rejoined.emit("join_game", { code: game.code, playerId: guest.id });
            assert.equal((await ready).progress.question.number, 2);
        }
        ready = event(member, "game_action_error");
        member.emit("reveal_answer", { code: game.code, playerId: guest.id, questionNumber: number });
        await ready;
        updates = [event(owner, "game_updated"), event(member, "game_updated")];
        owner.emit("reveal_answer", { code: game.code, playerId: host.id, questionNumber: number });
        const result = await Promise.all(updates);
        assert.deepEqual(result[0], result[1]);
        assert.equal(result[0].progress.status, "result");
        const actual = tracks.find(track => track.audioPath === snapshot.progress.question.audioPath);
        assert.equal(result[0].progress.answer.title, actual.title);
        assert.equal(result[0].progress.questions, undefined);
        if (number === 1) {
            const rejoined = await connect(guestCookie);
            ready = event(rejoined, "game_joined");
            rejoined.emit("join_game", { code: game.code, playerId: guest.id });
            assert.equal((await ready).progress.status, "result");
        }
        ready = event(member, "game_action_error");
        member.emit("next_question", { code: game.code, playerId: guest.id, questionNumber: number });
        await ready;
        updates = [event(owner, "game_updated"), event(member, "game_updated")];
        owner.emit("next_question", { code: game.code, playerId: host.id, questionNumber: number });
        const next = await Promise.all(updates);
        assert.deepEqual(next[0], next[1]);
        assert.equal(next[0].progress.status, number === 5 ? "finished" : "question");
        assertNoAnswers(next[0]);
    }
    assert.equal(paths.size, 5);
    const finished = await connect(guestCookie);
    ready = event(finished, "game_joined");
    finished.emit("join_game", { code: game.code, playerId: guest.id });
    assert.equal((await ready).progress.status, "finished");
    ready = event(anonymous, "game_action_error");
    anonymous.emit("next_question", { code: game.code, playerId: host.id, questionNumber: 5 });
    await ready;
    assert.equal(excludedEvents.length, 0);
    ready = event(owner, "game_action_error");
    owner.emit("next_question", { code: game.code, playerId: host.id, questionNumber: 5 });
    await ready;
    assert.equal(f.store.games.get(game.code).status, "finished");
});
function attachSpotify(f, cookie) {
    const session = f.store.sessions.get(cookie.split("=")[1]);
    assert.ok(session);
    const playlist = { id: "playlistA", name: "Host playlist", url: "https://open.spotify.com/playlist/playlistA", ownerName: "Host", trackCount: 5, coverUrl: null };
    const playbackDevices = new Map(Array.from(f.store.games.values()).filter(game => session.playerIds.has(game.hostId)).map(game => [game.code, "fixture-device"]));
    session.spotify = { grantedScopes: ["streaming", "user-read-email", "user-read-private", "user-modify-playback-state"], playbackDevices, accessToken: "private-access", refreshToken: "private-refresh", expiresAt: Date.now() + 3600000, playlists: new Map([[playlist.id, playlist]]), selectedPlaylist: playlist };
    return session;
}
const spotifyItems = (count = 5) => Array.from({ length: count }, (_, n) => ({ item: {
    id: `spotifySong${n}`, type: "track", name: `Spotify answer ${n}`, artists: [{ name: `Spotify artist ${n}` }],
    duration_ms: 120000, is_playable: true, album: { name: "Album" },
} }));

test("legacy Spotify permissions require renewed consent before playback or start", async () => {
    let calls = 0;
    const f = fixture([], async () => { calls++; throw Error("must not contact Spotify"); });
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    session.spotify.grantedScopes = ["streaming", "user-modify-playback-state"];
    const base = `/api/games/${game.code}`;
    const token = await f.call(base + "/playback/token", { playerId: host.id }, ownerCookie);
    assert.equal(token.status, 403);
    assert.match((await token.json()).error, /Reconnecte Spotify/);
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 403);
    assert.equal(calls, 0);
    assert.equal(f.store.games.get(game.code).status, "lobby");
    assert.equal(session.playerIds.has(host.id), true);
});

test("Spotify rematch preserves the playlist, connection and device and can generate a fresh game", async () => {
    const f = fixture([], async () => Response.json({ items: spotifyItems(), next: null }));
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const connection = session.spotify;
    const base = `/api/games/${game.code}`;
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 201);
    const playlist = { ...f.store.games.get(game.code).playlist };
    for (let questionNumber = 1; questionNumber <= 5; questionNumber++) {
        await f.call(base + "/reveal", { playerId: host.id, questionNumber }, ownerCookie);
        await f.call(base + "/next", { playerId: host.id, questionNumber }, ownerCookie);
    }
    const reset = await (await f.call(base + "/rematch", { playerId: host.id, round: 0 }, ownerCookie)).json();
    assert.deepEqual(reset.game.playlist, playlist);
    assert.equal(session.spotify, connection);
    assert.equal(connection.playbackDevices.get(game.code), "fixture-device");
    for (const [player, cookie] of [[host, ownerCookie], [guest, guestCookie]]) await f.call(base + "/ready", { playerId: player.id, ready: true, round: 1 }, cookie);
    const started = await f.call(base + "/start", { playerId: host.id, round: 1 }, ownerCookie);
    assert.equal(started.status, 201);
    assert.equal((await started.json()).progress.question.number, 1);
});

test("Spotify preparation uses the configured excerpt duration when filtering short tracks", async () => {
    for (const excerptSeconds of [5, 6]) {
        const f = fixture([], async () => Response.json({ items: spotifyItems().map(entry => ({ item: { ...entry.item, duration_ms: 5000 } })), next: null }));
        const { game, host, ownerCookie } = await createPlayers(f, { mode: "free", excerptSeconds, pauseSeconds: 0, excerptPosition: "middle" });
        attachSpotify(f, ownerCookie);
        const response = await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie);
        assert.equal(response.status, excerptSeconds === 5 ? 201 : 422);
        if (excerptSeconds === 5) {
            const playback = f.store.gameEngines.get(game.code).getPlayback();
            assert.equal(playback.offsetMs, 0);
            assert.equal(playback.endsAt - playback.startsAt, 5000);
        } else assert.equal(f.store.games.get(game.code).status, "lobby");
    }
});

test("an offline Spotify device is refused before registration or game start", async () => {
    const f = fixture([], async () => { throw Error("must not prepare questions while offline"); });
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const base = `/api/games/${game.code}`;
    session.spotify.playbackDevices.clear();
    f.setTransferStatus(404);
    const registration = await f.call(base + "/playback/device", { playerId: host.id, deviceId: "offline-device" }, ownerCookie);
    assert.equal(registration.status, 409);
    assert.equal((await registration.json()).code, "DEVICE_UNAVAILABLE");
    assert.equal(session.spotify.playbackDevices.has(game.code), false);
    assert.deepEqual(f.transfers[0], { device_ids: ["offline-device"], play: false });
    session.spotify.playbackDevices.set(game.code, "stale-device");
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 409);
    assert.equal(session.spotify.playbackDevices.has(game.code), false);
    assert.equal(f.store.games.get(game.code).status, "lobby");
    assert.equal(f.store.gameEngines.has(game.code), false);
    assert.equal(f.store.startingGames.has(game.code), false);
});

test("Spotify transfer failures expose a classified diagnostic without upstream secrets or identifiers", async () => {
    const f = fixture();
    const { game, host, ownerCookie } = await createPlayers(f);
    attachSpotify(f, ownerCookie);
    const cases = [
        [404, { error: { reason: "NO_ACTIVE_DEVICE", message: "private-access account-name device-id" } }, "NO_ACTIVE_DEVICE"],
        [404, { error: { message: "Device not found: private-access device-id" } }, "DEVICE_NOT_FOUND"],
        [404, { error: { message: "Not found" } }, "NOT_FOUND"],
        [403, { error: { message: "Insufficient client scope private-access" } }, "INSUFFICIENT_SCOPE"],
        [404, { error: { reason: "private-access", message: "account-name device-id" } }, "UNRECOGNIZED_RESPONSE"],
        [404, undefined, "NON_JSON_RESPONSE"],
    ];
    for (const [status, body, reason] of cases) {
        f.setTransferStatus(status);
        f.setTransferBody(body);
        const response = await f.call(`/api/games/${game.code}/playback/device`, { playerId: host.id, deviceId: "device-id" }, ownerCookie);
        const result = await response.json();
        assert.deepEqual(result.diagnostic, { operation: "transfer", spotifyStatus: status, reason, recovery: false });
        for (const secret of ["private-access", "private-refresh", "account-name", "device-id"]) assert.ok(!JSON.stringify(result).includes(secret));
        assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
});

test("host device recovery refreshes once, preserves the session and playlist, and registers the same device", async () => {
    let renewals = 0;
    const f = fixture([], async (url, options) => {
        assert.equal(String(url), "https://accounts.spotify.com/api/token");
        assert.equal(options.body.get("grant_type"), "refresh_token");
        renewals++;
        f.setTransferStatus(204);
        return Response.json({ access_token: "renewed-private-access", refresh_token: "rotated-private-refresh", token_type: "Bearer", expires_in: 3600 });
    });
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const connection = session.spotify;
    const playlist = connection.selectedPlaylist;
    const base = `/api/games/${game.code}/playback/device`;
    connection.playbackDevices.clear();
    f.setTransferStatus(404);
    assert.equal((await f.call(base, { playerId: guest.id, deviceId: "device", recover: true }, guestCookie)).status, 403);
    assert.equal(renewals, 0);
    for (let attempt = 0; attempt < 4; attempt++) assert.equal((await f.call(base, { playerId: host.id, deviceId: "device" }, ownerCookie)).status, 409);
    assert.equal(renewals, 0, "ordinary retries must retain the cached token");
    const response = await f.call(base, { playerId: host.id, deviceId: "device", recover: true }, ownerCookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: true });
    assert.equal(renewals, 1);
    assert.equal(session.spotify, connection);
    assert.equal(session.spotify.selectedPlaylist, playlist);
    assert.equal(session.spotify.accessToken, "renewed-private-access");
    assert.equal(session.spotify.refreshToken, "rotated-private-refresh");
    assert.equal(session.playerIds.has(host.id), true);
    assert.equal(f.store.games.get(game.code).status, "lobby");
    assert.equal(connection.playbackDevices.get(game.code), "device");
    assert.equal(f.transfers.length, 5);
    assert.equal((await f.call(base, { playerId: host.id, deviceId: "device", recover: true }, ownerCookie)).status, 429);
    assert.equal(renewals, 1, "repeated recoveries must be bounded server-side too");
});

test("Spotify quota errors during recovery retain the connection without retrying token renewal", async () => {
    let renewals = 0;
    const f = fixture([], async () => { renewals++; return Response.json({}, { status: 429, headers: { "retry-after": "20" } }); });
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const connection = session.spotify;
    const response = await f.call(`/api/games/${game.code}/playback/device`, { playerId: host.id, deviceId: "device", recover: true }, ownerCookie);
    assert.equal(response.status, 429);
    assert.equal(renewals, 1);
    assert.equal(session.spotify, connection);
    assert.equal(f.transfers.length, 0);
});

test("a device disappearing during playback is invalidated on the server", async () => {
    const f = fixture([], async url => String(url).includes("/me/player/")
        ? new Response(null, { status: 404 })
        : Response.json({ items: spotifyItems(), next: null }));
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const base = `/api/games/${game.code}`;
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 201);
    f.advance(2000);
    const response = await f.call(base + "/playback/play", { playerId: host.id, questionNumber: 1 }, ownerCookie);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "DEVICE_UNAVAILABLE");
    assert.equal(session.spotify.playbackDevices.has(game.code), false);
});

test("Spotify playback is host-only, requires a device and resumes at server time", async () => {
    const requests = [];
    const f = fixture([], async (url, options) => {
        if (String(url).includes("/me/player/")) {
            requests.push({ url: String(url), body: JSON.parse(options.body) });
            return new Response(null, { status: 204 });
        }
        return Response.json({ items: spotifyItems(), next: null });
    });
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const base = `/api/games/${game.code}`;
    assert.equal((await f.call(base + "/playback/token", { playerId: guest.id }, guestCookie)).status, 403);
    assert.equal((await f.call(base + "/playback/token", { playerId: host.id }, guestCookie)).status, 403);
    const token = await f.call(base + "/playback/token", { playerId: host.id }, ownerCookie);
    assert.equal(token.headers.get("cache-control"), "private, no-store");
    assert.equal((await token.json()).accessToken, "private-access");
    session.spotify.playbackDevices.clear();
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 409);
    assert.equal((await f.call(base + "/playback/device", { playerId: host.id, deviceId: "new-device" }, ownerCookie)).status, 200);
    await f.call(base + "/playback/device", { playerId: host.id, deviceId: null, expectedDeviceId: "obsolete-device" }, ownerCookie);
    assert.equal(session.spotify.playbackDevices.get(game.code), "new-device");
    assert.equal((await f.call(base + "/start", { playerId: host.id }, ownerCookie)).status, 201);
    assert.equal((await f.call(base + "/playback/play", { playerId: host.id, questionNumber: 1 }, ownerCookie)).status, 409);
    f.advance(2500);
    const playback = f.store.gameEngines.get(game.code).getPlayback();
    const play = await f.call(base + "/playback/play", { playerId: host.id, questionNumber: 1 }, ownerCookie);
    assert.equal(play.status, 200);
    assert.ok(!JSON.stringify(await play.json()).includes("spotify:track:"));
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith("device_id=new-device"));
    assert.equal(requests[0].body.position_ms, playback.offsetMs + 1000);
    assert.equal(requests[0].body.uris[0], `spotify:track:${playback.trackId}`);
    f.advance(30000);
    assert.equal((await f.call(base + "/playback/play", { playerId: host.id, questionNumber: 1 }, ownerCookie)).status, 409);
    assert.equal(requests.length, 1);
});

test("Spotify start ignores the saved preview, draws again and hides its private candidate pool", async () => {
    let calls = 0;
    const f = fixture([], async () => { calls++; return Response.json({ items: spotifyItems(), next: null }); });
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const generated = await f.call("/api/spotify/questions/preview", { playlistId: "playlistA", questionCount: 5 }, ownerCookie);
    assert.equal(generated.status, 200);
    const preview = await generated.json();
    assert.equal(preview.choicePool, undefined, "the preview API never returns the internal decoy pool");
    for (const question of session.spotify.questionPreview.questions) question.answer.title = "Preview-only answer";
    assert.equal(session.spotify.questionPreview.questionCount, 5);
    const started = await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie);
    assert.equal(started.status, 201);
    const initial = await started.json();
    assert.equal(initial.game.questionSource, "spotify");
    assert.equal(initial.game.playlist.name, "Host playlist");
    assert.equal(initial.progress.question.audioPath, undefined);
    assert.equal(initial.progress.question.number, 1);
    assert.equal(calls, 2, "start must fetch and draw again instead of reusing the preview");
    assert.equal(initial.choicePool, undefined);
    assert.ok(!JSON.stringify(initial).includes("Preview-only answer"));
    // Later changes to the owner's preview or account do not change the running engine.
    session.spotify.questionPreview.questions[0].answer.title = "Changed after start";
    delete session.spotify;
    for (let n = 1; n <= 5; n++) {
        const snapshot = await (await f.call(`/api/games/${game.code}/access`, { playerId: guest.id }, guestCookie)).json();
        const serialized = JSON.stringify(snapshot);
        assert.equal(snapshot.progress.answer, undefined);
        assert.ok(!serialized.includes("private-access"));
        assert.ok(!serialized.includes("spotifySong"), "track IDs must not reveal answers before reveal");
        const resultResponse = await f.call(`/api/games/${game.code}/reveal`, { playerId: host.id, questionNumber: n }, ownerCookie);
        assert.equal(resultResponse.status, 200);
        const result = await resultResponse.json();
        assert.match(result.progress.answer.title, /^Spotify answer \d+$/);
        assert.match(result.progress.answer.artist, /^Spotify artist \d+$/);
        assert.match(result.progress.answer.spotifyUrl, /^https:\/\/open.spotify.com\/track\/spotifySong\d+$/);
        assert.equal(result.progress.questions, undefined);
        assert.equal((await f.call(`/api/games/${game.code}/next`, { playerId: host.id, questionNumber: n }, ownerCookie)).status, 200);
    }
    assert.equal(f.store.games.get(game.code).status, "finished");
    assert.equal(calls, 2);
});

test("two launches on the same Spotify selection draw independently while only search metadata is cached", async () => {
    let playlistCalls = 0, searchCalls = 0;
    const f = fixture([], async () => { playlistCalls++; return Response.json({ items: spotifyItems(), next: null }); });
    f.setSearchFetch(async url => {
        searchCalls++;
        const artist = new URL(url).searchParams.get("q").match(/^artist:"(.*)"$/)[1];
        return Response.json({ tracks: { items: [0, 1, 2].map(n => ({ id: `outside${artist.replace(/\W/g, "")}${n}`, type: "track", name: `Outside ${artist} ${n}`, artists: [{ name: artist }], is_playable: true })) } });
    });
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const saved = { playlist: { id: "playlistA" }, questionCount: 5, questions: [] };
    session.spotify.questionPreview = saved;
    f.setDraw((...args) => args.length === 2 ? crypto.randomInt(...args) : 0);
    assert.equal((await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).status, 201);
    assert.equal(f.store.gameEngines.get(game.code).getPlayback().trackId, "spotifySong0");
    const next = await (await f.call("/api/games", { nickname: "Host again", questionCount: 5 }, ownerCookie)).json();
    await f.call(`/api/games/${next.game.code}/ready`, { playerId: next.player.id, ready: true }, ownerCookie);
    await f.call(`/api/games/${next.game.code}/playback/device`, { playerId: next.player.id, deviceId: "fixture-device" }, ownerCookie);
    f.setDraw((...args) => args.length === 2 ? crypto.randomInt(...args) : args[0] - 1);
    assert.equal((await f.call(`/api/games/${next.game.code}/start`, { playerId: next.player.id }, ownerCookie)).status, 201);
    assert.equal(f.store.gameEngines.get(next.game.code).getPlayback().trackId, "spotifySong4");
    assert.equal(f.store.gameEngines.get(game.code).getPlayback().trackId, "spotifySong0");
    assert.equal(playlistCalls, 2);
    assert.equal(searchCalls, 5, "artist metadata may be cached, the game draw must not be");
    assert.equal(session.spotify.questionPreview, saved);
});

test("unavailable external searches fall back to the playlist or reject QCM before committing the game", async () => {
    for (const count of [8, 5]) {
        let searches = 0;
        const f = fixture([], async () => Response.json({ items: spotifyItems(count), next: null }));
        f.setSearchFetch(async () => { searches++; return Response.json({}, { status: 429, headers: { "retry-after": "30" } }); });
        const { game, host, ownerCookie } = await createPlayers(f);
        attachSpotify(f, ownerCookie);
        const response = await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie);
        assert.equal(response.status, count === 8 ? 201 : 422);
        assert.equal(searches, 1, "a quota response stops further external searches");
        assert.equal(f.store.games.get(game.code).status, count === 8 ? "question" : "lobby");
        assert.equal(f.store.gameEngines.has(game.code), count === 8);
    }
});

test("free-answer launches never request external QCM candidates", async () => {
    const f = fixture([], async () => Response.json({ items: spotifyItems(), next: null }));
    f.setSearchFetch(async () => assert.fail("free mode must not search for decoys"));
    const { game, host, ownerCookie } = await createPlayers(f, { mode: "free", excerptSeconds: 10, pauseSeconds: 2, excerptPosition: "start" });
    attachSpotify(f, ownerCookie);
    assert.equal((await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).status, 201);
});

test("Socket.IO start generates Spotify questions automatically without a preview and broadcasts no answers", async t => {
    let calls = 0;
    const f = fixture([], async (url, options) => {
        calls++;
        assert.equal(options.headers.Authorization, "Bearer private-access");
        assert.ok(url.includes("/playlists/playlistA/items?limit=50"));
        return Response.json({ items: spotifyItems(), next: null });
    });
    const { game, host, guest, ownerCookie, guestCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const connect = await startTransport(f, t);
    const owner = await connect(ownerCookie);
    const member = await connect(guestCookie);
    for (const [socket, player] of [[owner, host], [member, guest]]) {
        const admitted = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        await admitted;
    }
    const denied = event(member, "start_game_error");
    member.emit("start_game", { code: game.code, playerId: guest.id });
    await denied;
    assert.equal(calls, 0);
    const waiting = [event(owner, "game_started"), event(member, "game_started")];
    owner.emit("start_game", { code: game.code, playerId: host.id });
    const updates = await Promise.all(waiting);
    assert.deepEqual(updates[0], updates[1]);
    assert.equal(updates[0].game.questionSource, "spotify");
    assert.equal(updates[0].progress.status, "question");
    assert.equal(updates[0].progress.answer, undefined);
    assert.ok(!JSON.stringify(updates[0]).includes("private-access"));
    assert.equal(session.spotify.questionPreview, undefined, "launch does not save a reusable preview");
    assert.equal(calls, 1);
});

test("Spotify generation failures keep lobby intact and a later start retries successfully", async () => {
    let count = 2;
    const f = fixture([], async () => Response.json({ items: spotifyItems(count), next: null }));
    const { game, host, ownerCookie } = await createPlayers(f);
    attachSpotify(f, ownerCookie);
    const first = await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie);
    assert.equal(first.status, 422);
    assert.ok((await first.json()).error.includes("playlist"));
    assert.equal(f.store.games.get(game.code).status, "lobby");
    assert.equal(f.store.gameEngines.size, 0);
    assert.equal(f.store.startingGames.size, 0);
    count = 5;
    assert.equal((await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).status, 201);
});

test("concurrent Spotify starts are locked and playlist changes during generation prevent committing the engine", async () => {
    let release;
    let notify;
    const reached = new Promise(resolve => { notify = resolve; });
    const f = fixture([], async () => { notify(); return new Promise(resolve => { release = resolve; }); });
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    const first = f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie);
    await reached;
    assert.equal((await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).status, 409);
    assert.equal((await f.call(`/api/games/${game.code}/playlist`, { playerId: host.id, playlistId: "playlistA" }, ownerCookie)).status, 409, "playlist must lock while preparation is actually in flight");
    assert.equal((await f.call(`/api/games/${game.code}/ready`, { playerId: host.id, ready: false }, ownerCookie)).status, 409);
    assert.equal((await f.call(`/api/games/${game.code}/join`, { nickname: "Late guest" })).status, 409);
    session.spotify.selectedPlaylist = { ...session.spotify.selectedPlaylist, id: "playlistB" };
    release(Response.json({ items: spotifyItems(), next: null }));
    assert.equal((await first).status, 409);
    assert.equal(f.store.games.get(game.code).status, "lobby");
    assert.equal(f.store.gameEngines.size, 0);
    assert.equal(f.store.startingGames.size, 0);
});

test("a preview with another question count is regenerated for the game's requested count", async () => {
    let calls = 0;
    const f = fixture([], async () => { calls++; return Response.json({ items: spotifyItems(), next: null }); });
    const { game, host, ownerCookie } = await createPlayers(f);
    const session = attachSpotify(f, ownerCookie);
    session.spotify.questionPreview = { playlist: { id: "playlistA" }, questionCount: 10, questions: [] };
    assert.equal((await f.call(`/api/games/${game.code}/start`, { playerId: host.id }, ownerCookie)).status, 201);
    assert.equal(calls, 1);
    assert.equal(session.spotify.questionPreview.questionCount, 10, "the old preview remains separate from the game draw");
});
