import Link from "next/link";
import type { GameSnapshot } from "@/src/types/gameProgress";
import GameLobby from "./GameLobby";
import { DEFAULT_GAME_SETTINGS } from "@/src/lib/gameSettings";
import { readGameAccess } from "@/src/lib/gameAccess";

export default async function GamePage({ params, searchParams }: {
    params: Promise<{ code: string }>;
    searchParams: Promise<{ playerId?: string }>;
}) {
    const { code } = await params;
    const { playerId } = await searchParams;
    const response = await readGameAccess(code, playerId);

    if ([400, 401, 403].includes(response.status)) {
        return (
            <main id="main-content" className="page-shell page-shell--narrow">
                <section className="panel">
                    <p className="eyebrow">Accès à la salle</p>
                    <h1>Rejoins la partie avec ta session.</h1>
                    <p className="muted">Cette session ne permet pas d’accéder à ce joueur. Utilise le navigateur dans lequel tu as créé ou rejoint la partie.</p>
                    <Link className="btn btn-primary" href="/join">Rejoindre une partie</Link>
                </section>
            </main>
        );
    }

    if (response.status === 503) {
        return <main id="main-content" className="page-shell page-shell--narrow"><section className="panel">
            <h1>La salle est momentanément indisponible.</h1>
            <p className="muted">Réessaie dans quelques instants pour retrouver ta partie.</p>
            <Link className="btn btn-primary" href={`/game/${encodeURIComponent(code)}?playerId=${encodeURIComponent(playerId ?? "")}`}>Réessayer</Link>
        </section></main>;
    }

    if (!response.ok) {
        return (
            <main id="main-content" className="page-shell page-shell--narrow">
                <section className="panel">
                    <p className="eyebrow">Salle introuvable</p>
                    <h1>Cette partie est introuvable.</h1>
                    <p className="muted">Vérifie le code {code} auprès de l’hôte.</p>
                    <Link className="btn btn-primary" href="/join">Essayer un autre code</Link>
                </section>
            </main>
        );
    }

    const gameData: GameSnapshot = await response.json();
    const currentPlayer = gameData.players.find((player) => player.id === playerId);
    if (!currentPlayer) {
        return (
            <main id="main-content" className="page-shell page-shell--narrow">
                <section className="panel">
                    <p className="eyebrow">Une étape manque</p>
                    <h1>Rejoins d’abord la partie.</h1>
                    <p className="muted">Choisis ton pseudo pour retrouver les autres joueurs.</p>
                    <Link className="btn btn-primary" href="/join">Rejoindre une partie</Link>
                </section>
            </main>
        );
    }

    const { game, players } = gameData;
    const host = players.find((player) => player.id === game.hostId);
    const settings = game.settings ?? DEFAULT_GAME_SETTINGS;

    return (
        <main id="main-content" className="page-shell">
            <div className="game-heading">
                <h1>Partie de {host?.nickname ?? "l’hôte"}</h1>
            </div>
            <div className="game-grid">
                <aside className="panel room-info" aria-label="Informations de la partie">
                    <div>
                        <p className="room-code-label">Code de la partie</p>
                        <div className="room-code">{code}</div>
                        <p className="room-code-help">Partage ce code avec tes amis.</p>
                    </div>
                    <dl className="room-details">
                        <div><dt>Format</dt><dd>{game.questionCount} questions</dd></div>
                        <div><dt>Mode</dt><dd>{settings.mode === "qcm" ? "QCM" : "Réponse libre"}</dd></div>
                        <div><dt>Réponses</dt><dd>{settings.revealMode === "end" ? "À la fin" : "Après chaque titre"}</dd></div>
                        <div><dt>Points</dt><dd>{settings.scoring === "speed" ? "10 + bonus rapidité" : "10 par bonne réponse"}</dd></div>
                        <div><dt>Extrait</dt><dd>{settings.excerptSeconds} s · {settings.excerptPosition === "start" ? "Début" : settings.excerptPosition === "middle" ? "Milieu" : "Aléatoire"}</dd></div>
                        <div><dt>Pause</dt><dd>{settings.pauseSeconds} s</dd></div>
                        <div><dt>Réponse</dt><dd>{settings.responseSeconds ?? settings.excerptSeconds} s</dd></div>
                        <div><dt>Hôte</dt><dd>{host?.nickname ?? "Hôte"}</dd></div>
                    </dl>
                </aside>
                <GameLobby initialRound={game.round} initialPlayers={players} initialStatus={game.status} initialProgress={gameData.progress} initialPlaylistName={game.playlist?.name} initialPlaylist={game.playlist} initialPlaylistRevision={game.playlistRevision} initialOwnAnswer={gameData.ownAnswer} initialServerTime={gameData.serverTime} isHost={currentPlayer.id === game.hostId} hostId={game.hostId} code={code} playerId={currentPlayer.id} nickname={currentPlayer.nickname} />
            </div>
        </main>
    );
}
