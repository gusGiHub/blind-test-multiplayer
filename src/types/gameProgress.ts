import type { Game, Player } from "./game";
import type { AnswerChoice, AnswerReceipt, RoundScore } from "./gameplay";

/** Public question metadata; the correct answer stays private until its reveal. */
export interface PublicQuestion {
    mode?: "qcm" | "free";
    number: number;
    total: number;
    audioPath?: `/audio/${string}`;
    prompt?: string;
    choices?: AnswerChoice[];
    startsAt?: number;
    endsAt?: number;
    audioEndsAt?: number;
}

export interface RevealedAnswer { title: string; artist: string; spotifyUrl?: string; choiceId?: string; }
export interface ReviewedRound { question: PublicQuestion; answer: RevealedAnswer; results: { playerId: string; correct: boolean; points: number }[]; }
export interface PersonalRoundReview {
    questionNumber: number;
    choiceId?: string;
    text?: string;
    answered: boolean;
    correct: boolean;
    automatic: boolean;
    responseMs: number | null;
    basePoints: number;
    bonusPoints: number;
    points: number;
}
export interface AnswerParticipation { answered: number; total: number; }
export interface AnswerCountUpdate extends AnswerParticipation { questionNumber: number; round: number; }
export interface PlayerReadyUpdate { player: Player; round: number; }
export type GameProgress =
    | { status: "question"; question: PublicQuestion; participation?: AnswerParticipation }
    | { status: "result"; question: PublicQuestion; answer?: RevealedAnswer; endsAt?: number; scores?: RoundScore[] }
    | { status: "finished"; questionCount: number; review?: ReviewedRound[]; ranking?: { playerId: string; nickname: string; score: number; rank: number }[] };

export interface GameUpdate {
    game: Game;
    progress: GameProgress;
    players?: Player[];
    serverTime?: number;
}

export interface GameSnapshot {
    ownReview?: PersonalRoundReview[] | null;
    game: Game;
    players: Player[];
    progress: GameProgress | null;
    ownAnswer?: AnswerReceipt | null;
    serverTime?: number;
}

export interface LobbyPlaylistUpdate { game: Game; serverTime: number; }
