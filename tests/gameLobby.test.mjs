import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function lobbyFixture(isHost = true) {
    const states = [];
    let cursor = 0;
    let effect;
    let cleanup;
    const handlers = new Map();
    const emitted = [];
    const Button = "StartButton";
    const jsx = (type, props, key) => ({ type, props, key });
    const socket = {
        connected: false,
        on(name, handler) { handlers.set(name, handler); },
        connect() { this.connected = true; handlers.get("connect")(); },
        disconnect() { this.connected = false; handlers.get("disconnect")(); },
        emit(name, payload) { emitted.push({ name, payload }); },
    };
    const source = fs.readFileSync(new URL("../src/app/game/[code]/GameLobby.tsx", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exported = {};
    vm.runInNewContext(compiled, {
        exports: exported, process: { env: {} },
        require(name) {
            if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
            if (name === "next/link") return { default: "Link" };
            if (name === "./HostSpotifyAudio") return { default: "HostAudio" };
            if (name === "./LobbyPlaylistPicker") return { default: "PlaylistPicker" };
            if (name === "./PersonalGameReview") return { default: "PersonalReview" };
            if (name === "./FreeAnswer") return { default: "FreeAnswer" };
            if (name === "./QuestionChoices") return { default: "Choices", RoundCountdown: "Timer" };
            if (name === "./StartGameButton") return { default: Button };
            if (name === "socket.io-client") return { io: () => socket };
            if (name === "@/src/lib/httpGameConnection") return { createHttpGameConnection: () => socket };
            if (name === "react") return {
                useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
                useRef(initial) { const index = cursor++; return states[index] ?? (states[index] = { current: initial }); },
                useEffect(callback) { effect ??= callback; },
            };
            throw Error(name);
        },
    });
    const playlist = { id: "fixturePlaylist", name: "Fixture playlist", url: "https://open.spotify.com/playlist/fixturePlaylist" };
    const props = { initialPlayers: [{ id: "host", nickname: "Host", ready: true }], initialStatus: "lobby", initialProgress: null, initialPlaylist: playlist, isHost, hostId: "host", code: "12345", playerId: isHost ? "host" : "guest", nickname: "Player" };
    const render = () => { cursor = 0; return exported.default(props); };
    render();
    cleanup = effect();
    const receive = (name, data) => handlers.get(name)(data);
    const walk = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
    const text = node => typeof node === "string" || typeof node === "number" ? String(node) : !node || typeof node !== "object" ? "" : [node.props?.children].flat(Infinity).map(text).join(" ");
    const find = predicate => walk(render()).find(predicate);
    const button = label => find(node => node.type === "button" && text(node).includes(label));
    const snapshot = progress => ({ game: { status: progress?.status ?? "lobby", playlist }, players: props.initialPlayers, progress });
    return { render, receive, find, button, text: () => text(render()).replace(/\s+/g, " ").trim(), emitted, socket, snapshot, cleanup };
}
const question = number => ({ status: "question", question: { number, total: 2, audioPath: `/audio/${number}.mp3` } });
const result = number => ({ status: "result", question: question(number).question, answer: { title: `Answer ${number}`, artist: `Artist ${number}` } });

function questionFixture(filename, props) {
    const states = [], effects = [], ticks = [];
    let cursor = 0;
    const exported = {};
    const jsx = (type, props) => ({ type, props });
    const compiled = ts.transpileModule(fs.readFileSync(new URL(`../src/app/game/[code]/${filename}.tsx`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(compiled, { exports: exported, Date: { now: () => 10000 }, setInterval: callback => ticks.push(callback), clearInterval() {},
        require(name) {
            if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
            if (name === "./QuestionChoices") return { RoundCountdown: "Timer" };
            if (name === "react") return {
                useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
                useEffect(callback) { effects.push(callback); },
            };
            throw Error(name);
        },
    });
    const render = () => { cursor = 0; return exported.default(props); };
    const walk = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
    render();
    effects.forEach(effect => effect());
    return { render, all: type => walk(render()).filter(node => node.type === type), tick: () => ticks.forEach(tick => tick()) };
}

test("number fields keep native validation, enforce stepper limits and recover an empty value", () => {
    const changes = [];
    const props = { id: "duration", label: "Durée", value: 1, min: 1, max: 30, hint: "De 1 à 30 secondes.", onChange: value => { changes.push(value); props.value = value; } };
    const f = questionFixture("../../components/NumberField", props);
    assert.equal(f.all("button")[0].props.disabled, true);
    assert.equal(f.all("button")[1].props.type, "button", "stepper must not submit the form");
    f.all("button")[1].props.onClick();
    assert.equal(props.value, 2);
    props.value = 30;
    assert.equal(f.all("button")[1].props.disabled, true);
    f.all("button")[1].props.onClick();
    assert.equal(props.value, 30);
    f.all("button")[0].props.onClick();
    assert.equal(props.value, 29);
    const input = f.all("input")[0].props;
    assert.equal(input.type, "number");
    assert.equal(input.inputMode, "numeric");
    assert.equal(input.required, true);
    assert.equal(input.min, 1);
    assert.equal(input.max, 30);
    assert.equal(input.step, 1);
    assert.equal(input["aria-describedby"], "duration-hint");
    assert.equal(f.all("label")[0].props.htmlFor, input.id);
    input.onChange({ target: { valueAsNumber: Number.NaN } });
    assert.ok(Number.isNaN(props.value));
    assert.equal(f.all("input")[0].props.value, "");
    f.all("button")[1].props.onClick();
    assert.equal(props.value, 1);
    props.disabled = true;
    assert.ok(f.all("button").every(button => button.props.disabled));
    assert.equal(f.all("input")[0].props.disabled, true);
    const before = changes.length;
    f.all("button")[1].props.onClick();
    assert.equal(changes.length, before);
});

test("number fields accept zero pauses and respect the response duration minimum", () => {
    for (const [min, max] of [[0, 30], [20, 120]]) {
        const props = { id: "duration", label: "Durée", min, max, value: min, onChange: value => { props.value = value; } };
        const f = questionFixture("../../components/NumberField", props);
        f.all("button")[0].props.onClick();
        assert.equal(props.value, min);
        assert.equal(f.all("input")[0].props.min, min);
        props.value = max;
        f.all("button")[1].props.onClick();
        assert.equal(props.value, max);
    }
});

function personalReviewFixture(props, fetchMock) {
    const states = [], exported = {};
    let cursor = 0, dependencies, pendingEffect, cleanup;
    const jsx = (type, props) => ({ type, props });
    const source = fs.readFileSync(new URL("../src/app/game/[code]/PersonalGameReview.tsx", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(compiled, { exports: exported, AbortController, fetch: fetchMock, require(name) {
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "./QuestionChoices") return { default: "Choices" };
        if (name === "react") return {
            useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
            useEffect(callback, next) { if (!dependencies || next.some((value, index) => value !== dependencies[index])) { dependencies = [...next]; pendingEffect = callback; } },
        };
        throw Error(name);
    } });
    const render = () => { cursor = 0; const tree = exported.default(props); if (pendingEffect) { cleanup?.(); const effect = pendingEffect; pendingEffect = null; cleanup = effect(); } return tree; };
    const walk = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
    const text = node => typeof node === "string" || typeof node === "number" ? String(node) : !node || typeof node !== "object" ? "" : [node.props?.children].flat(Infinity).map(text).join(" ");
    render();
    return { text: () => text(render()).replace(/\s+/g, " "), nodes: type => walk(render()).filter(node => node.type === type), flush: () => new Promise(resolve => setImmediate(resolve)), cleanup: () => cleanup?.() };
}

test("personal correction displays typed answers, wrong QCM choices, automatic votes and the score breakdown", async () => {
    const choices = ["a", "b", "c", "d"].map(id => ({ id, title: `Title ${id}`, artist: "Artist" }));
    const review = [1, 2, 3, 4].map(number => ({ question: { number, ...(number === 1 || number === 4 ? { mode: "qcm", choices } : { mode: "free" }) }, answer: { title: "Correct title", artist: "Artist", choiceId: "b" }, results: [] }));
    const ownReview = [
        { questionNumber: 1, answered: true, correct: false, choiceId: "a", automatic: false, responseMs: 1000, basePoints: 0, bonusPoints: 0, points: 0 },
        { questionNumber: 2, answered: true, correct: true, text: "My exact typed answer", automatic: false, responseMs: 5000, basePoints: 10, bonusPoints: 5, points: 15 },
        { questionNumber: 3, answered: false, correct: false, automatic: false, responseMs: null, basePoints: 0, bonusPoints: 0, points: 0 },
        { questionNumber: 4, answered: true, correct: true, choiceId: "b", automatic: true, responseMs: 10000, basePoints: 10, bonusPoints: 0, points: 10 },
    ];
    const calls = [];
    const f = personalReviewFixture({ code: "12345", playerId: "guest", round: 2, review }, async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ game: { round: 2 }, progress: { status: "finished" }, ownReview }) };
    });
    await f.flush();
    assert.equal(calls[0].url, "/api/games/12345/access");
    assert.equal(JSON.parse(calls[0].options.body).playerId, "guest");
    assert.ok(f.text().includes("My exact typed answer"));
    assert.equal(f.nodes("p").filter(node => node.props.className === "review-correct-answer").length, 2, "answer boxes remain only for free-answer rounds");
    assert.equal(f.nodes("p").filter(node => node.props.className?.startsWith("review-own-answer")).length, 2);
    const firstContent = f.nodes("div").find(node => node.props.className === "personal-review-content");
    const firstChildren = [firstContent.props.children].flat(Infinity).filter(node => node && typeof node === "object");
    assert.equal(firstChildren[0].type, "Choices", "the cards precede timing and points");
    assert.ok(f.text().includes("Aucune réponse enregistrée"));
    assert.ok(f.text().includes("Présélection comptée automatiquement"));
    assert.match(f.text(), /Bonus de rapidité \+\s*5 pts/);
    assert.ok(f.text().includes("Total de la manche 15 pts"));
    assert.equal(f.nodes("Choices")[0].props.receipt.choiceId, "a");
    assert.equal(f.nodes("Choices")[0].props.correctChoiceId, "b");
    assert.ok(f.nodes("Choices").every(node => node.props.disabled));
    f.cleanup();
});

test("personal correction rejects the wrong round, retries loading and cancels requests on exit", async () => {
    let requests = 0;
    const signals = [];
    const f = personalReviewFixture({ code: "12345", playerId: "guest", round: 1, review: [] }, async (_url, options) => {
        signals.push(options.signal);
        return { ok: true, json: async () => ({ game: { round: requests++ === 0 ? 0 : 1 }, progress: { status: "finished" }, ownReview: [] }) };
    });
    await f.flush();
    assert.ok(f.text().includes("Cette correction concerne une partie terminée"));
    f.nodes("button")[0].props.onClick();
    f.text();
    await f.flush();
    assert.ok(!f.text().includes("Cette correction concerne une partie terminée"));
    assert.equal(requests, 2);
    assert.equal(signals[0].aborted, true);
    f.cleanup();
    assert.equal(signals[1].aborted, true);
});

test("revealed QCM keeps four cards, always marks correct green and only a wrong selected card red", () => {
    const choices = ["a", "b", "c", "d"].map(id => ({ id, title: id, artist: "Artist" }));
    for (const selected of [null, "a", "b"]) {
        let sent = false;
        const f = questionFixture("QuestionChoices", {
            question: { number: 1, choices }, receipt: selected ? { choiceId: selected, questionNumber: 1 } : null,
            pending: false, disabled: false, serverOffsetMs: 0, correctChoiceId: "a", onAnswer: () => { sent = true; },
        });
        const cards = f.all("button");
        assert.equal(f.all("p").length, 0, "revealed choices do not repeat the explanatory sentence");
        assert.equal(cards.length, 4);
        assert.ok(cards[0].props.className.includes("answer-choice--correct"));
        assert.equal(cards.filter(card => card.props.className.includes("answer-choice--wrong")).length, selected === "b" ? 1 : 0);
        assert.equal(cards.every(card => card.props.disabled), true);
        cards[0].props.onClick();
        assert.equal(sent, false);
    }
});

test("QCM cards remain editable while saving and lock only after explicit confirmation", () => {
    const sent = [];
    const props = { question: { number: 1, choices: ["a", "b", "c", "d"].map(id => ({ id, title: id, artist: "Artist" })), startsAt: 9000, endsAt: 20000 }, receipt: null, pending: false, disabled: false, serverOffsetMs: 0,
        onAnswer(id, confirmed) { sent.push({ id, confirmed }); props.receipt = { questionNumber: 1, choiceId: id, confirmed }; props.pending = true; } };
    const f = questionFixture("QuestionChoices", props);
    f.tick();
    assert.equal(f.all("button")[4].props.disabled, true);
    f.all("button")[0].props.onClick();
    assert.equal(f.all("button")[1].props.disabled, false, "draft saving must not block another click");
    f.all("button")[1].props.onClick();
    assert.equal(f.all("button")[1].props["aria-pressed"], true);
    f.all("button")[4].props.onClick();
    assert.deepEqual(sent, [{ id: "a", confirmed: false }, { id: "b", confirmed: false }, { id: "b", confirmed: true }]);
    assert.ok(f.all("button").every(button => button.props.disabled));
    f.all("button")[0].props.onClick();
    assert.equal(sent.length, 3);
});

test("lobby ignores stale draft acknowledgements and errors while preserving the latest selection", () => {
    const f = lobbyFixture(false);
    f.receive("game_joined", f.snapshot({ ...question(1), question: { ...question(1).question, mode: "qcm", choices: [] } }));
    const choose = (id, confirmed) => f.find(node => node.type === "Choices").props.onAnswer(id, confirmed);
    choose("a", false);
    choose("b", false);
    const answers = f.emitted.filter(item => item.name === "submit_answer");
    assert.deepEqual(answers.map(item => item.payload.revision), [1, 2]);
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "a", confirmed: false, revision: 1 });
    assert.equal(f.find(node => node.type === "Choices").props.receipt.choiceId, "b");
    f.receive("answer_error", { error: "Stale error", questionNumber: 1, revision: 1 });
    assert.ok(!f.text().includes("Stale error"));
    choose("b", true);
    assert.equal(f.emitted.at(-1).payload.revision, 3);
    choose("c", false);
    assert.equal(f.emitted.filter(item => item.name === "submit_answer").length, 3);
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "b", confirmed: true, revision: 3 });
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "a", confirmed: false, revision: 1 });
    assert.equal(f.find(node => node.type === "Choices").props.receipt.choiceId, "b");
    assert.equal(f.find(node => node.type === "Choices").props.receipt.confirmed, true);
    f.cleanup();
});

