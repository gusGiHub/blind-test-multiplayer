'use client';
import { useEffect, useState } from "react";
import type { PublicQuestion } from "@/src/types/gameProgress";
import type { AnswerReceipt } from "@/src/types/gameplay";

export function RoundCountdown({ endsAt, serverOffsetMs }: { endsAt: number; serverOffsetMs: number }) {
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(timer); }, []);
    return <span className="round-clock" role="timer" aria-label="Temps restant">{now === null ? "…" : `${Math.max(0, Math.ceil((endsAt - now - serverOffsetMs) / 1000))} s`}</span>;
}

export default function QuestionChoices({ question, receipt, pending, disabled, serverOffsetMs, onAnswer, correctChoiceId }: {
    question: PublicQuestion; receipt: AnswerReceipt | null; pending: boolean; disabled: boolean; serverOffsetMs: number; onAnswer: (choiceId: string, confirmed?: boolean) => void; correctChoiceId?: string;
}) {
    const revealed = correctChoiceId !== undefined;
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => { if (revealed) return; const timer = setInterval(() => setNow(Date.now()), 150); return () => clearInterval(timer); }, [revealed]);
    const clock = (now ?? 0) + serverOffsetMs;
    const preparing = now === null || (question.startsAt !== undefined && clock < question.startsAt);
    const closed = question.endsAt !== undefined && clock >= question.endsAt;
    const audioFinished = question.audioEndsAt !== undefined && clock >= question.audioEndsAt;
    const locked = revealed || Boolean(receipt && receipt.confirmed !== false);
    return <div className="question-choices">
        {!revealed && question.endsAt !== undefined && <RoundCountdown endsAt={question.endsAt} serverOffsetMs={serverOffsetMs} />}
        <p className="muted">{revealed ? "La bonne réponse est indiquée en vert." : preparing ? "Préparation de l’extrait…" : closed ? receipt?.choiceId ? "Temps écoulé. Ta dernière présélection enregistrée est retenue." : "Temps écoulé. Aucune présélection enregistrée." : locked ? pending ? "Validation en cours…" : "Réponse validée. Attends le résultat." : receipt ? "Tu peux changer de choix ou valider. Sans validation, la dernière présélection enregistrée sera retenue à la fin du délai." : audioFinished ? "L’extrait est terminé. Tu peux encore choisir et valider jusqu’à la fin du compte à rebours." : "Choisis une proposition, puis valide ta réponse. Tu peux changer d’avis avant de valider."}</p>
        <div className="choices-grid">
            {question.choices?.map((choice, index) => <button className={`answer-choice${revealed ? " answer-choice--revealed" : ""}${receipt?.choiceId === choice.id ? " answer-choice--selected" : ""}${revealed && choice.id === correctChoiceId ? " answer-choice--correct" : revealed && receipt?.choiceId === choice.id ? " answer-choice--wrong" : ""}`} key={choice.id} type="button" disabled={disabled || locked || preparing || closed} aria-pressed={receipt?.choiceId === choice.id} onClick={() => { if (!disabled && !locked && !preparing && !closed) onAnswer(choice.id, false); }}>
                <span className="choice-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span><span><strong>{choice.title}</strong><span className="choice-artist">{choice.artist}</span>{revealed && choice.id === correctChoiceId && <span className="choice-verdict">✓ Bonne réponse{receipt?.choiceId === choice.id ? " · Ton choix" : ""}</span>}{revealed && receipt?.choiceId === choice.id && choice.id !== correctChoiceId && <span className="choice-verdict">✗ Ton choix · Réponse incorrecte</span>}</span>
            </button>)}
        </div>
        {!revealed && <button className="btn btn-primary" type="button" disabled={disabled || locked || !receipt?.choiceId || preparing || closed} onClick={() => { if (receipt?.choiceId && !disabled && !locked && !preparing && !closed) onAnswer(receipt.choiceId, true); }}>Valider ma réponse</button>}
        {pending && <p role="status" className="muted">{locked ? "Validation en cours…" : "Enregistrement de la présélection…"}</p>}
    </div>;
}
