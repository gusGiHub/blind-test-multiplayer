import { NextResponse } from "next/server";

/** Keep the local server unchanged; Vercel must never fall back to isolated Maps. */
export function withGameStore<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
    return async (...args: Args): Promise<Response> => {
        const shared = process.env.VERCEL === "1" || Boolean(process.env.SUPABASE_URL);
        if (!shared) return handler(...args);
        if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
            return NextResponse.json({ error: "Le stockage des parties n’est pas configuré. Ajoute les variables Supabase dans Vercel, puis redéploie." }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        try {
            const { runWithSharedStore } = await import("./databaseStore");
            return await runWithSharedStore(() => handler(...args));
        } catch {
            // Never expose database URLs, authorization headers or stored Spotify tokens.
            return NextResponse.json({ error: "Le stockage des parties est momentanément indisponible. Réessaie dans quelques instants." }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "2" } });
        }
    };
}