test("after a failed newer draft the lobby restores server state without resetting its revision counter", () => {
    const f = lobbyFixture(false);
    const state = { ...question(1), question: { ...question(1).question, mode: "qcm", choices: [] } };
    f.receive("game_joined", f.snapshot(state));
    const choose = id => f.find(node => node.type === "Choices").props.onAnswer(id, false);
    choose("a");
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "a", confirmed: false, revision: 1 });
    choose("b");
    choose("c");
    f.receive("answer_error", { error: "Network failure", questionNumber: 1, revision: 3 });
    f.receive("game_joined", { ...f.snapshot(state), ownAnswer: { questionNumber: 1, choiceId: "a", confirmed: false, revision: 1 } });
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "b", confirmed: false, revision: 2 });
    assert.equal(f.find(node => node.type === "Choices").props.receipt.choiceId, "b");
    choose("d");
    assert.equal(f.emitted.at(-1).payload.revision, 4);
    f.cleanup();
});

test("free answer input waits for the round and submits only the typed title", () => {
    const answers = [];
    const props = { question: { number: 1, startsAt: 9000, endsAt: 20000 }, receipt: null, pending: false, disabled: false, serverOffsetMs: 0, onAnswer: value => answers.push(value) };
    const f = questionFixture("FreeAnswer", props);
    assert.equal(f.all("input")[0].props.disabled, true);
    f.tick();
    assert.equal(f.all("input")[0].props.disabled, false);
    f.all("input")[0].props.onChange({ target: { value: "  My title  " } });
    f.all("form")[0].props.onSubmit({ preventDefault() {} });
    assert.deepEqual(answers, ["My title"]);
    props.receipt = { questionNumber: 1, text: "My title" };
    assert.equal(f.all("input")[0].props.value, "My title");
    assert.equal(f.all("button")[0].props.disabled, true);
    f.all("form")[0].props.onSubmit({ preventDefault() {} });
    assert.equal(answers.length, 1);
});

