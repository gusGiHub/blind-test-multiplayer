import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";

function loadEngine(randomInt = crypto.randomInt) {
    const exported = {};
    const source = fs.readFileSync(new URL("../src/lib/gameEngine.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(compiled, {
        exports: exported,
        require: name => {
            if (name === "server-only") return {};
            if (name === "node:crypto") return { randomInt, randomUUID: crypto.randomUUID };
            if (name === "./gameSettings") {
                const settings = {};
                const source = fs.readFileSync(new URL("../src/lib/gameSettings.ts", import.meta.url), "utf8");
                vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: settings });
                return settings;
            }
            throw Error(`Unexpected import: ${name}`);
        },
    });
    return exported;
}

// Synthetic metadata only: no tracks or audio are added to the application catalog.
const tracks = Array.from({ length: 7 }, (_, index) => Object.freeze({
    id: `fixture-${index}`, title: `Secret title ${index}`, artist: `Secret artist ${index}`, audioPath: `/audio/fixture-${index}.mp3`,
}));
const plain = value => JSON.parse(JSON.stringify(value));

test("speed scoring uses server confirmation time, keeps retries stable and gives no bonus to unconfirmed drafts", () => {
    let clock = 1000;
    const { createGameEngine } = loadEngine(() => 0);
    const settings = { mode: "qcm", excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 0, excerptPosition: "start", scoring: "speed" };
    const engine = createGameEngine(tracks, 2, { automatic: true, now: () => clock, settings });
    const q = engine.getState().question;
    const correct = q.choices.find(choice => choice.title === tracks[0].title).id;
    const wrong = q.choices.find(choice => choice.id !== correct).id;
    clock = q.startsAt;
    engine.submitAnswer("instant", 1, correct, { confirmed: true, revision: 1 });
    engine.submitAnswer("draft", 1, correct, { confirmed: false, revision: 1 });
    clock += 5000;
    engine.submitAnswer("middle", 1, correct, { confirmed: true, revision: 1 });
    engine.submitAnswer("wrong", 1, wrong, { confirmed: true, revision: 1 });
    engine.submitAnswer("instant", 1, correct, { confirmed: true, revision: 1 });
    clock = q.endsAt - 1;
    engine.submitAnswer("late", 1, correct, { confirmed: true, revision: 1 });
    clock = q.endsAt + 5000;
    engine.revealAnswer(1);
    const points = Object.fromEntries(engine.getRoundPoints().map(result => [result.playerId, result.points]));
    assert.deepEqual(plain(points), { instant: 20, draft: 10, middle: 15, wrong: 0, late: 10 });
    assert.throws(() => engine.revealAnswer(1), error => error.code === "INVALID_TRANSITION");
});

test("free answers earn the same speed bonus and classic scoring remains ten points", () => {
    for (const scoring of ["speed", "classic"]) {
        let clock = 0;
        const { createGameEngine } = loadEngine(() => 0);
        const engine = createGameEngine(tracks, 1, { automatic: true, now: () => clock, settings: { mode: "free", excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 0, excerptPosition: "start", scoring } });
        clock = engine.getState().question.startsAt + 2000;
        engine.submitAnswer("player", 1, tracks[0].title.replace("title", "tite"));
        engine.revealAnswer(1);
        assert.equal(engine.getRoundPoints()[0].points, scoring === "speed" ? 18 : 10);
    }
});

