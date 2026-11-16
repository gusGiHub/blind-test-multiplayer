export interface AnswerChoice {
    id: string;
    title: string;
    artist: string;
}

export interface PlayerAnswer {
    confirmed?: boolean;
    revision?: number;
    choiceId?: string;
    text?: string;
    submittedAt: number;
}

export interface AnswerReceipt {
    round?: number;
    confirmed?: boolean;
    revision?: number;
    questionNumber: number;
    choiceId?: string;
    text?: string;
}

export interface AnswerSubmission { confirmed: boolean; revision: number; }

export interface RoundScore {
    playerId: string;
    nickname: string;
    points: number;
    total: number;
    correct: boolean;
}