test("lobby sends free text and uses the server score for free-answer feedback", () => {
    const f = lobbyFixture(false);
    const q = { ...question(1), question: { number: 1, total: 2, mode: "free" } };
    f.receive("game_joined", f.snapshot(q));
    f.find(node => node.type === "FreeAnswer").props.onAnswer("My title");
    const submitted = f.emitted.at(-1);
    assert.equal(submitted.name, "submit_answer");
    assert.equal(submitted.payload.text, "My title");
    assert.equal(submitted.payload.choiceId, undefined);
    f.receive("answer_accepted", { questionNumber: 1, text: "My title" });
    f.receive("game_updated", f.snapshot({ status: "result", question: q.question, answer: { title: "Correct title", artist: "Artist" }, scores: [{ playerId: "guest", correct: false, points: 0, total: 0 }] }));
    assert.ok(f.text().includes("My title"));
    assert.ok(f.text().includes("Ce n’était pas la bonne réponse"));
    assert.ok(!f.text().includes("Bonne réponse : +10"));
    f.cleanup();
});

function browserHelpers() {
    const exported = {};
    const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/lib/spotifyBrowser.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(compiled, { exports: exported, setTimeout, clearTimeout });
    return exported;
}

function playerSessionHelpers(window) {
    const exported = {};
    const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/lib/spotifyPlayerSession.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(compiled, { exports: exported, window });
    return exported;
}

