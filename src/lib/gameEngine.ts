import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import type { MusicTrack } from "@/src/types/music";
import type { SpotifyQuestionPreview } from "@/src/types/spotify";
import type { GameProgress, PublicQuestion, ReviewedRound, PersonalRoundReview } from "@/src/types/gameProgress";
import type { AnswerChoice, AnswerReceipt, PlayerAnswer, AnswerSubmission } from "@/src/types/gameplay";
import { normalizeTitle, matchesTitleAnswer, parseGameSettings, type GameSettings } from "./gameSettings";

type ErrorCode = "INVALID_QUESTION_COUNT" | "INVALID_CATALOG" | "DUPLICATE_TRACK_ID" | "INSUFFICIENT_TRACKS" | "INSUFFICIENT_CHOICES" | "INVALID_TRANSITION" | "STALE_QUESTION" | "INVALID_ANSWER" | "ANSWER_CLOSED" | "ALREADY_ANSWERED";
export class GameEngineError extends Error {
    constructor(public readonly code: ErrorCode, message: string) { super(message); }
}
export interface GameEngineOptions { automatic?: boolean; now?: () => number; settings?: GameSettings; }
export interface GameEngine {
    exportSnapshot(): EngineSnapshot;
    getState(): GameProgress;
    revealAnswer(questionNumber: number): GameProgress;
    nextQuestion(questionNumber: number): GameProgress;
    submitAnswer(playerId: string, questionNumber: number, choiceId: string, submission?: AnswerSubmission): AnswerReceipt;
    getAnswer(playerId: string): AnswerReceipt | null;
    getOwnReview(playerId: string): PersonalRoundReview[] | null;
    getRoundPoints(): { playerId: string; correct: boolean; points: number }[];
    getPlayback(): { trackId: string; offsetMs: number; startsAt: number; endsAt: number } | null;
}
interface EngineTrack { id: string; title: string; artist: string; artists?: string[]; audioPath?: `/audio/${string}`; prompt?: string; spotifyUrl?: string; durationMs?: number; }
/** Private persistence format. Never return this object from an API. */
export interface EngineSnapshot {
    version: 1; selected: EngineTrack[]; choicePool: EngineTrack[]; automatic: boolean; settings: GameSettings;
    index: number; status: GameProgress["status"]; startsAt: number; endsAt: number; audioEndsAt: number;
    resultEndsAt: number; offsetMs: number; choices: AnswerChoice[]; correctChoiceId: string;
    answers: [string, PlayerAnswer][]; review: ReviewedRound[];
    privateReview: [string, PlayerAnswer & { automatic: boolean } ][][];
}
export function restoreGameEngine(snapshot: EngineSnapshot, now?: () => number): GameEngine {
    if (snapshot.version !== 1) throw new Error("Unsupported engine snapshot");
    return createSelectedEngine(snapshot.selected, { automatic: snapshot.automatic, settings: snapshot.settings, now }, snapshot.choicePool, snapshot);
}