test("end-only reveals keep corrections private until finish and return an isolated complete review", () => {
    let clock = 0;
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 2, { automatic: true, now: () => clock, settings: { mode: "free", excerptSeconds: 5, pauseSeconds: 0, excerptPosition: "start", revealMode: "end" } });
    for (let number = 1; number <= 2; number++) {
        clock = engine.getState().question.startsAt;
        engine.submitAnswer("player", number, tracks[number - 1].title);
        const pause = engine.revealAnswer(number);
        assert.equal(pause.answer, undefined);
        assert.equal(pause.review, undefined);
        assert.ok(!JSON.stringify(pause).includes("Secret title"));
        engine.nextQuestion(number);
    }
    const finished = engine.getState();
    assert.equal(finished.review.length, 2);
    assert.equal(finished.review[1].answer.title, tracks[1].title);
    assert.equal(finished.review[0].results[0].points, 10);
    finished.review[0].answer.title = "Changed";
    finished.review[0].results[0].points = 999;
    assert.equal(engine.getState().review[0].answer.title, tracks[0].title);
    assert.equal(engine.getState().review[0].results[0].points, 10);
});

test("private final reviews preserve each response, validation time and score breakdown without changing public views", () => {
    let clock = 0;
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 3, { automatic: true, now: () => clock, settings: { mode: "qcm", excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 0, excerptPosition: "start", revealMode: "end", scoring: "speed" } });
    let firstChoice;
    for (let number = 1; number <= 3; number++) {
        const question = engine.getState().question;
        const correct = question.choices.find(choice => choice.title === tracks[number - 1].title).id;
        clock = question.startsAt + 2000;
        assert.equal(engine.getOwnReview("guest"), null);
        if (number < 3) engine.submitAnswer("guest", number, correct, { confirmed: number === 2, revision: 1 });
        if (number === 1) {
            firstChoice = correct;
            engine.submitAnswer("host", number, question.choices.find(choice => choice.id !== correct).id, { confirmed: true, revision: 1 });
        }
        engine.revealAnswer(number);
        assert.equal(engine.getOwnReview("guest"), null);
        engine.nextQuestion(number);
    }
    const personal = engine.getOwnReview("guest");
    assert.deepEqual(plain(personal[0]), { questionNumber: 1, answered: true, correct: true, choiceId: firstChoice, automatic: true, responseMs: 10000, basePoints: 10, bonusPoints: 0, points: 10 });
    assert.equal(personal[1].responseMs, 2000);
    assert.equal(personal[1].basePoints, 10);
    assert.equal(personal[1].bonusPoints, 8);
    assert.equal(personal[1].points, 18);
    assert.equal(personal[2].answered, false);
    assert.equal(personal[2].responseMs, null);
    assert.equal(personal[2].points, 0);
    assert.equal(engine.getOwnReview("host")[0].correct, false);
    personal[0].choiceId = "changed";
    personal[1].bonusPoints = 999;
    assert.equal(engine.getOwnReview("guest")[0].choiceId, firstChoice);
    assert.equal(engine.getOwnReview("guest")[1].bonusPoints, 8);
    assert.equal(engine.getState().ownReview, undefined);
    assert.ok(engine.getState().review.every(round => round.results.every(result => result.choiceId === undefined && result.text === undefined)));
});

test("latest QCM preselection wins despite out-of-order revisions and is automatically counted at reveal", () => {
    let clock = 1000;
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 4, { automatic: true, now: () => clock });
    const q = engine.getState().question;
    const correct = q.choices.find(choice => choice.title === tracks[0].title).id;
    const wrong = q.choices.find(choice => choice.id !== correct).id;
    clock = q.startsAt;
    engine.submitAnswer("guest", 1, wrong, { confirmed: false, revision: 1 });
    engine.submitAnswer("guest", 1, correct, { confirmed: false, revision: 3 });
    const stale = engine.submitAnswer("guest", 1, wrong, { confirmed: false, revision: 2 });
    assert.deepEqual(plain(stale), { questionNumber: 1, choiceId: correct, confirmed: false, revision: 3 });
    assert.equal(engine.getAnswer("other"), null);
    assert.equal(engine.getRoundPoints().length, 0);
    clock = q.endsAt;
    assert.throws(() => engine.submitAnswer("guest", 1, wrong, { confirmed: false, revision: 4 }), error => error.code === "ANSWER_CLOSED");
    engine.revealAnswer(1);
    assert.equal(engine.getAnswer("guest").confirmed, true);
    assert.equal(engine.getRoundPoints()[0].points, 10);
    assert.equal(engine.getAnswer("absent"), null);
    engine.nextQuestion(1);
    assert.equal(engine.getAnswer("guest"), null);
    assert.throws(() => engine.submitAnswer("guest", 1, correct, { confirmed: true, revision: 5 }), error => error.code === "STALE_QUESTION");
});

