export type GameStatus = "lobby" | "question" | "result" | "finished";

export interface Player {
    ready?: boolean;
    readyRevision?: number;
    id: string;
    gameId: string;
    nickname: string;
    score: number;
}

export interface Game {
    round?: number;
    settings?: import("../lib/gameSettings").GameSettings;
    id: string;
    code: string;
    questionCount: number;
    status: GameStatus;
    hostId: string;
    questionSource?: "local" | "spotify";
    playlist?: { id: string; name: string; url: string };
    playlistRevision?: number;
}
