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
    const statusMessage = receipt ? "Réponse enregistrée." : preparing ? "Chargement de l’extrait…" : closed ? "Temps écoulé." : audioFinished ? "La musique est terminée. Tu peux encore répondre." : "";
    return <div className="question-choices">
        {question.endsAt !== undefined && <RoundCountdown endsAt={question.endsAt} serverOffsetMs={serverOffsetMs} />}
        <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!locked && text.trim()) onAnswer(text.trim()); }}>
            <div className="field"><label htmlFor="free-answer">Titre du morceau</label>
                <input id="free-answer" type="text" maxLength={200} autoComplete="off" spellCheck={false} required disabled={locked} value={receipt?.text ?? text} onChange={event => setText(event.target.value)} aria-describedby="free-answer-hint" />
                <p id="free-answer-hint" className="field-hint">Le titre suffit. Accents et petites fautes tolérés ; titres courts et nombres exacts. Une seule réponse.</p>
            </div>
            <button className="btn btn-primary" type="submit" disabled={locked || !text.trim()}>{pending ? "Envoi…" : "Valider ma réponse"}</button>
            {statusMessage && <p className="muted" role="status">{statusMessage}</p>}
        </form>
    </div>;
}