test("explicit QCM confirmation locks the choice and rejects malformed draft metadata", () => {
    let clock = 1000;
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 4, { automatic: true, now: () => clock });
    const q = engine.getState().question;
    const [a, b] = q.choices;
    clock = q.startsAt;
    for (const submission of [{ confirmed: false, revision: 0 }, { confirmed: false, revision: 1.5 }, { confirmed: "false", revision: 1 }]) {
        assert.throws(() => engine.submitAnswer("guest", 1, a.id, submission), error => error.code === "INVALID_ANSWER");
    }
    engine.submitAnswer("guest", 1, a.id, { confirmed: false, revision: 1 });
    const receipt = engine.submitAnswer("guest", 1, b.id, { confirmed: true, revision: 2 });
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.choiceId, b.id);
    assert.throws(() => engine.submitAnswer("guest", 1, a.id, { confirmed: false, revision: 3 }), error => error.code === "ALREADY_ANSWERED");
    assert.deepEqual(plain(engine.submitAnswer("guest", 1, b.id, { confirmed: true, revision: 2 })), plain(receipt));
});

test("response deadline stays open after audio stops and rejects submissions at its own boundary", () => {
    let clock = 1000;
    const { createGameEngineFromSpotifyPreview } = loadEngine(() => 0);
    const preview = { questionCount: 1, questions: [{ prompt: "Title?", answer: { title: "My title", artists: ["Artist"] }, track: { id: "song", url: "https://open.spotify.com/track/song", durationMs: 120000 } }] };
    const engine = createGameEngineFromSpotifyPreview(preview, { automatic: true, now: () => clock,
        settings: { mode: "free", excerptSeconds: 5, responseSeconds: 10, pauseSeconds: 2, excerptPosition: "start" } });
    const q = engine.getState().question;
    assert.equal(q.audioEndsAt, q.startsAt + 5000);
    assert.equal(q.endsAt, q.startsAt + 10000);
    assert.equal(engine.getPlayback().endsAt, q.audioEndsAt);
    clock = q.audioEndsAt + 1000;
    assert.equal(engine.getState().status, "question");
    assert.equal(engine.submitAnswer("guest", 1, "MY TITLE").text, "MY TITLE");
    clock = q.endsAt;
    assert.throws(() => engine.submitAnswer("late", 1, "My title"), error => error.code === "ANSWER_CLOSED");
    const result = engine.revealAnswer(1);
    assert.equal(result.endsAt, clock + 2000);
    assert.equal(engine.getRoundPoints()[0].points, 10);
});

test("custom excerpt lengths and positions stay in bounds and control result deadlines", () => {
    const { createGameEngineFromSpotifyPreview } = loadEngine(max => max - 1);
    const preview = { choicePool: tracks.slice(4).map(track => ({ id: track.id, title: track.title, artists: [track.artist] })), questionCount: 4, questions: tracks.slice(0, 4).map((track, index) => ({
        prompt: "Question", answer: { title: track.title, artists: [track.artist] },
        track: { id: `song${index}`, url: `https://open.spotify.com/track/song${index}`, durationMs: 120000 },
    })) };
    for (const [excerptPosition, expected] of [["start", 0], ["middle", 55000], ["random", 110000]]) {
        let clock = 1000;
        const settings = { mode: "qcm", excerptSeconds: 10, pauseSeconds: 2, excerptPosition };
        const engine = createGameEngineFromSpotifyPreview(preview, { automatic: true, settings, now: () => clock });
        const q = engine.getState().question;
        assert.equal(q.endsAt - q.startsAt, 10000);
        assert.equal(engine.getPlayback().offsetMs, expected);
        settings.excerptSeconds = 30; // the engine must retain its own settings copy
        clock = q.endsAt;
        assert.equal(engine.revealAnswer(1).endsAt, clock + 2000);
        const next = engine.nextQuestion(1).question;
        assert.equal(next.endsAt - next.startsAt, 10000);
    }
    const settings = { mode: "free", excerptSeconds: 1, pauseSeconds: 0, excerptPosition: "middle" };
    const engine = createGameEngineFromSpotifyPreview(preview, { automatic: true, settings, now: () => 1000 });
    assert.equal(engine.getPlayback().offsetMs, 59500);
    assert.equal(engine.revealAnswer(1).endsAt, 1000);
});

