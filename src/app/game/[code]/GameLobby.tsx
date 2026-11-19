'use client';

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { createHttpGameConnection, type GameConnection } from "@/src/lib/httpGameConnection";
import type { Game, GameStatus, Player } from "@/src/types/game";
import type { GameProgress, GameSnapshot, GameUpdate, LobbyPlaylistUpdate, AnswerCountUpdate, PlayerReadyUpdate } from "@/src/types/gameProgress";
import StartGameButton from "./StartGameButton";
import HostSpotifyAudio from "./HostSpotifyAudio";
import QuestionChoices, { RoundCountdown } from "./QuestionChoices";
import FreeAnswer from "./FreeAnswer";
import LobbyPlaylistPicker from "./LobbyPlaylistPicker";
import PersonalGameReview from "./PersonalGameReview";
import type { AnswerReceipt } from "@/src/types/gameplay";

interface GameLobbyProps {
    initialRound?: number;
    initialPlayers: Player[];
    initialStatus: GameStatus;
    initialProgress: GameProgress | null;
    isHost: boolean;
    hostId: string;
    code: string;
    playerId: string;
    nickname: string;
    initialPlaylistName?: string;
    initialPlaylist?: Game["playlist"];
    initialPlaylistRevision?: number;
    initialOwnAnswer?: AnswerReceipt | null;
    initialServerTime?: number;
}

// Monotonic order prevents a delayed snapshot from undoing a newer socket event.
function progressOrder(progress: GameProgress | null): number {
    if (!progress) return 0;
    if (progress.status === "finished") return progress.questionCount * 2 + 1;
    return progress.question.number * 2 - (progress.status === "question" ? 1 : 0);
}

function mergeReadyPlayers(current: Player[], incoming: Player[]): Player[] {
    return incoming.map(player => {
        const previous = current.find(candidate => candidate.id === player.id);
        return previous && (previous.readyRevision ?? 0) > (player.readyRevision ?? 0)
            ? { ...player, ready: previous.ready, readyRevision: previous.readyRevision }
            : player;
    });
}

