import type { Game, Player } from "@/src/types/game";
import type { GameEngine } from "./gameEngine";
import type { PlayerSession } from "./playerSession";

interface GameStore {
    games: Map<string, Game>;
    players: Map<string, Player>;
    sessions: Map<string, PlayerSession>;
    gameEngines: Map<string, GameEngine>;
    startingGames: Set<string>;
}

const globalStore = globalThis as typeof globalThis & {
    blindTestStore?: GameStore;
};

// Reuse the same collections when Next.js reloads this module in this runtime.
const store = globalStore.blindTestStore ??= {
    games: new Map<string, Game>(),
    players: new Map<string, Player>(),
    sessions: new Map<string, PlayerSession>(),
    gameEngines: new Map<string, GameEngine>(),
    startingGames: new Set<string>(),
};

export const games = store.games;
export const players = store.players;
export const sessions = store.sessions;
// Existing dev runtimes may predate the private engine collection.
export const gameEngines = store.gameEngines ??= new Map<string, GameEngine>();

export const startingGames = store.startingGames ??= new Set<string>();