test("free answers preserve private receipts and locks while accepting a small typo", () => {
    let clock = 1000;
    const { createGameEngine } = loadEngine(() => 0);
    const catalog = [{ ...tracks[0], title: "Été, l’amour !" }];
    const engine = createGameEngine(catalog, 1, { automatic: true, now: () => clock,
        settings: { mode: "free", excerptSeconds: 5, pauseSeconds: 0, excerptPosition: "start" } });
    const q = engine.getState().question;
    assert.equal(q.mode, "free");
    assert.equal(q.choices, undefined);
    assert.ok(!JSON.stringify(q).includes("amour"));
    assert.throws(() => engine.submitAnswer("host", 1, "ete lamour"), error => error.code === "ANSWER_CLOSED");
    clock = q.startsAt;
    for (const value of ["", "---", "a".repeat(201)]) assert.throws(() => engine.submitAnswer("host", 1, value), error => error.code === "INVALID_ANSWER");
    const receipt = engine.submitAnswer("host", 1, "  ETE LAMOUR  ");
    assert.deepEqual(plain(receipt), { questionNumber: 1, text: "ETE LAMOUR" });
    assert.deepEqual(plain(engine.getAnswer("host")), plain(receipt));
    assert.equal(engine.getAnswer("stranger"), null);
    assert.equal(engine.getRoundPoints().length, 0);
    assert.deepEqual(plain(engine.submitAnswer("host", 1, "ETE LAMOUR")), plain(receipt));
    assert.throws(() => engine.submitAnswer("host", 1, "changed"), error => error.code === "ALREADY_ANSWERED");
    engine.submitAnswer("typo", 1, "ete lamor");
    engine.submitAnswer("artist", 1, tracks[0].artist);
    clock = q.endsAt;
    assert.throws(() => engine.submitAnswer("late", 1, "ete lamour"), error => error.code === "ANSWER_CLOSED");
    assert.equal(engine.revealAnswer(1).answer.choiceId, undefined);
    assert.deepEqual(plain(engine.getRoundPoints()).map(value => value.points), [10, 10, 0]);
});

