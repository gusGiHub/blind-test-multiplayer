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
                        configuration: "La connexion Spotify est indisponible pour le moment.",
                        origin: "Ouvre Spotify depuis l’adresse de l’application.",
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
                <h1>Spotify</h1>
            </div>
            <section className="panel" aria-label="Connexion Spotify">
                {error && <p className="alert" role="alert">{error}</p>}
                {loading ? <p className="muted" role="status">Chargement de Spotify…</p> : !status ? (
                    <button className="btn btn-secondary" onClick={() => { setLoading(true); setError(null); setRefreshKey((key) => key + 1); }}>Réessayer</button>
                ) : !status.configured ? (
                    <>
                        <h2>Connexion indisponible</h2>
                        <p className="muted">Spotify n’est pas encore configuré pour ce site.</p>
                    </>
                ) : wrongOrigin ? (
                    <>
                        <h2>Utilise l’adresse prévue pour Spotify.</h2>
                        <a className="btn btn-primary" href={`${status.appUrl}/spotify`}>Ouvrir {status.appUrl}</a>
                    </>
                ) : status.connected ? (
                    <>
                        <div className="lobby-header">
                            <span className="badge">Spotify connecté</span>
                            <button className="btn btn-secondary" disabled={pending} onClick={() => void disconnect()}>Déconnecter Spotify</button>
                        </div>
                        {status.selectedPlaylist && <p className="selection-note" role="status">Playlist sélectionnée : <strong>{status.selectedPlaylist.name}</strong></p>}
                        {status.selectedPlaylist && <details className="spotify-preview"><summary>Voir un exemple de questions</summary><SpotifyQuestionPreviewPanel key={status.selectedPlaylist.id} playlist={status.selectedPlaylist} disabled={pending} /></details>}
                        <div className="selection-note">
                            <p>{status.playbackAuthorized ? "Compte connecté. Tu peux activer le son dans le lobby." : "Autorise Spotify à lire les extraits, puis choisis ta playlist."}</p>
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
                        <h2>Connecter Spotify</h2>
                        <p className="muted">Un compte Premium est nécessaire pour lire les extraits.</p>
                        <details className="spotify-permissions"><summary>Autorisations demandées</summary><p className="muted">Accès aux playlists et à la lecture audio. Spotify demande aussi l’accès au profil et à l’adresse e-mail pour son lecteur ; ces informations ne sont pas conservées par l’application. Tes playlists ne sont pas modifiées.</p></details>
                        <form action="/api/spotify/login" method="post"><button className="btn btn-primary" type="submit">Connecter mon compte Spotify</button></form>
                    </>
                )}
            </section>
            <p className="spotify-footnote">Tu peux retirer l’accès à l’application depuis ton compte Spotify.</p>
        </main>
    );
}
