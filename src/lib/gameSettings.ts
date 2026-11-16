export interface GameSettings {
    revealMode?: "each" | "end";
    scoring?: "classic" | "speed";
    mode: "qcm" | "free";
    excerptSeconds: number;
    responseSeconds?: number;
    pauseSeconds: number;
    excerptPosition: "start" | "random" | "middle";
}

export const DEFAULT_GAME_SETTINGS: Readonly<GameSettings> = Object.freeze({ mode: "qcm", excerptSeconds: 30, responseSeconds: 30, pauseSeconds: 5, excerptPosition: "random" });

/** Shared validation; the server always validates again before storing settings. */
export function parseGameSettings(value: unknown): GameSettings | null {
    if (value === undefined) return { ...DEFAULT_GAME_SETTINGS };
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const settings = value as Record<string, unknown>;
    // Older rooms used the excerpt duration as their response deadline.
    const responseSeconds = settings.responseSeconds === undefined ? settings.excerptSeconds : settings.responseSeconds;
    if ((settings.revealMode !== undefined && !["each", "end"].includes(settings.revealMode as string)) ||
        (settings.scoring !== undefined && !["classic", "speed"].includes(settings.scoring as string)) ||
        !["qcm", "free"].includes(settings.mode as string) ||
        !Number.isInteger(settings.excerptSeconds) || (settings.excerptSeconds as number) < 1 || (settings.excerptSeconds as number) > 30 ||
        !Number.isInteger(responseSeconds) || (responseSeconds as number) < (settings.excerptSeconds as number) || (responseSeconds as number) > 120 ||
        !Number.isInteger(settings.pauseSeconds) || (settings.pauseSeconds as number) < 0 || (settings.pauseSeconds as number) > 30 ||
        !["start", "random", "middle"].includes(settings.excerptPosition as string)) return null;
    return { mode: settings.mode as GameSettings["mode"], excerptSeconds: settings.excerptSeconds as number, responseSeconds: responseSeconds as number, pauseSeconds: settings.pauseSeconds as number, excerptPosition: settings.excerptPosition as GameSettings["excerptPosition"],
        ...(settings.revealMode !== undefined ? { revealMode: settings.revealMode as GameSettings["revealMode"] } : {}),
        ...(settings.scoring !== undefined ? { scoring: settings.scoring as GameSettings["scoring"] } : {}) };
}

export function normalizeTitle(value: string): string {
    let title = value.normalize("NFKD");
    // Remove balanced parenthetical metadata, including nested or repeated groups.
    let previous: string;
    do {
        previous = title;
        title = title.replace(/\([^()]*\)/g, "");
    } while (title !== previous);
    return title.toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
}

/** Conservative edit distance; adjacent swapped letters count as one typo. */
export function matchesTitleAnswer(answer: string, title: string): boolean {
    const normalizedAnswer = normalizeTitle(answer);
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedAnswer || !normalizedTitle) return false;
    if (normalizedAnswer === normalizedTitle) return true;
    // A changed number often identifies another track or part, rather than a typo.
    if ((normalizedAnswer.match(/\p{N}+/gu) ?? []).join("|") !== (normalizedTitle.match(/\p{N}+/gu) ?? []).join("|")) return false;
    const actual = Array.from(normalizedAnswer);
    const expected = Array.from(normalizedTitle);
    const limit = expected.length <= 5 ? 0 : expected.length <= 11 ? 1 : 2;
    if (!limit || Math.abs(actual.length - expected.length) > limit) return false;
    let previous = Array.from({ length: expected.length + 1 }, (_, index) => index);
    let beforePrevious: number[] = [];
    for (let i = 1; i <= actual.length; i++) {
        const current = [i];
        for (let j = 1; j <= expected.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (actual[i - 1] === expected[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && actual[i - 1] === expected[j - 2] && actual[i - 2] === expected[j - 1]) {
                current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
            }
        }
        beforePrevious = previous;
        previous = current;
    }
    return previous[expected.length] <= limit;
}