test("free answers normalize metadata and tolerate only small typos according to the title length", () => {
    const { createGameEngine } = loadEngine(() => 0);
    const cases = [
        ["Pornstar Martini (feat. Luidji)", "Pornstar martini", true],
        ["Pornstar Martini (feat. Luidji)", "Pornstar Martini (feat. Luidji)", true],
        ["Pornstar Martini (feat. Luidji)", "Pornstar martni", true],
        ["Pornstar Martini (feat. Luidji)", "Pornsatr martini", true],
        ["Pornstar Martini (feat. Luidji)", "Pornstar", false],
        ["Hello", "Hlelo", false],
        ["Hello", "Helloo", false],
        ["Yellow", "Yelow", true],
        ["Yellow", "Yellwo", true],
        ["Yellow", "Yellox", true],
        ["Yellow", "Yelloow", true],
        ["Yellow", "Yellxx", false],
        ["abcdefghijk", "abxdefghiyk", false],
        ["abcdefghijkl", "abxdefghiykl", true],
        ["abcdefghijkl", "abxdefghiykz", false],
        ["Song 2 (Live)", "Song 3", false],
        ["Part 123456", "Part 123457", false],
        ["Part 123456", "Prat 123456", true],
        ["Été, l’amour (Live)", "ETE LAMOUR", true],
        ["Don't Stop (Radio Edit)", "Dont Stop", true],
        ["Title (feat. Artist) (Live (2024))", "Title", true],
        ["My (Live) Song", "My song", true],
        ["Title - Live", "Title", false],
        ["Title (Live)", "Different title", false],
    ];
    for (const [title, answer, correct] of cases) {
        let now = 1000;
        const engine = createGameEngine([{ ...tracks[0], title }], 1, { automatic: true, now: () => now,
            settings: { mode: "free", excerptSeconds: 5, pauseSeconds: 2, excerptPosition: "start" } });
        now = engine.getState().question.startsAt;
        engine.submitAnswer("guest", 1, answer);
        assert.throws(() => engine.submitAnswer("empty", 1, "(feat. Artist), '"), error => error.code === "INVALID_ANSWER");
        assert.equal(engine.revealAnswer(1).answer.title, title, "displayed title must remain intact");
        assert.equal(engine.getRoundPoints()[0].correct, correct, `${title}: ${answer}`);
        assert.equal(engine.getRoundPoints()[0].points, correct ? 10 : 0);
    }
});

test("a valid different known title is never accepted as a typo of the current song", () => {
    let clock = 0;
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine([{ ...tracks[0], title: "Yellow" }, { ...tracks[1], title: "Mellow" }], 1, { automatic: true, now: () => clock,
        settings: { mode: "free", excerptSeconds: 5, pauseSeconds: 0, excerptPosition: "start" } });
    clock = engine.getState().question.startsAt;
    engine.submitAnswer("wrong-title", 1, "Mellow");
    engine.submitAnswer("typo", 1, "Yelow");
    engine.revealAnswer(1);
    assert.deepEqual(plain(engine.getRoundPoints()).map(result => result.points), [0, 10]);
});

test("automatic QCM enforces deadlines, private immutable votes and ten-point scoring", () => {
    let clock = 1000;
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 4, { automatic: true, now: () => clock });
    const question = engine.getState().question;
    assert.equal(question.startsAt, 2500);
    assert.equal(question.endsAt, 32500);
    assert.equal(question.choices.length, 4);
    assert.equal(new Set(question.choices.map(choice => choice.id)).size, 4);
    assert.equal(engine.getState().answer, undefined);
    const correct = question.choices.find(choice => choice.title === tracks[0].title);
    const wrong = question.choices.find(choice => choice.id !== correct.id);
    assert.throws(() => engine.submitAnswer("host", 1, correct.id), error => error.code === "ANSWER_CLOSED");
    clock = question.startsAt;
    assert.throws(() => engine.submitAnswer("host", 1, "invented"), error => error.code === "INVALID_ANSWER");
    const receipt = engine.submitAnswer("host", 1, correct.id);
    assert.deepEqual(plain(receipt), { questionNumber: 1, choiceId: correct.id });
    assert.deepEqual(plain(engine.submitAnswer("host", 1, correct.id)), plain(receipt));
    assert.throws(() => engine.submitAnswer("host", 1, wrong.id), error => error.code === "ALREADY_ANSWERED");
    engine.submitAnswer("guest", 1, wrong.id);
    assert.equal(engine.getAnswer("other"), null);
    assert.equal(engine.getRoundPoints().length, 0);
    question.choices[0].title = "tampered";
    assert.ok(engine.getState().question.choices.every(choice => choice.title !== "tampered"));
    clock = question.endsAt;
    assert.throws(() => engine.submitAnswer("late", 1, correct.id), error => error.code === "ANSWER_CLOSED");
    const result = engine.revealAnswer(1);
    assert.equal(result.endsAt, clock + 5000);
    assert.equal(result.answer.choiceId, correct.id);
    assert.deepEqual(plain(engine.getRoundPoints()), [
        { playerId: "host", correct: true, points: 10 },
        { playerId: "guest", correct: false, points: 0 },
    ]);
    assert.throws(() => engine.revealAnswer(1), error => error.code === "INVALID_TRANSITION");
    engine.nextQuestion(1);
    assert.equal(engine.getAnswer("host"), null);
    assert.throws(() => engine.submitAnswer("host", 1, correct.id), error => error.code === "STALE_QUESTION");
});

