'use client';
import { useEffect, useState } from "react";
import type { PublicQuestion } from "@/src/types/gameProgress";
import type { AnswerReceipt } from "@/src/types/gameplay";
import { RoundCountdown } from "./QuestionChoices";

export default function FreeAnswer({ question, receipt, pending, disabled, serverOffsetMs, onAnswer }: {
    question: PublicQuestion; receipt: AnswerReceipt | null; pending: boolean; disabled: boolean; serverOffsetMs: number; onAnswer: (text: string) => void;
}) {
    const [text, setText] = useState("");
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 150); return () => clearInterval(timer); }, []);
    const preparing = now === null || (question.startsAt !== undefined && now + serverOffsetMs < question.startsAt);
    const closed = now !== null && question.endsAt !== undefined && now + serverOffsetMs >= question.endsAt;
    const audioFinished = now !== null && question.audioEndsAt !== undefined && now + serverOffsetMs >= question.audioEndsAt;
    const locked = disabled || pending || Boolean(receipt) || preparing || closed;
    return <div className="question-choices">
        {question.endsAt !== undefined && <RoundCountdown endsAt={question.endsAt} serverOffsetMs={serverOffsetMs} />}
        <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!locked && text.trim()) onAnswer(text.trim()); }}>
            <div className="field"><label htmlFor="free-answer">Titre du morceau</label>
                <input id="free-answer" type="text" maxLength={200} autoComplete="off" spellCheck={false} required disabled={locked} value={receipt?.text ?? text} onChange={event => setText(event.target.value)} aria-describedby="free-answer-hint" />
                <p id="free-answer-hint" className="field-hint">Le titre suffit. Parenthèses, casse, accents et ponctuation ignorés. Petites fautes tolérées : une de 6 à 11 caractères, deux à partir de 12 ; titres plus courts et nombres exacts. Une seule réponse, définitive après envoi.</p>
            </div>
            <button className="btn btn-primary" type="submit" disabled={locked || !text.trim()}>{pending ? "Envoi…" : "Valider ma réponse"}</button>
            <p className="muted" role="status">{receipt ? "Réponse enregistrée. Attends le résultat." : preparing ? "Préparation de l’extrait…" : closed ? "Temps écoulé. Révélation de la réponse…" : audioFinished ? "L’extrait est terminé. Tu peux encore répondre jusqu’à la fin du compte à rebours." : "Écoute et indique le titre du morceau."}</p>
        </form>
    </div>;
}
