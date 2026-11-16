'use client';

import { useEffect, useState } from "react";
import type { GameSnapshot, PersonalRoundReview, ReviewedRound } from "@/src/types/gameProgress";
import QuestionChoices from "./QuestionChoices";

export default function PersonalGameReview({ code, playerId, round, review }: {
    code: string; playerId: string; round: number; review: ReviewedRound[];
}) {
    const [ownReview, setOwnReview] = useState<PersonalRoundReview[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        const load = async () => {
            setLoading(true);
            setError(null);
            setOwnReview(null);
            try {
                const response = await fetch(`/api/games/${code}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId }), cache: "no-store", signal: controller.signal });
                const data: GameSnapshot & { error?: string } = await response.json();
                if (!response.ok) throw new Error(data.error ?? "Impossible de charger tes réponses.");
                if ((data.game.round ?? 0) !== round || data.progress?.status !== "finished") throw new Error("Cette correction concerne une partie terminée. Retrouve la partie en cours dans le lobby.");
                if (!controller.signal.aborted) setOwnReview(data.ownReview ?? null);
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Impossible de charger tes réponses.");
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        };
        void load();
        return () => controller.abort();
    }, [code, playerId, round, attempt]);

    return <section className="final-review" aria-labelledby="review-title">
        <p className="eyebrow">Le débrief</p>
        <h3 id="review-title">Ta correction, titre par titre</h3>
        <p className="field-hint">Ouvre une manche pour retrouver ta réponse et le détail des points. Tes réponses restent privées.</p>
        {loading && <p className="muted" role="status">Chargement de tes réponses…</p>}
        {error && <><p className="alert" role="alert">{error}</p><button className="btn btn-secondary" onClick={() => setAttempt(current => current + 1)}>Réessayer</button></>}
        {!loading && !error && !ownReview && <p className="selection-note">Les réponses personnelles ne sont pas disponibles pour cette ancienne partie.</p>}
        <ol className="review-list">{review.map(item => {
            const own = ownReview?.find(result => result.questionNumber === item.question.number);
            const result = item.results.find(result => result.playerId === playerId);
            const selected = item.question.choices?.find(choice => choice.id === own?.choiceId);
            const hasChoiceCards = Boolean(item.question.choices?.length && item.answer.choiceId);
            const answerLabel = own?.text ?? (selected ? `${selected.title} · ${selected.artist}` : own?.answered ? "Réponse enregistrée" : "Aucune réponse enregistrée");
            return <li key={item.question.number}>
                <details className="personal-review-round">
                    <summary><span className="step-number">{item.question.number}</span><span className="review-track-name">{item.answer.title}<span>{item.answer.artist}</span></span><span className={`badge${own?.correct ? " badge-ready" : " badge-neutral"}`}>{own ? `+${own.points} pts` : result ? `+${result.points} pts` : "Correction"}</span></summary>
                    <div className="personal-review-content">
                        {!hasChoiceCards && <p className="review-correct-answer"><strong>Bonne réponse</strong><br />{item.answer.title} · {item.answer.artist}</p>}
                        {!hasChoiceCards && own && <p className={`review-own-answer${own.correct ? " review-own-answer--correct" : own.answered ? " review-own-answer--wrong" : ""}`}><strong>Ta réponse</strong><br />{answerLabel}</p>}
                        {hasChoiceCards && <QuestionChoices question={item.question} receipt={own?.choiceId ? { questionNumber: item.question.number, choiceId: own.choiceId, confirmed: true } : null} pending={false} disabled={true} serverOffsetMs={0} onAnswer={() => {}} correctChoiceId={item.answer.choiceId} />}
                        {own && <>
                            <p className="review-validation">{!own.answered ? "Aucun envoi reçu avant la clôture." : own.automatic ? "Présélection comptée automatiquement à la clôture · sans bonus." : own.responseMs !== null ? `Validation après ${(own.responseMs / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s.` : "Réponse validée."}</p>
                            <dl className="review-breakdown"><div><dt>Bonne réponse</dt><dd>{own.basePoints} pts</dd></div><div><dt>Bonus de rapidité</dt><dd>+{own.bonusPoints} pts</dd></div><div><dt>Total de la manche</dt><dd>{own.points} pts</dd></div></dl>
                        </>}
                        {item.answer.spotifyUrl && <a className="inline-link music-link" href={item.answer.spotifyUrl} target="_blank" rel="noopener noreferrer">Écouter sur Spotify ↗</a>}
                    </div>
                </details>
            </li>;
        })}</ol>
    </section>;
}