test("Spotify excerpts stay within the track and playback metadata remains private", () => {
    const { createGameEngineFromSpotifyPreview } = loadEngine(max => max - 1);
    const preview = { choicePool: tracks.slice(4).map(track => ({ id: track.id, title: track.title, artists: [track.artist] })), questionCount: 4, questions: tracks.slice(0, 4).map((track, index) => ({
        prompt: "Quel morceau ?", answer: { title: track.title, artists: [track.artist] },
        track: { id: `spotify${index}`, url: `https://open.spotify.com/track/spotify${index}`, durationMs: 120000 },
    })) };
    const engine = createGameEngineFromSpotifyPreview(preview, { automatic: true, now: () => 1000 });
    assert.equal(engine.getPlayback().offsetMs, 90000);
    assert.equal(engine.getPlayback().trackId, "spotify0");
    assert.ok(!JSON.stringify(engine.getState()).includes("spotify0"));
    engine.revealAnswer(1);
    assert.equal(engine.getPlayback(), null);
    assert.throws(() => createGameEngineFromSpotifyPreview({ ...preview, choicePool: [] }, { automatic: true }), error => error.code === "INSUFFICIENT_CHOICES");
});

test("QCM prefers other songs by the same artist and never uses past or future game tracks as decoys", () => {
    const { createGameEngineFromSpotifyPreview } = loadEngine(() => 0);
    const questions = ["Alpha", "Beta"].map((title, i) => ({ prompt: "Title?", answer: { title, artists: [`Artist ${i}`] }, track: { id: `song${i}`, url: `https://open.spotify.com/track/song${i}`, durationMs: 120000 } }));
    const choicePool = [
        ...questions.map(question => ({ id: question.track.id, title: question.answer.title, artists: question.answer.artists })),
        { id: "remaster", title: "Alpha (Remastered)", artists: ["Artist 0"] },
        ...[0, 1].flatMap(artist => [0, 1, 2].map(n => ({ id: `external${artist}${n}`, title: `Other song ${artist}-${n}`, artists: [`Artist ${artist}`] }))),
        { id: "unrelated", title: "Unrelated song", artists: ["Someone else"] },
    ];
    const engine = createGameEngineFromSpotifyPreview({ questionCount: 2, questions, choicePool }, { automatic: true });
    for (let i = 0; i < 2; i++) {
        const state = engine.getState();
        assert.equal(state.question.choices.length, 4);
        assert.equal(new Set(state.question.choices.map(choice => choice.title)).size, 4);
        assert.ok(state.question.choices.every(choice => choice.artist === `Artist ${i}`));
        assert.ok(state.question.choices.every(choice => choice.title === questions[i].answer.title || choice.title.startsWith(`Other song ${i}-`)));
        assert.ok(!JSON.stringify(state).includes("external"), "source track IDs must remain private");
        if (i === 0) choicePool.forEach(track => { track.title = "Mutated after start"; track.artists[0] = "Mutated artist"; });
        engine.revealAnswer(i + 1);
        engine.nextQuestion(i + 1);
    }
});

