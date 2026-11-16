'use client'

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { DEFAULT_GAME_SETTINGS, type GameSettings } from "@/src/lib/gameSettings";
import SettingChoices from "./SettingChoices";

export default function CreateGame() {

    const [pseudo, setPseudo] = useState("");
    const [questionCount, setQuestionCount] = useState(5);
    const [settings, setSettings] = useState<GameSettings>({ ...DEFAULT_GAME_SETTINGS, scoring: "speed", revealMode: "each" });

    const [playlistName, setPlaylistName] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        const loadSelection = async () => {
            try {
                const response = await fetch("/api/spotify/status", { cache: "no-store", signal: controller.signal });
                if (!response.ok) return;
                const data = await response.json();
                if (!controller.signal.aborted) setPlaylistName(data.selectedPlaylist?.name ?? null);
            } catch { /* The game can still be created and its source chosen from the lobby. */ }
        };
        void loadSelection();
        return () => controller.abort();
    }, []);

    const router = useRouter();
    const submittingRef = useRef(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleCreate = async () => {
        if (submittingRef.current) return;
        submittingRef.current = true;
        setPending(true);
        setError(null);
        try {
            const response = await fetch("/api/games", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ nickname: pseudo, questionCount, settings }),
            });
            const data = await response.json();
            if (!response.ok) {
                setError(data.error ?? "Impossible de créer la partie.");
                return;
            }
            router.push(`/game/${data.game.code}?playerId=${data.player.id}`);
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
            <section className="panel" aria-labelledby="create-title">
                <div className="form-heading">
                    <p className="eyebrow">À toi de donner le tempo</p>
                    <h1 id="create-title">Créer une partie</h1>
                    <p className="muted">Prépare ta salle, puis invite tes amis.</p>
                </div>
                <p className="selection-note">
                    {playlistName ? <>Playlist par défaut : <strong>{playlistName}</strong>. Tu pourras la changer dans le lobby.</> : <>Tu pourras connecter Spotify et choisir ta playlist directement dans le lobby après la création de la salle.</>}
                </p>
                <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
                    <div className="field">
                        <label htmlFor="nickname">Ton pseudo</label>
                        <input id="nickname" name="nickname" type="text" autoComplete="nickname" placeholder="Ex. DJ du dimanche" maxLength={30} required value={pseudo} onChange={(e) => setPseudo(e.target.value)} />
                    </div>
                    <div className="field">
                        <SettingChoices name="question-count" legend="Nombre de questions" value={questionCount} onChange={setQuestionCount} options={[{ value: 5, label: "5", description: "Express" }, { value: 10, label: "10", description: "Classique" }, { value: 15, label: "15", description: "Marathon" }]} />
                        <p className="field-hint">Choisis le format de votre partie.</p>
                    </div>
                    <div className="field">
                        <SettingChoices<GameSettings["mode"]> name="game-mode" legend="Mode de jeu" value={settings.mode} onChange={mode => setSettings(current => ({ ...current, mode }))} options={[{ value: "qcm", label: "QCM", description: "4 propositions, un bon titre" }, { value: "free", label: "Réponse libre", description: "À toi de retrouver le titre" }]} />
                        {settings.mode === "free" && <p className="field-hint">Le titre suffit. Parenthèses, casse, accents et ponctuation ignorés. Jusqu’à 5 caractères : titre exact ; de 6 à 11 : une petite faute ; à partir de 12 : deux maximum. Les nombres restent exacts.</p>}
                    </div>
                    <div className="field">
                        <SettingChoices<NonNullable<GameSettings["revealMode"]>> name="reveal-mode" legend="Quand révéler les réponses ?" value={settings.revealMode ?? "each"} onChange={revealMode => setSettings(current => ({ ...current, revealMode }))} options={[{ value: "each", label: "Après chaque titre", description: "Correction et scores à chaque manche" }, { value: "end", label: "Tout à la fin", description: "Réponses et classement gardés secrets" }]} />
                    </div>
                    <div className="field">
                        <SettingChoices<NonNullable<GameSettings["scoring"]>> name="scoring" legend="Attribution des points" value={settings.scoring ?? "classic"} onChange={scoring => setSettings(current => ({ ...current, scoring }))} options={[{ value: "speed", label: "Rapidité", description: "10 points + jusqu’à 10 points de bonus" }, { value: "classic", label: "Classique", description: "10 points par bonne réponse" }]} />
                        {settings.scoring === "speed" && <p className="field-hint">Le bonus diminue avec le temps de validation. Une présélection validée automatiquement à la fin rapporte 10 points si elle est correcte, sans bonus.</p>}
                    </div>
                    <div className="field">
                        <label htmlFor="excerpt-duration">Durée de l’extrait (secondes)</label>
                        <input id="excerpt-duration" type="number" min={1} max={30} step={1} required value={Number.isNaN(settings.excerptSeconds) ? "" : settings.excerptSeconds} onChange={e => { const seconds = e.target.valueAsNumber; setSettings(current => ({ ...current, excerptSeconds: seconds, responseSeconds: Number.isFinite(seconds) ? Math.max(Number.isFinite(current.responseSeconds) ? current.responseSeconds! : seconds, seconds) : current.responseSeconds })); }} />
                        <p className="field-hint">Entre 1 et 30 secondes de musique.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="response-duration">Temps de réponse (secondes)</label>
                        <input id="response-duration" type="number" min={settings.excerptSeconds || 1} max={120} step={1} required value={Number.isNaN(settings.responseSeconds) ? "" : settings.responseSeconds ?? settings.excerptSeconds} onChange={e => setSettings(current => ({ ...current, responseSeconds: e.target.valueAsNumber }))} />
                        <p className="field-hint">Délai total depuis le début de l’extrait jusqu’au résultat. Au moins la durée d’écoute, jusqu’à 120 secondes. Par exemple : 10 secondes de musique et 20 secondes pour répondre.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="pause-duration">Pause entre les titres (secondes)</label>
                        <input id="pause-duration" type="number" min={0} max={30} step={1} required value={Number.isNaN(settings.pauseSeconds) ? "" : settings.pauseSeconds} onChange={e => setSettings(current => ({ ...current, pauseSeconds: e.target.valueAsNumber }))} />
                        <p className="field-hint">Le résultat reste affiché pendant cette pause. À 0, le passage au titre suivant est immédiat.</p>
                    </div>
                    <div className="field">
                        <SettingChoices<GameSettings["excerptPosition"]> name="excerpt-position" legend="Position de l’extrait" value={settings.excerptPosition} onChange={excerptPosition => setSettings(current => ({ ...current, excerptPosition }))} options={[{ value: "start", label: "Début", description: "Dès la première note" }, { value: "random", label: "Aléatoire", description: "La surprise" }, { value: "middle", label: "Milieu", description: "Au cœur du titre" }]} />
                    </div>
                    {error && <p className="alert" role="alert">{error}</p>}
                    <button className="btn btn-primary btn-full" type="submit" disabled={pending} aria-busy={pending}>{pending ? "Création..." : "Créer ma partie"}</button>
                </form>
            </section>
            <p className="form-footer">Tu as déjà un code ? <Link className="inline-link" href="/join">Rejoins tes amis</Link></p>
        </main>
    );
}