function shuffled<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
export function createGameEngine(catalog: readonly MusicTrack[], questionCount: number, options: GameEngineOptions = {}): GameEngine {
    if (!Number.isSafeInteger(questionCount) || questionCount <= 0) throw new GameEngineError("INVALID_QUESTION_COUNT", "Le nombre de questions doit être un entier positif.");
    const ids = new Set<string>();
    for (const track of catalog) {
        if (!track.id.trim() || !track.title.trim() || !track.artist.trim() || !track.audioPath.startsWith("/audio/")) throw new GameEngineError("INVALID_CATALOG", "Un morceau du catalogue est incomplet ou son chemin audio est invalide.");
        if (ids.has(track.id)) throw new GameEngineError("DUPLICATE_TRACK_ID", "Chaque morceau du catalogue doit avoir un identifiant unique.");
        ids.add(track.id);
    }
    if (catalog.length < questionCount) throw new GameEngineError("INSUFFICIENT_TRACKS", `Le catalogue contient ${catalog.length} morceau(x), mais ${questionCount} questions sont demandées.`);
    const pool = [...catalog];
    const selected: EngineTrack[] = [];
    for (let i = 0; i < questionCount; i++) {
        const j = i + randomInt(pool.length - i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
        selected.push({ ...pool[i] });
    }
    return createSelectedEngine(selected, options, catalog);
}
export function createGameEngineFromSpotifyPreview(preview: SpotifyQuestionPreview, options: GameEngineOptions = {}): GameEngine {
    if (!Number.isSafeInteger(preview.questionCount) || preview.questionCount <= 0 || preview.questions.length !== preview.questionCount) throw new GameEngineError("INVALID_CATALOG", "Les questions préparées ne correspondent pas au nombre demandé.");
    const ids = new Set<string>();
    const selected: EngineTrack[] = preview.questions.map(question => {
        const artists = question.answer.artists.map(artist => artist.trim()).filter(Boolean);
        if (!/^[a-zA-Z0-9]+$/.test(question.track.id) || !question.answer.title.trim() || !artists.length || question.track.url !== `https://open.spotify.com/track/${question.track.id}`) throw new GameEngineError("INVALID_CATALOG", "Un morceau préparé est incomplet.");
        if (ids.has(question.track.id)) throw new GameEngineError("DUPLICATE_TRACK_ID", "Les questions préparées contiennent un morceau en double.");
        ids.add(question.track.id);
        if (options.automatic && (!Number.isFinite(question.track.durationMs) || question.track.durationMs! < (options.settings?.excerptSeconds ?? 30) * 1000)) throw new GameEngineError("INVALID_CATALOG", "La durée d’un morceau est absente ou trop courte. Régénère les questions depuis ta playlist.");
        return { id: question.track.id, title: question.answer.title, artist: artists.join(", "), artists, prompt: question.prompt, spotifyUrl: question.track.url, durationMs: question.track.durationMs };
    });
    const pool: EngineTrack[] = (preview.choicePool ?? []).map(track => ({ id: track.id, title: track.title, artist: track.artists.join(", "), artists: [...track.artists] }));
    return createSelectedEngine(selected, options, pool);
}
function createSelectedEngine(selected: readonly EngineTrack[], options: GameEngineOptions, choicePool: readonly EngineTrack[], snapshot?: EngineSnapshot): GameEngine {
    const automatic = Boolean(options.automatic);
    const settings = parseGameSettings(options.settings);
    if (!settings) throw new GameEngineError("INVALID_CATALOG", "Les paramètres de partie sont invalides.");
    const now = options.now ?? Date.now;
    const label = (track: EngineTrack) => normalizeTitle(track.title);
    const playedTitles = new Set(selected.map(label));
    const knownTitles = new Set([...selected, ...choicePool].map(label));
    // Keep future questions out of the decoys too: every round retains three plausible choices.
    const reserve = choicePool.filter(track => track.id && track.title.trim() && track.artist.trim() && label(track) && !playedTitles.has(label(track)))
        .map(track => ({ ...track, artists: [...(track.artists ?? [track.artist])] }));
    if (automatic && settings.mode === "qcm" && new Set(reserve.map(label)).size < 3) throw new GameEngineError("INSUFFICIENT_CHOICES", "Impossible de préparer trois fausses réponses distinctes hors des morceaux tirés. Choisis une playlist plus grande, moins de questions ou réessaie si la recherche Spotify est indisponible.");
    let index = 0;
    let status: GameProgress["status"] = "question";
    let startsAt = 0;
    let endsAt = 0;
    let audioEndsAt = 0;
    let resultEndsAt = 0;
    let offsetMs = 0;
    let choices: AnswerChoice[] = [];
    let correctChoiceId = "";
    const answers = new Map<string, PlayerAnswer>();
    const review: ReviewedRound[] = [];
    const privateReview: Map<string, PlayerAnswer & { automatic: boolean }>[] = [];
    const prepare = () => {
        answers.clear();
        if (!automatic) return;
        startsAt = now() + 1500;
        audioEndsAt = startsAt + settings.excerptSeconds * 1000;
        endsAt = startsAt + (settings.responseSeconds ?? settings.excerptSeconds) * 1000;
        const track = selected[index];
        const maxOffset = Math.max(0, Math.floor(track.durationMs ?? 0) - settings.excerptSeconds * 1000);
        offsetMs = settings.excerptPosition === "start" ? 0 : settings.excerptPosition === "middle" ? Math.floor(maxOffset / 2) : randomInt(maxOffset + 1);
        if (settings.mode === "free") return;
        const artists = new Set((track.artists ?? [track.artist]).map(name => name.trim().toLocaleLowerCase()));
        const sameArtist = (other: EngineTrack) => (other.artists ?? [other.artist]).some(name => artists.has(name.trim().toLocaleLowerCase()));
        const ranked = [...shuffled(reserve.filter(sameArtist)), ...shuffled(reserve.filter(other => !sameArtist(other)))];
        const unique = new Map<string, EngineTrack>();
        for (const candidate of ranked) if (!unique.has(label(candidate))) unique.set(label(candidate), candidate);
        const candidates = shuffled([track, ...Array.from(unique.values()).slice(0, 3)]);
        choices = candidates.map(candidate => {
            const id = randomUUID();
            if (candidate === track) correctChoiceId = id;
            return { id, title: candidate.title, artist: candidate.artist };
        });
    };
    if (snapshot) {
        ({ index, status, startsAt, endsAt, audioEndsAt, resultEndsAt, offsetMs, choices, correctChoiceId } = snapshot);
        for (const [id, answer] of snapshot.answers) answers.set(id, { ...answer });
        review.push(...snapshot.review);
        privateReview.push(...snapshot.privateReview.map(round => new Map(round)));
    } else prepare();
    const getQuestion = (): PublicQuestion => ({
        number: index + 1, total: selected.length,
        ...(selected[index].audioPath ? { audioPath: selected[index].audioPath } : {}),
        ...(selected[index].prompt ? { prompt: automatic && settings.mode === "free" ? "Quel est le titre de ce morceau ?" : selected[index].prompt } : {}),
        ...(automatic ? { mode: settings.mode, ...(settings.mode === "qcm" ? { choices: choices.map(choice => ({ ...choice })) } : {}), startsAt, endsAt, audioEndsAt } : {}),
    });
    const getState = (): GameProgress => {
        if (status === "finished") return { status, questionCount: selected.length, review: review.map(round => ({ question: { ...round.question, ...(round.question.choices ? { choices: round.question.choices.map(choice => ({ ...choice })) } : {}) }, answer: { ...round.answer }, results: round.results.map(result => ({ ...result })) })) };
        if (status === "result") {
            const track = selected[index];
            return { status, question: getQuestion(), ...(settings.revealMode === "end" ? {} : { answer: { title: track.title, artist: track.artist, ...(track.spotifyUrl ? { spotifyUrl: track.spotifyUrl } : {}), ...(automatic && settings.mode === "qcm" ? { choiceId: correctChoiceId } : {}) } }), ...(automatic ? { endsAt: resultEndsAt } : {}) };
        }
        return { status, question: getQuestion() };
    };
    const assertQuestion = (number: number) => {
        if (number !== index + 1) throw new GameEngineError("STALE_QUESTION", "Cette commande concerne une autre question. Actualise l’état de la partie.");
    };
    const receipt = (answer: PlayerAnswer): AnswerReceipt => ({ questionNumber: index + 1,
        ...(answer.choiceId !== undefined ? { choiceId: answer.choiceId } : { text: answer.text }),
        ...(answer.confirmed !== undefined ? { confirmed: answer.confirmed, revision: answer.revision } : {}) });
    const roundPoints = () => Array.from(answers, ([playerId, answer]) => {
        const normalizedAnswer = normalizeTitle(answer.text ?? "");
        const correct = settings.mode === "qcm" ? answer.choiceId === correctChoiceId
            : normalizedAnswer === label(selected[index]) || (!knownTitles.has(normalizedAnswer) && matchesTitleAnswer(answer.text ?? "", selected[index].title));
        const remaining = automatic ? Math.max(0, Math.min(1, (endsAt - answer.submittedAt) / (endsAt - startsAt))) : 0;
        const bonus = settings.scoring === "speed" ? Math.floor(10 * remaining) : 0;
        return { playerId, correct, points: correct ? 10 + bonus : 0 };
    });
    return {
        exportSnapshot: () => ({ version: 1, selected: selected.map(track => ({ ...track })), choicePool: choicePool.map(track => ({ ...track })), automatic, settings,
            index, status, startsAt, endsAt, audioEndsAt, resultEndsAt, offsetMs, choices, correctChoiceId,
            answers: Array.from(answers), review, privateReview: privateReview.map(round => Array.from(round)) }),
        getState,
        revealAnswer(number) {
            assertQuestion(number);
            if (status !== "question") throw new GameEngineError("INVALID_TRANSITION", "La réponse peut être révélée uniquement pendant une question.");
            status = "result";
            privateReview.push(new Map(Array.from(answers, ([playerId, answer]) => [playerId, { ...answer, automatic: answer.confirmed === false }])));
            for (const answer of answers.values()) if (answer.confirmed === false) {
                answer.confirmed = true;
                // Automatic confirmation cannot earn the bonus of an earlier draft.
                answer.submittedAt = endsAt;
            }
            const track = selected[index];
            review.push({ question: getQuestion(), answer: { title: track.title, artist: track.artist, ...(track.spotifyUrl ? { spotifyUrl: track.spotifyUrl } : {}), ...(automatic && settings.mode === "qcm" ? { choiceId: correctChoiceId } : {}) }, results: roundPoints() });
            resultEndsAt = now() + settings.pauseSeconds * 1000;
            return getState();
        },
        nextQuestion(number) {
            assertQuestion(number);
            if (status !== "result") throw new GameEngineError("INVALID_TRANSITION", "Affiche le résultat avant de passer à la suite.");
            if (index + 1 === selected.length) status = "finished";
            else { index++; status = "question"; prepare(); }
            return getState();
        },
        submitAnswer(playerId, number, choiceId, submission) {
            assertQuestion(number);
            if (!automatic || status !== "question" || now() < startsAt || now() >= endsAt) throw new GameEngineError("ANSWER_CLOSED", "Les réponses sont fermées pour cette question.");
            if (typeof choiceId !== "string" || (settings.mode === "qcm" ? !choices.some(choice => choice.id === choiceId) : choiceId.trim().length > 200 || !normalizeTitle(choiceId))) throw new GameEngineError("INVALID_ANSWER", "La réponse proposée est invalide.");
            const existing = answers.get(playerId);
            const value = settings.mode === "free" ? choiceId.trim() : choiceId;
            if (submission && (settings.mode !== "qcm" || typeof submission.confirmed !== "boolean" || !Number.isSafeInteger(submission.revision) || submission.revision <= 0)) throw new GameEngineError("INVALID_ANSWER", "La présélection est invalide.");
            if (existing && existing.confirmed !== false) {
                if ((existing.choiceId ?? existing.text) !== value) throw new GameEngineError("ALREADY_ANSWERED", "Ta réponse est déjà validée pour cette question.");
                return receipt(existing);
            }
            // An older HTTP response or another delayed draft must never undo the newest choice.
            if (existing && submission && submission.revision <= (existing.revision ?? 0)) return receipt(existing);
            const next: PlayerAnswer = { ...(settings.mode === "qcm" ? { choiceId: value } : { text: value }), submittedAt: now(),
                ...(submission ? { confirmed: submission.confirmed, revision: submission.revision } : existing?.confirmed === false ? { confirmed: true, revision: (existing.revision ?? 0) + 1 } : {}) };
            answers.set(playerId, next);
            return receipt(next);
        },
        getAnswer(playerId) {
            const answer = answers.get(playerId);
            return answer && status !== "finished" ? receipt(answer) : null;
        },
        getOwnReview(playerId) {
            if (status !== "finished") return null;
            return review.map((round, roundIndex) => {
                const answer = privateReview[roundIndex].get(playerId);
                const result = round.results.find(item => item.playerId === playerId);
                const basePoints = result?.correct ? 10 : 0;
                const duration = round.question.endsAt !== undefined && round.question.startsAt !== undefined ? round.question.endsAt - round.question.startsAt : 0;
                const responseMs = !answer || !automatic ? null : answer.automatic ? duration : Math.max(0, Math.min(duration, answer.submittedAt - round.question.startsAt!));
                return { questionNumber: round.question.number, answered: Boolean(answer), correct: result?.correct ?? false,
                    ...(answer?.choiceId !== undefined ? { choiceId: answer.choiceId } : {}), ...(answer?.text !== undefined ? { text: answer.text } : {}),
                    automatic: answer?.automatic ?? false, responseMs,
                    basePoints, bonusPoints: (result?.points ?? 0) - basePoints, points: result?.points ?? 0 };
            });
        },
        getRoundPoints() {
            if (status !== "result") return [];
            return roundPoints();
        },
        getPlayback() {
            const track = selected[index];
            return automatic && status === "question" && track.spotifyUrl ? { trackId: track.id, offsetMs, startsAt, endsAt: audioEndsAt } : null;
        },
    };
}