test("QCM falls back to other artists while keeping three distinct non-game titles", () => {
    const { createGameEngineFromSpotifyPreview } = loadEngine(() => 0);
    const questions = [{ answer: { title: "Answer", artists: ["Main artist"] }, track: { id: "answer", url: "https://open.spotify.com/track/answer", durationMs: 120000 } }];
    const choicePool = [
        { id: "cover", title: "Answer (Live)", artists: ["Someone"] },
        { id: "one", title: "One", artists: ["Other"] },
        { id: "duplicate", title: "One (Remastered)", artists: ["Other"] },
        { id: "two", title: "Two", artists: ["Other"] },
        { id: "three", title: "Three", artists: ["Other"] },
    ];
    const engine = createGameEngineFromSpotifyPreview({ questionCount: 1, questions, choicePool }, { automatic: true });
    const titles = engine.getState().question.choices.map(choice => choice.title);
    assert.equal(titles.length, 4);
    assert.ok(titles.includes("Answer"));
    assert.equal(titles.filter(title => title.startsWith("One")).length, 1);
    assert.ok(!titles.includes("Answer (Live)"));
    assert.throws(() => createGameEngineFromSpotifyPreview({ questionCount: 1, questions, choicePool: choicePool.slice(0, 4) }, { automatic: true }), error => error.code === "INSUFFICIENT_CHOICES");
});

test("automatic scheduler progresses without a socket and cancels obsolete timers", async () => {
    const exported = {};
    const tasks = new Map();
    let nextId = 0;
    const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/server/gameScheduler.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(compiled, { exports: exported, Date, Map,
        setTimeout: (callback, delay) => { const id = ++nextId; tasks.set(id, { callback, delay }); return id; },
        clearTimeout: id => tasks.delete(id),
    });
    const update = progress => ({ game: { code: "ABC" }, progress });
    const question = update({ status: "question", question: { number: 1, endsAt: 31000 } });
    const result = update({ status: "result", question: { number: 1 }, endsAt: 36000 });
    const finished = update({ status: "finished" });
    const commands = [], published = [];
    const scheduler = exported.createGameScheduler({ now: () => 1000,
        execute: async (...args) => { commands.push(args); return args[1] === "reveal" ? result : finished; },
        publish: (...args) => published.push(args), failed: () => assert.fail("unexpected failure"),
    });
    scheduler.schedule(question, "host", "private-cookie");
    assert.equal([...tasks.values()][0].delay, 30000);
    scheduler.schedule(question, "host", "private-cookie");
    assert.equal(tasks.size, 1);
    const fire = async () => { const [id, task] = [...tasks][0]; tasks.delete(id); task.callback(); await new Promise(resolve => setImmediate(resolve)); };
    await fire();
    assert.equal(commands[0][1], "reveal");
    assert.equal(published[0][1].progress.status, "result");
    await fire();
    assert.equal(commands[1][1], "next");
    assert.equal(tasks.size, 0);
    scheduler.schedule(update({ status: "result", question: { number: 1 }, endsAt: 1000 }), "host", "private-cookie");
    assert.equal([...tasks.values()][0].delay, 0, "zero pause must schedule the next question immediately");
    scheduler.schedule(question, "host", "private-cookie");
    scheduler.dispose();
    assert.equal(tasks.size, 0);
});

test("selection has the requested length, no duplicates and does not mutate the catalog", () => {
    const before = JSON.stringify(tracks);
    const draws = [5, 0, 2, 0];
    const { createGameEngine } = loadEngine(max => {
        const draw = draws.shift();
        assert.ok(draw >= 0 && draw < max);
        return draw;
    });
    const engine = createGameEngine(Object.freeze([...tracks]), 4);
    const paths = [];
    for (let n = 1; n <= 4; n++) {
        const state = engine.getState();
        assert.equal(state.status, "question");
        assert.equal(state.question.number, n);
        assert.equal(state.question.total, 4);
        paths.push(state.question.audioPath);
        engine.revealAnswer(n);
        engine.nextQuestion(n);
    }
    assert.equal(new Set(paths).size, 4);
    assert.equal(paths[0], tracks[5].audioPath);
    assert.equal(JSON.stringify(tracks), before);
    assert.equal(engine.getState().status, "finished");
});