function playlistPickerFixture(fetchMock, connected = true) {
    const states = [], effects = [];
    let cursor = 0;
    const exported = {};
    const jsx = (type, props) => ({ type, props });
    const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/app/game/[code]/LobbyPlaylistPicker.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(compiled, { exports: exported, window: { location: { origin: "http://127.0.0.1:3000" } }, AbortController,
        fetch: async (url, options) => url === "/api/spotify/status" ? { ok: true, json: async () => ({ configured: true, connected, playbackAuthorized: connected, appUrl: "http://127.0.0.1:3000" }) } : fetchMock(url, options),
        require(name) {
            if (name === "next/link") return { default: "Link" };
            if (name === "../../spotify/SpotifyPlaylistCard") return { default: "Card" };
            if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
            if (name === "react") return {
                useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
                useRef(initial) { const i = cursor++; return states[i] ??= { current: initial }; },
                useEffect(callback) { effects.push(callback); },
            };
            throw Error(name);
        },
    });
    const selected = [];
    const props = { code: "12345", playerId: "host", selectedPlaylist: null, disabled: false, pending: false, onSelect: id => selected.push(id) };
    const render = () => { cursor = 0; return exported.default(props); };
    const walk = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
    const text = node => typeof node === "string" ? node : !node || typeof node !== "object" ? "" : [node.props?.children].flat(Infinity).map(text).join(" ");
    render();
    const cleanup = effects[0]();
    return { props, selected, cleanup, all: type => walk(render()).filter(node => node.type === type), button: label => walk(render()).find(node => node.type === "button" && text(node).includes(label)) };
}

