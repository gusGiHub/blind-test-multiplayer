/** Private runtime addresses; never infer an internal fetch URL from a browser header. */
export function getServerPort(): number {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT doit être un entier compris entre 1 et 65535.");
    return port;
}

export function getInternalApiOrigin(): string {
    return `http://127.0.0.1:${getServerPort()}`;
}

export function getAllowedOrigins(): string[] {
    const production = process.env.NODE_ENV === "production";
    const port = getServerPort();
    if (production && !process.env.APP_URL) throw new Error("APP_URL est obligatoire en production.");
    const url = new URL(process.env.APP_URL ?? `http://127.0.0.1:${port}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        (production ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol))) {
        throw new Error("APP_URL doit être une origine sans chemin, en HTTPS en production.");
    }
    return production ? [url.origin] : [...new Set([url.origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`])];
}
