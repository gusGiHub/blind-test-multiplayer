'use client';

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import SpotifyPlaylistCard from "./SpotifyPlaylistCard";
import SpotifyQuestionPreviewPanel from "./SpotifyQuestionPreviewPanel";
import type { SpotifyPlaylist } from "@/src/types/spotify";
import { disconnectSpotifyBrowserPlayer } from "@/src/lib/spotifyPlayerSession";

interface SpotifyStatus {
    configured: boolean;
    playbackAuthorized?: boolean;
    missingPlaybackScopes?: string[];
    currentGame?: { code: string; href: string } | null;
    appUrl: string | null;
    connected: boolean;
    selectedPlaylist: SpotifyPlaylist | null;
}
interface PlaylistPage { playlists: SpotifyPlaylist[]; nextOffset: number | null; }

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "La demande a échoué.");
    return data as T;
}

export default function SpotifyPage() {
    const [status, setStatus] = useState<SpotifyStatus | null>(null);
    const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [currentOrigin, setCurrentOrigin] = useState("");
    const pendingRef = useRef(false);

    useEffect(() => {
        const controller = new AbortController();
        const load = async () => {
            try {
                const result = await requestJson<SpotifyStatus>("/api/spotify/status", { signal: controller.signal });
                if (controller.signal.aborted) return;
                setStatus(result);
                setCurrentOrigin(window.location.origin);
                const callbackError = new URLSearchParams(window.location.search).get("error");
                if (callbackError) {
                    const messages: Record<string, string> = {
                        configuration: "Renseigne le Client ID Spotify et l’URL de l’application dans .env.local, puis redémarre le serveur.",
                        origin: "Utilise cette adresse pour connecter Spotify. Les sessions de localhost et 127.0.0.1 sont distinctes.",
                        authorization: "La connexion Spotify a été annulée, a expiré ou a échoué. Tu peux réessayer.",
                    };
                    setError(messages[callbackError] ?? "La connexion Spotify a échoué.");
                    window.history.replaceState(null, "", "/spotify");
                }
                if (result.connected) {
                    const page = await requestJson<PlaylistPage>("/api/spotify/playlists", { signal: controller.signal });
                    if (controller.signal.aborted) return;
                    setPlaylists(page.playlists);
                    setNextOffset(page.nextOffset);
                }
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Impossible de charger Spotify.");
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        };
        void load();
        return () => controller.abort();
    }, [refreshKey]);

    const selectPlaylist = async (playlistId: string) => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setPending(true);
        setError(null);
        try {
            const data = await requestJson<{ selectedPlaylist: SpotifyPlaylist }>("/api/spotify/selection", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playlistId }),
            });
            setStatus((current) => current ? { ...current, selectedPlaylist: data.selectedPlaylist } : current);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de sélectionner cette playlist."); }
        finally { pendingRef.current = false; setPending(false); }
    };

    const loadMore = async () => {
        if (pendingRef.current || nextOffset === null) return;
        pendingRef.current = true;
        setPending(true);
        setError(null);
        try {
            const page = await requestJson<PlaylistPage>(`/api/spotify/playlists?offset=${nextOffset}`);
            setPlaylists((current) => Array.from(new Map([...current, ...page.playlists].map((playlist) => [playlist.id, playlist])).values()));
            setNextOffset(page.nextOffset);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de charger la suite."); }
        finally { pendingRef.current = false; setPending(false); }
    };

    const disconnect = async () => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setPending(true);
        setError(null);
        try {
            await requestJson("/api/spotify/disconnect", { method: "POST" });
            disconnectSpotifyBrowserPlayer();
            setStatus((current) => current ? { ...current, connected: false, selectedPlaylist: null } : current);
            setPlaylists([]);
            setNextOffset(null);
            setRefreshKey((current) => current + 1);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de déconnecter Spotify."); }
        finally { pendingRef.current = false; setPending(false); }
    };

    const wrongOrigin = status?.appUrl && currentOrigin && status.appUrl !== currentOrigin;

    return (
        <main id="main-content" className="page-shell spotify-page">
            {status?.currentGame && <Link className="btn btn-secondary" href={status.currentGame.href}>Retour à ma partie · {status.currentGame.code}</Link>}
            <Link href="/" className="back-link"><span aria-hidden="true">←</span> Retour à l’accueil</Link>
            <div className="game-heading">
                <p className="eyebrow">Ta bibliothèque</p>
                <h1>Tes playlists Spotify.</h1>
                <p className="muted">Connecte ton compte et retrouve tes playlists en lecture seule.</p>
            </div>
            <section className="panel" aria-label="Connexion Spotify">
                {error && <p className="alert" role="alert">{error}</p>}
                {loading ? <p className="muted" role="status">Chargement de Spotify…</p> : !status ? (
                    <button className="btn btn-secondary" onClick={() => { setLoading(true); setError(null); setRefreshKey((key) => key + 1); }}>Réessayer</button>
                ) : !status.configured ? (
                    <>
                        <h2>La configuration Spotify reste à renseigner.</h2>
                        <p className="muted">Ajoute le Client ID dans ton fichier .env.local et enregistre l’URL de retour chez Spotify. Le guide docs/spotify.md détaille les étapes.</p>
                    </>
                ) : wrongOrigin ? (
                    <>
                        <h2>Utilise l’adresse prévue pour Spotify.</h2>
                        <p className="muted">Pour conserver le cookie de session pendant la connexion, ouvre aussi tes parties sur cette adresse.</p>
                        <a className="btn btn-primary" href={`${status.appUrl}/spotify`}>Ouvrir {status.appUrl}</a>
                    </>
                ) : status.connected ? (
                    <>
                        <div className="lobby-header">
                            <span className="badge">Spotify connecté</span>
                            <button className="btn btn-secondary" disabled={pending} onClick={() => void disconnect()}>Déconnecter Spotify</button>
                        </div>
                        {status.selectedPlaylist && <p className="selection-note" role="status">Playlist sélectionnée : <strong>{status.selectedPlaylist.name}</strong></p>}
                        {status.selectedPlaylist && <SpotifyQuestionPreviewPanel key={status.selectedPlaylist.id} playlist={status.selectedPlaylist} disabled={pending} />}
                        <div className="selection-note">
                            <p>{status.playbackAuthorized ? "Autorisations audio accordées. Retourne dans ta partie et active le son sur ce navigateur." : "Ton compte est connecté, mais cette connexion ne dispose pas de toutes les autorisations audio. Autorise la lecture ci-dessous, puis sélectionne à nouveau ta playlist."}</p>
                            {!status.playbackAuthorized && <>
                                {Boolean(status.missingPlaybackScopes?.length) && <details><summary>Détail des permissions manquantes</summary><p>{status.missingPlaybackScopes?.join(", ")}</p></details>}
                                <form action="/api/spotify/login" method="post"><button className="btn btn-secondary" type="submit">Autoriser la lecture Spotify</button></form>
                            </>}
                        </div>
                        <h2>Choisis une playlist</h2>
                        {playlists.length === 0 ? <p className="muted">Aucune playlist chargée. Si une erreur apparaît, réessaie ou reconnecte ton compte.</p> : (
                            <ul className="spotify-list">
                                {playlists.map((playlist) => (
                                    <SpotifyPlaylistCard
                                        key={playlist.id}
                                        playlist={playlist}
                                        selected={status.selectedPlaylist?.id === playlist.id}
                                        disabled={pending}
                                        onSelect={(id) => void selectPlaylist(id)}
                                    />
                                ))}
                            </ul>
                        )}
                        <div className="actions">
                            {nextOffset !== null && <button className="btn btn-secondary" disabled={pending} onClick={() => void loadMore()}>{pending ? "Chargement…" : "Afficher la suite"}</button>}
                            <button className="btn btn-secondary" disabled={pending} onClick={() => { setLoading(true); setError(null); setRefreshKey((key) => key + 1); }}>Actualiser</button>
                        </div>
                    </>
                ) : (
                    <>
                        <h2>Retrouve tes playlists.</h2>
                        <p className="muted">Spotify te demandera de consulter tes playlists et de jouer le son chez l’hôte. Son lecteur nécessite aussi les permissions de profil et d’adresse e-mail ; l’application ne récupère ni ne conserve ces informations. Aucun droit de modification des playlists n’est demandé.</p>
                        <form action="/api/spotify/login" method="post"><button className="btn btn-primary" type="submit">Connecter mon compte Spotify</button></form>
                    </>
                )}
            </section>
            <p className="spotify-footnote">La sélection est conservée dans ta session pour préparer les questions et lire les extraits chez l’hôte. La déconnexion retire les jetons de cette application ; les autorisations Spotify peuvent être retirées dans ton compte Spotify.</p>
        </main>
    );
}