test("lobby playlist picker paginates, highlights the room choice and blocks changes when disabled", async () => {
    const a = { id: "a", name: "First", url: "https://open.spotify.com/playlist/a" };
    const b = { id: "b", name: "Second", url: "https://open.spotify.com/playlist/b" };
    const f = playlistPickerFixture(async url => ({ ok: true, json: async () => url.includes("offset=20") ? { playlists: [a, b], nextOffset: null } : { playlists: [a], nextOffset: 20 } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.all("Card").length, 1);
    f.all("Card")[0].props.onSelect("a");
    assert.deepEqual(f.selected, ["a"]);
    f.props.selectedPlaylist = a;
    assert.equal(f.all("Card")[0].props.selected, true);
    f.button("Afficher la suite").props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.all("Card").length, 2, "pagination must deduplicate previously loaded playlists");
    f.props.disabled = true;
    f.all("Card")[1].props.onSelect("b");
    assert.deepEqual(f.selected, ["a"]);
    assert.equal(f.all("Card")[1].props.disabled, true);
    f.cleanup();
});

test("disconnected lobby picker links Spotify authorization to the host room without loading playlists", async () => {
    const f = playlistPickerFixture(async () => assert.fail("must not fetch playlists before connection"), false);
    await new Promise(resolve => setImmediate(resolve));
    const form = f.all("form")[0];
    assert.equal(form.props.action, "/api/spotify/login");
    assert.equal(form.props.method, "post");
    assert.deepEqual(f.all("input").map(node => [node.props.name, node.props.value]), [["gameCode", "12345"], ["playerId", "host"]]);
    f.cleanup();
});

test("the persistent player routes events and OAuth requests to the current room only", async () => {
    const instances = [];
    class Player {
        handlers = new Map(); pauses = 0; disconnected = false;
        constructor(options) { this.options = options; instances.push(this); }
        addListener(event, callback) { this.handlers.set(event, callback); }
        connect() { return Promise.resolve(true); }
        pause() { this.pauses++; return Promise.resolve(); }
        disconnect() { this.disconnected = true; }
    }
    const events = [], tokens = [];
    const bind = name => ({ getToken: async () => { tokens.push(name); return `token-${name}`; },
        onReady: id => events.push(`${name}:${id}`), onNotReady: () => events.push(`${name}:offline`), onError() {}, onTokenError() {} });
    const session = playerSessionHelpers().createSpotifyPlayerSession();
    const first = session.acquire(Player, bind("first"));
    await first.connect();
    instances[0].handlers.get("ready")({ device_id: "stable-device" });
    first.release();
    assert.equal(instances[0].disconnected, false);
    assert.equal(instances[0].pauses, 1);
    const second = session.acquire(Player, bind("second"));
    assert.equal(instances.length, 1);
    assert.equal(second.deviceId, "stable-device");
    first.release();
    assert.equal(instances[0].pauses, 1, "a stale room must not pause the current room");
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
    instances[0].handlers.get("ready")({ device_id: "stable-device" });
    const token = await new Promise(resolve => instances[0].options.getOAuthToken(resolve));
    assert.equal(token, "token-second");
    assert.deepEqual(tokens, ["second"]);
    assert.deepEqual(events, ["first:stable-device", "second:stable-device"]);
    session.reset();
    assert.equal(instances[0].disconnected, true);
    assert.equal(second.isCurrent(), false);
});

test("disconnect clears the cached device and suppresses pending tokens and stale SDK events", async () => {
    const instances = [];
    let complete;
    class Player {
        handlers = new Map();
        constructor(options) { this.options = options; instances.push(this); }
        addListener(event, callback) { this.handlers.set(event, callback); }
        pause() { return Promise.resolve(); }
        connect() { return Promise.resolve(true); }
        disconnect() {}
    }
    const session = playerSessionHelpers().createSpotifyPlayerSession();
    const binding = { getToken: () => new Promise(resolve => { complete = resolve; }), onReady() {}, onNotReady() {}, onError() {}, onTokenError() {} };
    session.acquire(Player, binding);
    const token = new Promise(resolve => instances[0].options.getOAuthToken(resolve));
    session.reset();
    complete("old-account-token");
    assert.equal(await token, "");
    const next = session.acquire(Player, { ...binding, getToken: async () => "new-account-token" });
    instances[0].handlers.get("ready")({ device_id: "obsolete-device" });
    assert.equal(next.deviceId, null);
    assert.equal(instances.length, 2);
    session.reset();
});

test("the tab reuses its player manager across module reloads and resets it on logout or page close", () => {
    const handlers = new Map();
    const window = { addEventListener: (event, callback) => handlers.set(event, callback) };
    const first = playerSessionHelpers(window);
    const session = first.getSpotifyPlayerSession();
    assert.equal(playerSessionHelpers(window).getSpotifyPlayerSession(), session);
    let disconnected = 0;
    class Player { addListener() {} disconnect() { disconnected++; } pause() { return Promise.resolve(); } }
    const binding = { getToken: async () => "", onReady() {}, onNotReady() {}, onError() {}, onTokenError() {} };
    session.acquire(Player, binding);
    first.disconnectSpotifyBrowserPlayer();
    assert.equal(disconnected, 1);
    session.acquire(Player, binding);
    handlers.get("pagehide")();
    assert.equal(disconnected, 2);
});

function audioFixture(fetchMock, timers = { setTimeout, clearTimeout }, waitForDeviceRetry) {
    const states = [], effects = [], players = [];
    let cursor = 0;
    const readiness = [];
    const persistentSession = playerSessionHelpers().createSpotifyPlayerSession();
    const jsx = (type, props) => ({ type, props });
    class Player {
        handlers = new Map();
        disconnected = false;
        connectCalls = 0;
        activationCalls = 0;
        constructor() { players.push(this); }
        addListener(name, handler) { this.handlers.set(name, handler); }
        activateElement() { this.activationCalls++; return Promise.resolve(); }
        connect() { this.connectCalls++; return Promise.resolve(true); }
        pause() { return Promise.resolve(); }
        disconnect() { this.disconnected = true; }
    }
    const exported = {};
    const source = fs.readFileSync(new URL("../src/app/game/[code]/HostSpotifyAudio.tsx", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(compiled, {
        exports: exported, window: { Spotify: { Player } }, Date, ...timers, AbortController,
        fetch: fetchMock ?? (async () => ({ ok: true, json: async () => ({ ready: true }) })),
        require(name) {
            if (name === "next/link") return { default: "Link" };
            if (name.endsWith("spotifyPlayerSession")) return { getSpotifyPlayerSession: () => persistentSession };
            if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
            if (name.endsWith("spotifyBrowser")) {
                const helpers = browserHelpers();
                return { ...helpers, loadSpotifyBrowserSdk: async () => {}, registerSpotifyBrowserDevice: (register, signal, wait, recover) => helpers.registerSpotifyBrowserDevice(register, signal, waitForDeviceRetry ?? wait, recover) };
            }
            if (name === "react") return {
                useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
                useRef(initial) { const index = cursor++; return states[index] ??= { current: initial }; },
                useEffect(callback) { effects.push(callback); },
            };
            throw Error(name);
        },
    });
    const props = { code: "12345", playerId: "host", progress: null, serverOffsetMs: 0, onReadyChange: ready => readiness.push(ready) };
    const render = () => { cursor = 0; return exported.default(props); };
    const walk = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
    const text = node => typeof node === "string" || typeof node === "number" ? String(node) : !node || typeof node !== "object" ? "" : [node.props?.children].flat(Infinity).map(text).join(" ");
    render();
    let cleanup = effects[0]();
    return { players, readiness, render, cleanup: () => cleanup(),
        changeRoom(code, playerId) { cleanup(); props.code = code; props.playerId = playerId; const nextEffect = effects.length; render(); cleanup = effects[nextEffect](); },
        text: () => text(render()), activate: () => walk(render()).find(node => node.type === "button").props.onClick() };
}

test("Spotify activation retries only unavailable-device errors with bounded backoff", async () => {
    const { registerSpotifyBrowserDevice } = browserHelpers();
    const offline = Object.assign(Error("offline"), { code: "DEVICE_UNAVAILABLE" });
    let calls = 0;
    const delays = [];
    await registerSpotifyBrowserDevice(async () => { if (++calls < 3) throw offline; }, new AbortController().signal, async ms => { delays.push(ms); });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [400, 800]);
    calls = 0;
    await assert.rejects(registerSpotifyBrowserDevice(async () => { calls++; throw offline; }, new AbortController().signal, async () => {}));
    assert.equal(calls, 4);
    calls = 0;
    await assert.rejects(registerSpotifyBrowserDevice(async () => { calls++; throw Error("Premium required"); }, new AbortController().signal, async () => assert.fail("must not retry account errors")));
    assert.equal(calls, 1);
    const controller = new AbortController();
    calls = 0;
    await assert.rejects(registerSpotifyBrowserDevice(async () => { calls++; throw offline; }, controller.signal, async () => { controller.abort(); }));
    assert.equal(calls, 1);
});

test("four unavailable-device responses trigger exactly one recovery and never loop on recovery errors", async () => {
    const { registerSpotifyBrowserDevice } = browserHelpers();
    const offline = Object.assign(Error("offline"), { code: "DEVICE_UNAVAILABLE" });
    let calls = 0, recoveries = 0;
    await registerSpotifyBrowserDevice(async () => { calls++; throw offline; }, new AbortController().signal, async () => {}, async () => { recoveries++; });
    assert.equal(calls, 4);
    assert.equal(recoveries, 1);
    calls = 0; recoveries = 0;
    await assert.rejects(registerSpotifyBrowserDevice(async () => { calls++; throw offline; }, new AbortController().signal, async () => {}, async () => { recoveries++; throw offline; }));
    assert.equal(calls, 4);
    assert.equal(recoveries, 1);
    for (const code of ["AUTHENTICATION_ERROR", "PREMIUM_REQUIRED", "RATE_LIMITED"]) {
        recoveries = 0;
        await assert.rejects(registerSpotifyBrowserDevice(async () => { throw Object.assign(Error(code), { code }); }, new AbortController().signal, async () => {}, async () => { recoveries++; }));
        assert.equal(recoveries, 0);
    }
    const controller = new AbortController();
    recoveries = 0;
    await assert.rejects(registerSpotifyBrowserDevice(async () => { throw offline; }, controller.signal, async () => { controller.abort(); }, async () => { recoveries++; }));
    assert.equal(recoveries, 0);
});

test("host audio automatically requests recovery after four failures without replacing the SDK player", async () => {
    const requests = [];
    const f = audioFixture(async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        if (!body.recover) return { ok: false, json: async () => ({ error: "Offline", code: "DEVICE_UNAVAILABLE" }) };
        return { ok: true, json: async () => ({ ready: true }) };
    }, { setTimeout, clearTimeout }, async () => {});
    await Promise.resolve();
    f.activate();
    f.players[0].handlers.get("ready")({ device_id: "same-device" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 5);
    assert.equal(requests.filter(request => request.body.recover === true).length, 1);
    assert.ok(requests.every(request => request.body.deviceId === "same-device"));
    assert.ok(requests.every(request => request.url.endsWith("/playback/device")));
    assert.equal(f.players.length, 1);
    assert.equal(f.players[0].disconnected, false);
    assert.equal(f.readiness.at(-1), true);
    assert.ok(f.text().includes("Lecteur prêt"));
    f.cleanup();
});

test("the last Spotify diagnostic remains visible when a subsequent local recovery limit is hit", async () => {
    let recoveries = 0;
    const diagnostic = { operation: "transfer", spotifyStatus: 404, reason: "NO_ACTIVE_DEVICE", recovery: true };
    const f = audioFixture(async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.recover && ++recoveries > 1) return { ok: false, json: async () => ({ error: "Patiente 30 secondes" }) };
        return { ok: false, json: async () => ({ error: "Unavailable", code: "DEVICE_UNAVAILABLE", diagnostic }) };
    }, { setTimeout, clearTimeout }, async () => {});
    await Promise.resolve();
    f.activate();
    f.players[0].handlers.get("ready")({ device_id: "device" });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.text().includes("Dernier diagnostic Spotify"));
    assert.ok(f.text().includes("NO_ACTIVE_DEVICE"));
    assert.ok(f.text().includes("404"));
    f.activate();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.text().includes("Patiente 30 secondes"));
    assert.ok(f.text().includes("NO_ACTIVE_DEVICE"));
    f.cleanup();
});

