import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const flush = () => new Promise(setImmediate);
function fixture() {
    const exported = {}, timers = new Map(), requests = [], received = [], responses = [];
    let id = 0;
    const source = ts.transpileModule(fs.readFileSync(new URL("../src/lib/httpGameConnection.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(source, { exports: exported, AbortController, Map, Set,
        setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        fetch: async (url, options) => {
            requests.push({ url, options, body: JSON.parse(options.body) });
            const response = responses.shift();
            assert.ok(response, `unexpected request ${url}`);
            return response instanceof Error ? Promise.reject(response) : response;
        },
    });
    const connection = exported.createHttpGameConnection();
    for (const event of ["game_joined", "game_updated", "game_reset", "player_ready", "player_joined", "playlist_updated", "answer_count_updated", "answer_accepted", "answer_error", "connect_error", "disconnect"]) {
        connection.on(event, data => received.push({ event, data }));
    }
    connection.on("connect", () => connection.emit("join_game", { code: "12345", playerId: "me" }));
    const respond = (data, status = 200) => responses.push(Response.json(data, { status }));
    const poll = async () => {
        const timer = [...timers].find(([, timer]) => timer.delay === 1000);
        assert.ok(timer, "poll must be scheduled"); timers.delete(timer[0]); timer[1].callback(); await flush();
    };
    return { connection, received, requests, respond, poll, timers, responses };
}
const snap = (progress = null) => ({ game: { code: "12345", status: progress?.status ?? "lobby", round: 0 }, players: [{ id: "me", ready: false, readyRevision: 0 }], progress, ownAnswer: null, serverTime: 1000 });
const question = { status: "question", question: { number: 1, endsAt: 5000 }, participation: { answered: 0, total: 2 } };

test("HTTP lobby catches remote readiness, playlist, questions and participation without resetting pending QCM choices", async () => {
    const f = fixture();
    f.respond(snap()); f.connection.connect(); await flush();
    assert.equal(f.received[0].event, "game_joined");
    assert.equal(f.requests[0].options.credentials, "same-origin");
    const lobby = snap();
    lobby.players[0].ready = true; lobby.players[0].readyRevision = 1;
    lobby.players.push({ id: "guest", readyRevision: 0 });
    lobby.game.playlistRevision = 1; lobby.game.playlist = { id: "playlist" };
    f.respond(lobby); await f.poll();
    assert.ok(f.received.some(item => item.event === "player_joined" && item.data.player.id === "guest"));
    assert.ok(f.received.some(item => item.event === "player_ready" && item.data.player.ready));
    assert.ok(f.received.some(item => item.event === "playlist_updated"));
    f.respond(snap(question)); await f.poll();
    assert.equal(f.received.filter(item => item.event === "game_updated").length, 1);
    const counted = snap({ ...question, participation: { answered: 1, total: 2 } });
    counted.ownAnswer = { choiceId: "a", confirmed: false, revision: 2, questionNumber: 1, round: 0 };
    f.respond(counted); await f.poll();
    assert.equal(f.received.filter(item => item.event === "game_updated").length, 1, "participation must not clear an in-flight draft");
    assert.equal(f.received.at(-2).event, "answer_count_updated");
    assert.equal(f.received.at(-1).event, "answer_accepted");
    f.respond(snap({ status: "result", question: question.question })); await f.poll();
    assert.equal(f.received.at(-1).event, "game_updated");
    const rematch = snap(); rematch.game.round = 1;
    f.respond(rematch); await f.poll();
    assert.ok(f.received.some(item => item.event === "game_reset" && item.data.game.round === 1));
    f.connection.disconnect();
    assert.equal(f.timers.size, 0);
});

test("HTTP retries a failed poll, reloads admission, preserves command errors and aborts on unmount", async () => {
    const f = fixture();
    f.respond(snap(question)); f.connection.connect(); await flush();
    f.respond({ error: "Storage busy" }, 503); await f.poll();
    assert.equal(f.connection.connected, false);
    assert.equal(f.received.at(-1).event, "connect_error");
    f.respond(snap(question)); await f.poll();
    assert.equal(f.connection.connected, true);
    assert.equal(f.received.at(-1).event, "game_joined");
    f.respond({ error: "Too late" }, 409);
    f.connection.emit("submit_answer", { code: "12345", playerId: "me", questionNumber: 1, choiceId: "a", revision: 7, round: 0 });
    await flush();
    assert.equal(f.received.at(-1).event, "answer_error");
    assert.equal(f.received.at(-1).data.revision, 7);
    assert.equal(f.requests.at(-1).url, "/api/games/12345/answer");
    f.connection.disconnect();
    assert.equal(f.timers.size, 0);
    const before = f.requests.length;
    f.connection.emit("submit_answer", { code: "12345", playerId: "me" });
    assert.equal(f.requests.length, before);
});
