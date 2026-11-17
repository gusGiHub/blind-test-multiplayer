'use client'

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useRef } from "react";

import { normalizeGameCode } from "@/src/lib/gameValidation";

export default function JoinGame() {
    const router = useRouter();
    const [pseudo, setPseudo] = useState("");
    const [gameCode, setGameCode] = useState("");
    const submittingRef = useRef(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleJoin = async () => {
        if (submittingRef.current) return;
        const code = normalizeGameCode(gameCode);
        if (!code) {
            setError("Le code doit contenir 5 chiffres.");
            return;
        }
        submittingRef.current = true;
        setPending(true);
        setError(null);
        try {
            const response = await fetch(`/api/games/${code}/join`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ nickname: pseudo }),
            });
            const data = await response.json();
            if (!response.ok) {
                setError(data.error ?? "Impossible de rejoindre la partie.");
                return;
            }
            router.push(`/game/${code}?playerId=${data.id}`);
        } catch {
            setError("Impossible de contacter le serveur. Réessaie.");
        } finally {
            submittingRef.current = false;
            setPending(false);
        }
    };

    return (
        <main id="main-content" className="page-shell page-shell--narrow">
            <Link href="/" className="back-link"><span aria-hidden="true">←</span> Retour à l’accueil</Link>
            <section className="panel" aria-labelledby="join-title">
                <div className="form-heading">
                    <h1 id="join-title">Rejoindre une partie</h1>
                    <p className="muted">Entre le code partagé par l’hôte.</p>
                </div>
                <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void handleJoin(); }}>
                    <div className="field">
                        <label htmlFor="nickname">Ton pseudo</label>
                        <input id="nickname" name="nickname" type="text" autoComplete="nickname" placeholder="Ex. Mélomane incognito" maxLength={30} required value={pseudo} onChange={(e) => setPseudo(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="game-code">Code de la partie</label>
                        <input className="code-input" id="game-code" name="code" type="text" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="12345" required aria-describedby="code-hint" value={gameCode} onChange={(e) => setGameCode(e.target.value)} />
                        <p id="code-hint" className="field-hint">Les 5 chiffres affichés dans le lobby de l’hôte.</p>
                    </div>
                    {error && <p className="alert" role="alert">{error}</p>}
                    <button className="btn btn-primary btn-full" type="submit" disabled={pending} aria-busy={pending}>{pending ? "Connexion..." : "Rejoindre la partie"}</button>
                </form>
            </section>
            <p className="form-footer">Pas encore de salle ? <Link className="inline-link" href="/create">Crée ta partie</Link></p>
        </main>
    );
}