export default function GameLobby(props: GameLobbyProps) {
    const socketRef = useRef<GameConnection | null>(null);
    const commandRef = useRef(false);
    const playlistCommandRef = useRef(false);
    const playlistRevisionRef = useRef(props.initialPlaylistRevision ?? 0);
    const answerRef = useRef(false);
    const answerVersionRef = useRef(props.initialOwnAnswer?.revision ?? 0);
    const pendingAnswerRevisionRef = useRef<number | null>(null);
    const acknowledgedAnswerRef = useRef<AnswerReceipt | null>(props.initialOwnAnswer ?? null);
    const orderRef = useRef(progressOrder(props.initialProgress));
    const roundRef = useRef(props.initialRound ?? 0);
    const [reviewRound, setReviewRound] = useState(props.initialRound ?? 0);
    const readyRequestRef = useRef<boolean | null>(null);
    const readyRequestRevisionRef = useRef(0);
    const [readyPending, setReadyPending] = useState(false);
    const [connected, setConnected] = useState(false);
    const [pending, setPending] = useState(false);
    const [audioReady, setAudioReady] = useState(false);
    const [playlistPending, setPlaylistPending] = useState(false);
    const [roomPlaylist, setRoomPlaylist] = useState<Game["playlist"] | null>(props.initialPlaylist ?? null);
    const [joinError, setJoinError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [answerError, setAnswerError] = useState<string | null>(null);
    const [answerPending, setAnswerPending] = useState(false);
    const [ownAnswer, setOwnAnswer] = useState<AnswerReceipt | null>(props.initialOwnAnswer ?? null);
    const [serverOffsetMs, setServerOffsetMs] = useState(0);
    const [playlistName, setPlaylistName] = useState<string | null>(props.initialPlaylistName ?? null);
    const [players, setPlayers] = useState(props.initialPlayers);
    const [view, setView] = useState({ status: props.initialStatus, progress: props.initialProgress });
    const { status: gameStatus, progress } = view;
    const participation = progress?.status === "question" ? progress.participation ?? { answered: 0, total: players.length } : null;
    const ownReady = players.find(player => player.id === props.playerId)?.ready === true;
    const readyCount = players.filter(player => player.ready).length;
    const allReady = players.length > 0 && readyCount === players.length;
    const ownRoundScore = progress?.status === "result" ? progress.scores?.find(score => score.playerId === props.playerId) : undefined;

    useEffect(() => {
        const socket = process.env.NEXT_PUBLIC_GAME_TRANSPORT === "http" ? createHttpGameConnection() : io({ autoConnect: false });
        socketRef.current = socket;
        const clearPending = () => {
            commandRef.current = false;
            setPending(false);
        };
        const applyPlaylist = (game: Game) => {
            const revision = game.playlistRevision ?? 0;
            if (revision < playlistRevisionRef.current) return;
            playlistRevisionRef.current = revision;
            setRoomPlaylist(game.playlist ?? null);
            setPlaylistName(game.playlist?.name ?? null);
        };
        const applyUpdate = (game: Game, progress: GameProgress | null) => {
            const round = game.round ?? 0;
            if (round < roundRef.current) return false;
            const newRound = round > roundRef.current;
            if (newRound) {
                roundRef.current = round;
                orderRef.current = 0;
                acknowledgedAnswerRef.current = null;
                answerVersionRef.current = 0;
                setOwnAnswer(null);
            }
            const status = game.status;
            const order = progressOrder(progress);
            if (order < orderRef.current) return false;
            orderRef.current = order;
            setReviewRound(round);
            setView(current => {
                if (!newRound && progress?.status === "question" && current.progress?.status === "question" && progress.question.number === current.progress.question.number && progress.participation && current.progress.participation) {
                    return { status, progress: { ...progress, participation: { ...progress.participation, answered: Math.max(progress.participation.answered, current.progress.participation.answered) } } };
                }
                return { status, progress };
            });
            setOwnAnswer(current => {
                if (!progress || progress.status === "finished") return null;
                const saved = progress.status === "result" ? acknowledgedAnswerRef.current : current;
                return saved?.questionNumber === progress.question.number ? saved : null;
            });
            if (!progress || progress.status === "finished" || acknowledgedAnswerRef.current?.questionNumber !== progress.question.number) acknowledgedAnswerRef.current = null;
            answerRef.current = false;
            pendingAnswerRevisionRef.current = null;
            setAnswerPending(false);
            setAnswerError(null);
            clearPending();
            readyRequestRef.current = null;
            setReadyPending(false);
            setActionError(null);
            if (status !== "lobby") { playlistCommandRef.current = false; setPlaylistPending(false); }
            return true;
        };
        socket.on("connect", () => {
            setConnected(false);
            socket.emit("join_game", { code: props.code, playerId: props.playerId });
        });
        socket.on("game_joined", (data: GameSnapshot) => {
            setConnected(true);
            setJoinError(null);
            if (applyUpdate(data.game, data.progress)) {
                setPlayers(current => mergeReadyPlayers(current, data.players));
                applyPlaylist(data.game);
                playlistCommandRef.current = false;
                setPlaylistPending(false);
                setOwnAnswer(data.ownAnswer ?? null);
                acknowledgedAnswerRef.current = data.ownAnswer ?? null;
                answerVersionRef.current = Math.max(answerVersionRef.current, data.ownAnswer?.revision ?? 0);
                if (data.serverTime) setServerOffsetMs(data.serverTime - Date.now());
            }
        });
        socket.on("join_game_error", (data: { error: string }) => {
            setConnected(false);
            setJoinError(data.error);
            clearPending();
        });
        socket.on("connect_error", () => {
            setConnected(false);
            setJoinError("Impossible de se connecter au serveur de la partie.");
            clearPending();
        });
        socket.on("player_joined", (data: { player: Player }) => {
            setPlayers((current) => current.some(player => player.id === data.player.id) ? current : [...current, data.player]);
        });
        const onUpdate = (data: GameUpdate) => {
            if (applyUpdate(data.game, data.progress)) {
                applyPlaylist(data.game);
                if (data.players) setPlayers(current => mergeReadyPlayers(current, data.players!));
                if (data.serverTime) setServerOffsetMs(data.serverTime - Date.now());
            }
        };
        socket.on("game_started", onUpdate);
        socket.on("game_updated", onUpdate);
        socket.on("player_ready", (data: PlayerReadyUpdate) => {
            if (data.round !== roundRef.current || orderRef.current !== 0) return;
            setPlayers(current => {
                const previous = current.find(player => player.id === data.player.id);
                if (previous && (previous.readyRevision ?? 0) > (data.player.readyRevision ?? 0)) return current;
                return previous ? current.map(player => player.id === data.player.id ? data.player : player) : [...current, data.player];
            });
            if (data.player.id === props.playerId && data.player.ready === readyRequestRef.current && (data.player.readyRevision ?? 0) > readyRequestRevisionRef.current) {
                readyRequestRef.current = null;
                setReadyPending(false);
            }
        });
        socket.on("ready_error", (data: { error: string; round?: number }) => {
            if (data.round !== undefined && data.round !== roundRef.current) return;
            readyRequestRef.current = null;
            setReadyPending(false);
            setActionError(data.error);
            if (socket.connected) { setConnected(false); socket.emit("join_game", { code: props.code, playerId: props.playerId }); }
        });
        socket.on("answer_count_updated", (data: AnswerCountUpdate) => {
            if (data.round !== roundRef.current || data.questionNumber * 2 - 1 !== orderRef.current || !Number.isSafeInteger(data.answered) || !Number.isSafeInteger(data.total) || data.answered < 0 || data.total < 1 || data.answered > data.total) return;
            setView(current => {
                if (current.progress?.status !== "question" || current.progress.question.number !== data.questionNumber) return current;
                return { ...current, progress: { ...current.progress, participation: { answered: Math.max(current.progress.participation?.answered ?? 0, data.answered), total: data.total } } };
            });
        });
        socket.on("game_reset", (data: GameSnapshot) => {
            if (applyUpdate(data.game, data.progress)) {
                setPlayers(current => mergeReadyPlayers(current, data.players));
                applyPlaylist(data.game);
                playlistCommandRef.current = false;
                setPlaylistPending(false);
                if (data.serverTime) setServerOffsetMs(data.serverTime - Date.now());
            }
        });
        socket.on("playlist_updated", (data: LobbyPlaylistUpdate) => {
            if ((data.game.round ?? 0) !== roundRef.current || orderRef.current !== 0 || data.game.status !== "lobby" || (data.game.playlistRevision ?? 0) < playlistRevisionRef.current) return;
            applyPlaylist(data.game);
            playlistCommandRef.current = false;
            setPlaylistPending(false);
            setActionError(null);
        });
        socket.on("playlist_error", (data: { error: string }) => {
            playlistCommandRef.current = false;
            setPlaylistPending(false);
            setActionError(data.error);
        });
        const onError = (data: { error: string }) => {
            clearPending();
            setActionError(data.error);
        };
        socket.on("start_game_error", onError);
        socket.on("game_action_error", onError);
        socket.on("game_timer_error", onError);
        socket.on("answer_accepted", (receipt: AnswerReceipt) => {
            if ((receipt.round ?? 0) !== roundRef.current) return;
            if (receipt.questionNumber !== Math.floor((orderRef.current + 1) / 2)) return;
            const previous = acknowledgedAnswerRef.current;
            if (previous && previous.questionNumber === receipt.questionNumber && (receipt.revision ?? 0) < (previous.revision ?? 0)) return;
            acknowledgedAnswerRef.current = receipt;
            // While selecting, a late acknowledgement cannot replace a newer local click.
            if (orderRef.current % 2 !== 0 && receipt.confirmed === false && (receipt.revision ?? 0) < (pendingAnswerRevisionRef.current ?? 0)) return;
            answerVersionRef.current = Math.max(answerVersionRef.current, receipt.revision ?? 0);
            answerRef.current = false;
            pendingAnswerRevisionRef.current = null;
            setAnswerPending(false);
            setOwnAnswer(receipt);
        });
        socket.on("answer_error", (data: { error: string; questionNumber?: number; revision?: number; round?: number }) => {
            if ((data.round ?? 0) !== roundRef.current) return;
            if (data.questionNumber !== undefined && data.questionNumber !== Math.floor((orderRef.current + 1) / 2)) return;
            if (data.revision !== undefined && data.revision < answerVersionRef.current) return;
            answerRef.current = false;
            pendingAnswerRevisionRef.current = null;
            setAnswerPending(false);
            setAnswerError(data.error);
            setOwnAnswer(acknowledgedAnswerRef.current);
            if (socket.connected) { setConnected(false); socket.emit("join_game", { code: props.code, playerId: props.playerId }); }
        });
        socket.on("disconnect", () => {
            setConnected(false);
            readyRequestRef.current = null;
            setReadyPending(false);
            if (commandRef.current) setActionError("Connexion interrompue. L’état sera actualisé à la reconnexion.");
            clearPending();
            answerRef.current = false;
            pendingAnswerRevisionRef.current = null;
            setAnswerPending(false);
            setOwnAnswer(acknowledgedAnswerRef.current);
            playlistCommandRef.current = false;
            setPlaylistPending(false);
        });
        socket.connect();
        return () => {
            socketRef.current = null;
            socket.disconnect();
        };
    }, [props.code, props.playerId]);

    const sendCommand = (event: "start_game" | "reveal_answer" | "next_question" | "rematch_game") => {
        const socket = socketRef.current;
        if (!props.isHost || !connected || !socket?.connected || commandRef.current) return;
        if (event === "start_game" && (gameStatus !== "lobby" || !audioReady || !roomPlaylist || playlistCommandRef.current || !allReady || readyRequestRef.current !== null)) return;
        if (event === "reveal_answer" && progress?.status !== "question") return;
        if (event === "next_question" && progress?.status !== "result") return;
        if (event === "rematch_game" && progress?.status !== "finished") return;
        commandRef.current = true;
        setPending(true);
        setActionError(null);
        socket.emit(event, {
            code: props.code, playerId: props.playerId, round: roundRef.current,
            ...(progress && progress.status !== "finished" ? { questionNumber: progress.question.number } : {}),
        });
    };

    const choosePlaylist = (playlistId: string) => {
        if (!props.isHost || !connected || !socketRef.current?.connected || gameStatus !== "lobby" || commandRef.current || playlistCommandRef.current || readyRequestRef.current !== null) return;
        playlistCommandRef.current = true;
        setPlaylistPending(true);
        setActionError(null);
        socketRef.current.emit("select_playlist", { code: props.code, playerId: props.playerId, playlistId, round: roundRef.current });
    };

    const toggleReady = () => {
        if (!connected || !socketRef.current?.connected || gameStatus !== "lobby" || commandRef.current || playlistCommandRef.current || readyRequestRef.current !== null) return;
        readyRequestRef.current = !ownReady;
        readyRequestRevisionRef.current = players.find(player => player.id === props.playerId)?.readyRevision ?? 0;
        setReadyPending(true);
        setActionError(null);
        socketRef.current.emit("set_ready", { code: props.code, playerId: props.playerId, round: roundRef.current, ready: !ownReady });
    };

    const sendAnswer = (choiceId: string, confirmed = true) => {
        if (!connected || !socketRef.current?.connected || answerRef.current || (ownAnswer && ownAnswer.confirmed !== false) || progress?.status !== "question") return;
        const free = progress.question.mode === "free";
        answerRef.current = free || confirmed;
        setAnswerPending(true);
        setAnswerError(null);
        const submission = free ? {} : { confirmed, revision: ++answerVersionRef.current };
        pendingAnswerRevisionRef.current = submission.revision ?? null;
        if (!free) setOwnAnswer({ questionNumber: progress.question.number, choiceId, ...submission });
        socketRef.current.emit("submit_answer", { code: props.code, playerId: props.playerId, round: roundRef.current, questionNumber: progress.question.number, ...(free ? { text: choiceId } : { choiceId, ...submission }) });
    };

    return (
        <section className="panel" aria-label="Partie et joueurs">
            {joinError && <p className="alert" role="alert">{joinError}</p>}
            {actionError && <p className="alert" role="alert">{actionError}</p>}
            {answerError && <p className="alert" role="alert">{answerError}</p>}
            <div className="lobby-header">
                <h2>{gameStatus === "lobby" ? "Dans la salle" : "La partie"} <span className="badge badge-neutral">{players.length} {players.length > 1 ? "joueurs" : "joueur"}</span></h2>
                <span className="connection-status" role="status">
                    <span className={`status-dot${connected ? " status-dot--connected" : ""}`} aria-hidden="true" />
                    {connected ? "Connecté à la salle" : "Connexion à la salle…"}
                </span>
            </div>
            {playlistName && <p className="field-hint">Playlist de la partie : {playlistName}</p>}
            {props.isHost && gameStatus === "lobby" && <LobbyPlaylistPicker code={props.code} playerId={props.playerId} selectedPlaylist={roomPlaylist} disabled={!connected || pending || readyPending} pending={playlistPending} onSelect={choosePlaylist} />}
            {props.isHost && <HostSpotifyAudio key={`${props.code}:${props.playerId}`} code={props.code} playerId={props.playerId} progress={progress} serverOffsetMs={serverOffsetMs} onReadyChange={setAudioReady} />}
            {gameStatus === "lobby" && (
                <>
                    {!props.isHost && !playlistName && <p className="muted">L’hôte choisit la playlist de la partie.</p>}
                    <ul className="player-list" aria-label="Joueurs inscrits">
                        {players.map((player) => (
                            <li className="player-row" key={player.id}>
                                <span className="avatar" aria-hidden="true">{Array.from(player.nickname)[0]?.toLocaleUpperCase("fr")}</span>
                                <span className="player-name">{player.nickname}</span>
                                <span className="player-badges">
                                    <span className={`badge${player.ready ? " badge-ready" : " badge-neutral"}`}>{player.ready ? "✓ Prêt" : "Pas prêt"}</span>
                                    {player.id === props.hostId && <span className="badge">Hôte</span>}
                                    {player.id === props.playerId && <span className="badge badge-neutral">Toi</span>}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <div className="lobby-readiness">
                        <div role="status"><strong>{readyCount} / {players.length} prêts</strong></div>
                        <button className={`btn ${ownReady ? "btn-secondary" : "btn-primary"}`} type="button" aria-pressed={ownReady} aria-busy={readyPending} disabled={!connected || pending || playlistPending || readyPending} onClick={toggleReady}>{readyPending ? "Enregistrement…" : ownReady ? "Je ne suis plus prêt" : "Je suis prêt ✓"}</button>
                    </div>
                    <div className="lobby-actions">
                        {props.isHost ? (
                            <>
                                <StartGameButton onStart={() => sendCommand("start_game")} disabled={!connected || pending || !audioReady || !roomPlaylist || playlistPending || readyPending || !allReady} pending={pending} />
                                {!allReady && <p className="field-hint">Tous les joueurs doivent être prêts.</p>}
                                {!audioReady && <p className="field-hint">Active le son pour démarrer.</p>}
                                {!roomPlaylist && <p>Choisis une playlist pour démarrer.</p>}
                            </>
                        ) : <p>En attente de l’hôte.</p>}
                    </div>
                </>
            )}
            <div aria-live="polite" className="game-stage">
                {progress?.status === "question" && (
                    <div className="question-state">
                        <div className="music-symbol" aria-hidden="true">♫</div>
                        <p className="eyebrow">Question {progress.question.number} sur {progress.question.total}</p>
                        <h2>{progress.question.prompt ?? "Quel est ce morceau ?"}</h2>
                        {participation && <p className={`answer-participation${participation.answered === participation.total ? " answer-participation--complete" : ""}`} role="status"><span aria-hidden="true">✓</span> {participation.answered} {participation.answered > 1 ? "joueurs" : "joueur"} sur {participation.total} {participation.answered > 1 ? "ont" : "a"} répondu</p>}
                        {progress.question.mode === "free" ? <FreeAnswer key={progress.question.number} question={progress.question} receipt={ownAnswer} pending={answerPending} disabled={!connected} serverOffsetMs={serverOffsetMs} onAnswer={sendAnswer} /> : progress.question.choices ? <QuestionChoices question={progress.question} receipt={ownAnswer} pending={answerPending} disabled={!connected} serverOffsetMs={serverOffsetMs} onAnswer={sendAnswer} /> : <p>Les propositions de cette ancienne partie ne sont pas disponibles. Crée une nouvelle salle pour jouer.</p>}
                        {props.isHost && <button className="btn btn-secondary" disabled={!connected || pending} onClick={() => sendCommand("reveal_answer")}>{pending ? "Clôture…" : "Clore la manche maintenant"}</button>}
                    </div>
                )}
                {progress?.status === "result" && progress.answer && (
                    <div className="question-state">
                        <p className="eyebrow">Réponse · Question {progress.question.number} sur {progress.question.total}</p>
                        <h2 className="answer-title">{progress.answer.title}</h2>
                        <p className="answer-artist">{progress.answer.artist}</p>
                        {progress.question.choices && progress.answer.choiceId && <QuestionChoices question={progress.question} receipt={ownAnswer} pending={false} disabled={true} serverOffsetMs={serverOffsetMs} onAnswer={sendAnswer} correctChoiceId={progress.answer.choiceId} />}
                        {progress.endsAt !== undefined && <RoundCountdown endsAt={progress.endsAt} serverOffsetMs={serverOffsetMs} />}
                        {progress.answer.spotifyUrl && <p><a className="inline-link music-link" href={progress.answer.spotifyUrl} target="_blank" rel="noopener noreferrer">Voir le morceau sur Spotify ↗</a></p>}
                        {ownAnswer?.text && <p className="submitted-answer">Ta réponse : <strong>{ownAnswer.text}</strong></p>}
                        {ownAnswer && <p className={`answer-feedback ${ownRoundScore?.correct ? "answer-feedback--correct" : "answer-feedback--wrong"}`}><span aria-hidden="true">{ownRoundScore?.correct ? "✓" : "✗"}</span> {ownRoundScore?.correct ? `Bonne réponse : +${ownRoundScore.points} points !` : "Ce n’était pas la bonne réponse."}</p>}
                        {progress.scores && <ul className="score-list" aria-label="Scores de la question">{progress.scores.map(score => <li key={score.playerId}><span>{score.nickname}</span><span>+{score.points} · <strong>{score.total} pts</strong></span></li>)}</ul>}
                        {props.isHost ? <button className="btn btn-primary" disabled={!connected || pending} onClick={() => sendCommand("next_question")}>{pending ? "Chargement…" : progress.question.number === progress.question.total ? "Terminer la partie" : "Question suivante"}</button> : <p>En attente de l’hôte pour la suite.</p>}
                    </div>
                )}
                {progress?.status === "result" && !progress.answer && (
                    <div className="question-state">
                        <div className="music-symbol" aria-hidden="true">?</div>
                        <p className="eyebrow">Manche {progress.question.number} sur {progress.question.total} terminée</p>
                        <h2>Manche terminée</h2>
                        <p>Réponses et scores en fin de partie.</p>
                        {progress.endsAt !== undefined && <RoundCountdown endsAt={progress.endsAt} serverOffsetMs={serverOffsetMs} />}
                        {props.isHost && <button className="btn btn-primary" disabled={!connected || pending} onClick={() => sendCommand("next_question")}>{pending ? "Chargement…" : progress.question.number === progress.question.total ? "Voir les réponses et le classement" : "Question suivante"}</button>}
                    </div>
                )}
                {progress?.status === "finished" && (
                    <div className="question-state">
                        <h2>Classement final</h2>
                        {progress.ranking && <ol className="score-list" aria-label="Classement final">{progress.ranking.map(player => <li key={player.playerId}><span><span className="badge badge-neutral">{player.rank}</span> {player.nickname}</span><strong>{player.score} pts</strong></li>)}</ol>}
                        {progress.review && <PersonalGameReview code={props.code} playerId={props.playerId} round={reviewRound} review={progress.review} />}
                        <div className="end-game-actions">
                            {props.isHost ? <button className="btn btn-primary" disabled={!connected || pending} onClick={() => sendCommand("rematch_game")}>{pending ? "Retour au lobby…" : "Revanche avec ces joueurs ↗"}</button> : <p>L’hôte peut proposer une revanche dans cette salle.</p>}
                            <Link href="/create" className="btn btn-secondary">Créer une autre partie</Link>
                        </div>
                    </div>
                )}
                {gameStatus !== "lobby" && !progress && (
                    <div className="question-state">
                        <h2>Cette partie doit être recréée.</h2>
                        <p>Les questions de cette ancienne partie ne sont plus disponibles.</p>
                        <Link href="/create" className="btn btn-primary">Créer une nouvelle partie</Link>
                    </div>
                )}
            </div>
        </section>
    );
}