test("public states reveal only the current answer and never the future answers", () => {
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 2);
    assert.deepEqual(plain(engine.getState()), { status: "question", question: { number: 1, total: 2, audioPath: tracks[0].audioPath } });
    assert.ok(!JSON.stringify(engine.getState()).includes("Secret"));
    assert.deepEqual(plain(engine.revealAnswer(1)).answer, { title: tracks[0].title, artist: tracks[0].artist });
    assert.ok(!JSON.stringify(engine.getState()).includes(tracks[1].title));
    engine.nextQuestion(1);
    assert.ok(!JSON.stringify(engine.getState()).includes("Secret"));
});

test("full progression includes a result for the last question before finishing", () => {
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 1);
    assert.equal(engine.revealAnswer(1).status, "result");
    const finished = engine.nextQuestion(1);
    assert.equal(finished.status, "finished");
    assert.equal(finished.questionCount, 1);
    assert.equal(finished.review.length, 1);
    assert.deepEqual(plain(finished.review[0].answer), { title: tracks[0].title, artist: tracks[0].artist });
    assert.throws(() => engine.nextQuestion(1), error => error.code === "INVALID_TRANSITION");
    assert.throws(() => engine.revealAnswer(1), error => error.code === "INVALID_TRANSITION");
});

test("invalid, empty, duplicate and insufficient catalogs fail before random selection", () => {
    const { createGameEngine } = loadEngine(() => { throw Error("Should not draw"); });
    for (const count of [0, -1, 1.5, NaN, Infinity]) {
        assert.throws(() => createGameEngine(tracks, count), error => error.code === "INVALID_QUESTION_COUNT");
    }
    assert.throws(() => createGameEngine([], 1), error => error.code === "INSUFFICIENT_TRACKS");
    assert.throws(() => createGameEngine(tracks, tracks.length + 1), error => error.code === "INSUFFICIENT_TRACKS");
    assert.throws(() => createGameEngine([tracks[0], tracks[0]], 1), error => error.code === "DUPLICATE_TRACK_ID");
    assert.throws(() => createGameEngine([{ ...tracks[0], title: " " }], 1), error => error.code === "INVALID_CATALOG");
    assert.throws(() => createGameEngine([{ ...tracks[0], audioPath: "https://example.com/song.mp3" }], 1), error => error.code === "INVALID_CATALOG");
});

test("premature, duplicate or stale commands do not change state", () => {
    const { createGameEngine } = loadEngine(() => 0);
    const engine = createGameEngine(tracks, 2);
    const initial = JSON.stringify(engine.getState());
    assert.throws(() => engine.nextQuestion(1), error => error.code === "INVALID_TRANSITION");
    assert.throws(() => engine.revealAnswer(2), error => error.code === "STALE_QUESTION");
    assert.equal(JSON.stringify(engine.getState()), initial);
    engine.revealAnswer(1);
    assert.throws(() => engine.revealAnswer(1), error => error.code === "INVALID_TRANSITION");
    engine.nextQuestion(1);
    const second = JSON.stringify(engine.getState());
    assert.throws(() => engine.nextQuestion(1), error => error.code === "STALE_QUESTION");
    assert.throws(() => engine.revealAnswer(1), error => error.code === "STALE_QUESTION");
    assert.equal(JSON.stringify(engine.getState()), second);
});

test("external mutations and independent engines cannot change each other's state", () => {
    const { createGameEngine } = loadEngine(() => 0);
    const catalog = tracks.map(track => ({ ...track }));
    const first = createGameEngine(catalog, 2);
    const second = createGameEngine(catalog, 2);
    catalog[0].title = "Altered";
    const publicState = first.getState();
    publicState.question.number = 99;
    first.revealAnswer(1);
    assert.equal(first.getState().answer.title, tracks[0].title);
    const result = first.getState();
    result.answer.title = "Injected";
    assert.equal(first.getState().answer.title, tracks[0].title);
    assert.equal(second.getState().status, "question");
    assert.equal(second.getState().question.number, 1);
});
