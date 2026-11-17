'use client';

import { useEffect, useId, useRef, useState } from "react";
import type { SpotifyPlaylist, SpotifyQuestionPreview } from "@/src/types/spotify";

export default function SpotifyQuestionPreviewPanel({ playlist, disabled }: { playlist: SpotifyPlaylist; disabled: boolean }) {
    const [questionCount, setQuestionCount] = useState(5);
    const [preview, setPreview] = useState<SpotifyQuestionPreview | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const pendingRef = useRef(false);
    const selectId = useId();

    useEffect(() => () => controllerRef.current?.abort(), []);

    const generate = async () => {
        if (disabled || pendingRef.current) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        pendingRef.current = true;
        setPending(true);
        setPreview(null);
        setError(null);
        try {
            const response = await fetch("/api/spotify/questions/preview", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ playlistId: playlist.id, questionCount }),
                cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? "Impossible de générer l’aperçu.");
            if (!controller.signal.aborted) setPreview(data as SpotifyQuestionPreview);
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error && cause.name !== "TimeoutError"
                ? cause.message : "La génération a pris trop de temps. Réessaie.");
        } finally {
            pendingRef.current = false;
            if (!controller.signal.aborted) setPending(false);
        }
    };

    return (
        <section className="question-preview" aria-labelledby={`${selectId}-title`}>
            <h2 id={`${selectId}-title`}>Aperçu des questions</h2>
            <form className="preview-controls" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
                <div className="field">
                    <label htmlFor={selectId}>Nombre de questions</label>
                    <select id={selectId} value={questionCount} disabled={disabled || pending} onChange={(event) => { setQuestionCount(Number(event.target.value)); setPreview(null); setError(null); }}>
                        <option value={5}>5 questions</option>
                        <option value={10}>10 questions</option>
                        <option value={15}>15 questions</option>
                    </select>
                </div>
                <button className="btn btn-primary" type="submit" disabled={disabled || pending} aria-busy={pending}>{pending ? "Génération…" : preview ? "Générer un nouvel aperçu" : "Générer l’aperçu"}</button>
            </form>
            {pending && <p className="muted" role="status">Récupération des morceaux et préparation de l’aperçu…</p>}
            {error && <p className="alert" role="alert">{error}</p>}
            {preview && (
                <div className="preview-result">
                    <p className="selection-note" role="status">{preview.questionCount} questions préparées parmi {preview.eligibleTrackCount} morceaux distincts utilisables. <strong>Les réponses sont visibles dans cet aperçu.</strong></p>
                    <ol className="preview-question-list" aria-label="Questions générées et réponses">
                        {preview.questions.map((question) => (
                            <li className="preview-question" key={question.track.id}>
                                <span className="badge badge-neutral">Question {question.number}</span>
                                <h3>{question.prompt}</h3>
                                <p><strong>{question.answer.title}</strong><br /><span className="muted">{question.answer.artists.join(", ")}</span></p>
                                <a className="inline-link music-link" href={question.track.url} target="_blank" rel="noopener noreferrer">Voir le morceau sur Spotify ↗</a>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
            <p className="field-hint">Les titres sont tirés à nouveau au début de chaque partie.</p>
        </section>
    );
}