test("retrying activation reuses the SDK device instead of disconnecting and creating another", async () => {
    const ids = [];
    const f = audioFixture(async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.deviceId) {
            ids.push(body.deviceId);
            if (ids.length === 1) return { ok: false, json: async () => ({ error: "Temporary failure" }) };
        }
        return { ok: true, json: async () => ({ ready: true }) };
    });
    await Promise.resolve();
    f.activate();
    const player = f.players[0];
    player.handlers.get("ready")({ device_id: "same-device" });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.text().includes("Réessayer l’activation"));
    f.activate();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.players.length, 1);
    assert.equal(player.disconnected, false);
    assert.equal(player.connectCalls, 1);
    assert.equal(player.activationCalls, 2);
    assert.deepEqual(ids, ["same-device", "same-device"]);
    assert.equal(f.readiness.at(-1), true);
    f.cleanup();
});

test("a second room reuses the same connected SDK device without reconnecting the Spotify account", async () => {
    const registrations = [];
    const f = audioFixture(async (url, options) => {
        assert.ok(!url.includes("/spotify/login"));
        const body = JSON.parse(options.body);
        if (body.deviceId) registrations.push({ url, id: body.deviceId });
        return { ok: true, json: async () => ({ ready: true }) };
    });
    await Promise.resolve();
    f.activate();
    const first = f.players[0];
    first.handlers.get("ready")({ device_id: "first-device" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.readiness.at(-1), true);
    f.changeRoom("67890", "second-host");
    await Promise.resolve();
    f.activate();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.players.length, 1);
    assert.equal(first.disconnected, false);
    assert.equal(first.connectCalls, 1, "changing rooms must not create a new Spotify Connect device");
    assert.equal(f.readiness.at(-1), true);
    assert.equal(registrations[1].id, "first-device");
    assert.ok(registrations[1].url.includes("/67890/"));
    f.cleanup();
});

