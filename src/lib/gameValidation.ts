export function normalizeNickname(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const nickname = value.trim();
    return nickname.length >= 1 && nickname.length <= 30 ? nickname : null;
}

export function normalizeGameCode(value: string): string | null {
    const code = value.trim();
    return /^\d{5}$/.test(code) ? code : null;
}