test("activation timeout allows retry and a late server reply cannot mark the reader ready", async () => {
    const timers = new Map();
    let nextId = 0, complete;
    const f = audioFixture(async (_url, options) => JSON.parse(options.body).deviceId
        ? new Promise(resolve => { complete = resolve; })
        : { ok: true, json: async () => ({ ready: false }) }, {
        setTimeout: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    await Promise.resolve();
    f.activate();
    f.players[0].handlers.get("ready")({ device_id: "slow-device" });
    const [id, timer] = [...timers][0];
    assert.equal(timer.ms, 20000);
    timers.delete(id);
    timer.callback();
    complete({ ok: true, json: async () => ({ ready: true }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.readiness.includes(true), false);
    assert.ok(f.text().includes("prend trop de temps"));
    assert.ok(f.text().includes("Réessayer l’activation"));
    f.cleanup();
});

test("Spotify not_ready cancels an activation still waiting for the server", async () => {
    let complete;
    const f = audioFixture(async (_url, options) => {
        if (JSON.parse(options.body).deviceId) return new Promise(resolve => { complete = resolve; });
        return { ok: true, json: async () => ({ ready: false }) };
    });
    await Promise.resolve();
    f.activate();
    const player = f.players[0];
    player.handlers.get("ready")({ device_id: "device" });
    player.handlers.get("not_ready")({ device_id: "device" });
    complete({ ok: true, json: async () => ({ ready: true }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.readiness.includes(true), false);
    assert.ok(!f.text().includes("Lecteur prêt"));
    f.cleanup();
});

test("Spotify errors distinguish permissions, Premium, autoplay and playback without exposing raw SDK data", async () => {
    for (const [event, expected, fatal] of [
        ["authentication_error", "autorisations Spotify sont incomplètes", true],
        ["account_error", "Premium", true],
        ["initialization_error", "contenus protégés", true],
        ["autoplay_failed", "lecture automatique", false],
        ["playback_error", "Reprendre l’extrait", false],
    ]) {
        const f = audioFixture();
        await Promise.resolve();
        f.activate();
        const player = f.players[0];
        player.handlers.get("ready")({ device_id: "device" });
        await new Promise(resolve => setImmediate(resolve));
        player.handlers.get(event)(event === "autoplay_failed" ? undefined : { message: "Invalid token scopes private-sensitive-data" });
        assert.ok(f.text().includes(expected), event);
        assert.ok(!f.text().includes("private-sensitive-data"));
        assert.equal(player.disconnected, fatal);
        if (fatal) assert.ok(!f.text().includes("Lecteur prêt"));
        // A queued event from a disconnected player must not overwrite the diagnosis.
        if (fatal) player.handlers.get("account_error")({});
        assert.ok(f.text().includes(expected));
        f.cleanup();
    }
});

test("lobby readiness waits for confirmation, blocks start and ignores older statuses after reconnect or rematch", () => {
    const f = lobbyFixture();
    const start = () => f.find(node => node.type === "StartButton");
    const initial = { ...f.snapshot(null), players: [{ id: "host", nickname: "Host", ready: false, readyRevision: 0 }, { id: "guest", nickname: "Guest", ready: false, readyRevision: 0 }] };
    f.receive("game_joined", initial);
    f.find(node => node.type === "HostAudio").props.onReadyChange(true);
    assert.equal(start().props.disabled, true);
    const ready = f.button("Je suis prêt");
    ready.props.onClick();
    ready.props.onClick();
    assert.equal(f.emitted.filter(item => item.name === "set_ready").length, 1);
    assert.equal(f.emitted.at(-1).payload.playerId, "host");
    assert.equal(f.emitted.at(-1).payload.ready, true);
    assert.equal(f.button("Enregistrement").props.disabled, true);
    const ownerReady = { round: 0, player: { ...initial.players[0], ready: true, readyRevision: 1 } };
    f.receive("player_ready", ownerReady);
    assert.ok(f.button("Je ne suis plus prêt"));
    assert.equal(start().props.disabled, true);
    f.receive("player_ready", { round: 0, player: { ...initial.players[1], ready: true, readyRevision: 1 } });
    assert.equal(start().props.disabled, false);
    f.receive("player_ready", { round: 0, player: initial.players[1] });
    f.receive("game_joined", initial);
    assert.equal(start().props.disabled, false, "old status snapshots cannot undo a newer ready update");
    f.receive("player_ready", { round: 0, player: { ...initial.players[1], ready: false, readyRevision: 2 } });
    assert.equal(start().props.disabled, true);
    start().props.onStart();
    assert.equal(f.emitted.filter(item => item.name === "start_game").length, 0);
    const reset = { ...initial, game: { ...initial.game, round: 1 }, players: initial.players.map(player => ({ ...player, readyRevision: 3 })) };
    f.receive("game_reset", reset);
    f.receive("player_ready", ownerReady);
    assert.ok(f.button("Je suis prêt"));
    f.cleanup();
    const guest = lobbyFixture(false);
    guest.receive("game_joined", initial);
    guest.button("Je suis prêt").props.onClick();
    assert.equal(guest.emitted.at(-1).payload.playerId, "guest");
    assert.equal(guest.find(node => node.type === "StartButton"), undefined);
    guest.receive("ready_error", { error: "Temporarily unavailable", round: 0 });
    assert.equal(guest.emitted.at(-1).name, "join_game");
    guest.cleanup();
});

test("lobby enables host commands only after admission, blocks double clicks and recovers from catalog errors", () => {
    const f = lobbyFixture();
    const start = () => f.find(node => node.type === "StartButton");
    assert.equal(start().props.disabled, true);
    f.receive("game_joined", f.snapshot(null));
    assert.equal(start().props.disabled, true, "socket admission alone must not allow start");
    f.find(node => node.type === "HostAudio").props.onReadyChange(true);
    assert.equal(start().props.disabled, false);
    f.find(node => node.type === "HostAudio").props.onReadyChange(false);
    assert.equal(start().props.disabled, true);
    start().props.onStart();
    assert.equal(f.emitted.filter(item => item.name === "start_game").length, 0);
    f.find(node => node.type === "HostAudio").props.onReadyChange(true);
    start().props.onStart();
    start().props.onStart();
    assert.equal(f.emitted.filter(item => item.name === "start_game").length, 1);
    assert.equal(start().props.pending, true);
    f.receive("start_game_error", { error: "Catalogue insuffisant" });
    assert.ok(f.text().includes("Catalogue insuffisant"));
    assert.equal(start().props.pending, false);
    assert.equal(start().props.disabled, false);
    f.cleanup();
});

test("lobby picker waits for server confirmation and ignores obsolete playlist snapshots", () => {
    const f = lobbyFixture();
    const picker = () => f.find(node => node.type === "PlaylistPicker");
    picker().props.onSelect("playlistA");
    assert.equal(f.emitted.filter(event => event.name === "select_playlist").length, 0);
    f.receive("game_joined", f.snapshot(null));
    picker().props.onSelect("playlistA");
    picker().props.onSelect("playlistB");
    assert.equal(f.emitted.filter(event => event.name === "select_playlist").length, 1);
    assert.equal(picker().props.pending, true);
    const updated = { game: { status: "lobby", playlist: { id: "playlistA", name: "Room choice", url: "https://open.spotify.com/playlist/playlistA" }, playlistRevision: 2 } };
    f.receive("playlist_updated", updated);
    assert.equal(picker().props.pending, false);
    assert.equal(picker().props.selectedPlaylist.id, "playlistA");
    f.receive("game_joined", f.snapshot(null));
    assert.equal(picker().props.selectedPlaylist.id, "playlistA");
    assert.ok(f.text().includes("Room choice"));
    f.receive("game_started", f.snapshot(question(1)));
    assert.equal(picker(), undefined);
    f.receive("playlist_updated", { game: { ...updated.game, playlistRevision: 3, playlist: { ...updated.game.playlist, name: "Too late" } } });
    assert.ok(!f.text().includes("Too late"));
    f.cleanup();
    const guest = lobbyFixture(false);
    guest.receive("game_joined", guest.snapshot(null));
    assert.equal(guest.find(node => node.type === "PlaylistPicker"), undefined);
    guest.receive("playlist_updated", updated);
    assert.ok(guest.text().includes("Room choice"));
    guest.cleanup();
});

test("host UI progresses to finish and ignores snapshots or events older than the current question", () => {
    const f = lobbyFixture();
    f.receive("game_joined", f.snapshot(null));
    f.receive("game_started", f.snapshot(question(1)));
    assert.ok(f.text().includes("Question 1 sur 2"));
    assert.ok(!f.text().includes("Answer"));
    const reveal = f.button("Clore la manche");
    reveal.props.onClick();
    reveal.props.onClick();
    assert.equal(f.emitted.filter(item => item.name === "reveal_answer").length, 1);
    assert.equal(f.emitted.at(-1).payload.questionNumber, 1);
    f.receive("game_updated", f.snapshot(result(1)));
    assert.ok(f.text().includes("Answer 1"));
    f.button("Question suivante").props.onClick();
    f.receive("game_updated", f.snapshot(question(2)));
    f.receive("game_joined", f.snapshot(question(1)));
    f.receive("game_updated", f.snapshot(result(1)));
    assert.ok(f.text().includes("Question 2 sur 2"));
    assert.ok(!f.text().includes("Answer 1"));
    f.receive("game_updated", f.snapshot(result(2)));
    f.button("Terminer").props.onClick();
    assert.equal(f.emitted.at(-1).name, "next_question");
    assert.equal(f.emitted.at(-1).payload.questionNumber, 2);
    f.receive("game_updated", f.snapshot({ status: "finished", questionCount: 2 }));
    assert.ok(f.text().includes("Classement final"));
    f.receive("game_updated", f.snapshot(result(2)));
    assert.ok(!f.text().includes("Answer 2"));
    f.cleanup();
});

test("participation updates preserve private answers, ignore delayed counts and reset on the next question or rematch", () => {
    const f = lobbyFixture();
    const progress = { ...question(1), participation: { answered: 0, total: 3 }, question: { ...question(1).question, choices: [{ id: "choice", title: "Title", artist: "Artist" }] } };
    f.receive("game_joined", f.snapshot(progress));
    assert.ok(f.text().includes("0 joueur sur 3 a répondu"));
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "choice", confirmed: true, revision: 1 });
    f.receive("answer_count_updated", { round: 0, questionNumber: 1, answered: 2, total: 3 });
    assert.ok(f.text().includes("2 joueurs sur 3 ont répondu"));
    assert.equal(f.find(node => node.type === "Choices").props.receipt.choiceId, "choice");
    f.receive("answer_count_updated", { round: 0, questionNumber: 1, answered: 1, total: 3 });
    f.receive("game_updated", f.snapshot(progress));
    assert.ok(f.text().includes("2 joueurs sur 3 ont répondu"));
    f.receive("game_updated", f.snapshot({ ...question(2), participation: { answered: 0, total: 3 } }));
    f.receive("answer_count_updated", { round: 0, questionNumber: 1, answered: 3, total: 3 });
    assert.ok(f.text().includes("0 joueur sur 3 a répondu"));
    f.receive("game_updated", f.snapshot(result(2)));
    assert.ok(!f.text().includes("a répondu"));
    const reset = { ...f.snapshot(null), game: { ...f.snapshot(null).game, round: 1 } };
    f.receive("game_reset", reset);
    f.receive("game_started", { ...f.snapshot(progress), game: { ...reset.game, status: "question" } });
    f.receive("answer_count_updated", { round: 0, questionNumber: 1, answered: 3, total: 3 });
    assert.ok(f.text().includes("0 joueur sur 3 a répondu"));
    f.cleanup();
});

test("hidden-result UI keeps corrections and points for the final review", () => {
    const f = lobbyFixture();
    f.receive("game_joined", f.snapshot(question(1)));
    f.receive("game_updated", f.snapshot({ status: "result", question: question(1).question, endsAt: 20000 }));
    assert.ok(f.text().includes("Manche terminée"));
    assert.ok(!f.text().includes("Bonne réponse"));
    assert.equal(f.find(node => node.type === "Choices"), undefined);
    f.receive("game_updated", f.snapshot({ status: "finished", questionCount: 2, review: [{ question: question(1).question, answer: { title: "Final secret", artist: "Artist" }, results: [{ playerId: "host", correct: true, points: 17 }] }] }));
    const review = f.find(node => node.type === "PersonalReview");
    assert.equal(review.props.review[0].answer.title, "Final secret");
    assert.equal(review.props.review[0].results[0].points, 17);
    assert.equal(review.props.playerId, "host");
    f.cleanup();
});

test("rematch UI resets progress, keeps the player and audio, and ignores old-round updates or receipts", () => {
    const f = lobbyFixture();
    f.receive("game_joined", f.snapshot({ status: "finished", questionCount: 2 }));
    const audio = f.find(node => node.type === "HostAudio");
    f.button("Revanche").props.onClick();
    assert.equal(f.emitted.at(-1).name, "rematch_game");
    assert.equal(f.emitted.at(-1).payload.round, 0);
    const reset = { ...f.snapshot(null), game: { ...f.snapshot(null).game, round: 1 } };
    f.receive("game_reset", reset);
    assert.ok(f.text().includes("Dans la salle"));
    assert.equal(f.find(node => node.type === "HostAudio").key, audio.key);
    f.receive("game_updated", f.snapshot({ status: "finished", questionCount: 2 }));
    assert.ok(f.text().includes("Dans la salle"));
    const nextQuestion = { ...question(1), question: { ...question(1).question, choices: [{ id: "new", title: "New", artist: "Artist" }] } };
    f.receive("game_started", { ...f.snapshot(nextQuestion), game: { ...reset.game, status: "question" } });
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "old", round: 0 });
    assert.equal(f.find(node => node.type === "Choices").props.receipt, null);
    f.receive("answer_accepted", { questionNumber: 1, choiceId: "new", round: 1 });
    assert.equal(f.find(node => node.type === "Choices").props.receipt.choiceId, "new");
    f.receive("game_updated", { ...f.snapshot(result(1)), game: { ...reset.game, status: "result" } });
    assert.ok(f.text().includes("Answer 1"));
    f.cleanup();
    const guest = lobbyFixture(false);
    guest.receive("game_joined", guest.snapshot({ status: "finished", questionCount: 2 }));
    assert.equal(guest.button("Revanche"), undefined);
    guest.cleanup();
});

test("guest UI receives public states without host controls and disconnect never replays a command", () => {
    const f = lobbyFixture(false);
    f.receive("game_joined", f.snapshot(question(1)));
    assert.equal(f.button("Révéler"), undefined);
    f.receive("game_updated", f.snapshot(result(1)));
    assert.ok(f.text().includes("Answer 1"));
    assert.equal(f.button("Question suivante"), undefined);
    const before = f.emitted.filter(item => item.name !== "join_game").length;
    f.socket.disconnect();
    f.socket.connect();
    f.receive("game_joined", f.snapshot(result(1)));
    assert.equal(f.emitted.filter(item => item.name !== "join_game").length, before);
    f.cleanup();
});
