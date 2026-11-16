'use client';
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import SpotifyPlaylistCard from "../../spotify/SpotifyPlaylistCard";
import type { SpotifyPlaylist } from "@/src/types/spotify";
import type { Game } from "@/src/types/game";

interface Connection { configured: boolean; connected: boolean; playbackAuthorized?: boolean; appUrl: string | null; }
interface PlaylistPage { playlists: SpotifyPlaylist[]; nextOffset: number | null; }
async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Impossible de charger les playlists.");
    return data;
}

export default function LobbyPlaylistPicker({ code, playerId, selectedPlaylist, disabled, pending, onSelect }: {
    code: string; playerId: string; selectedPlaylist: Game["playlist"] | null; disabled: boolean; pending: boolean; onSelect: (id: string) => void;
}) {
    const [connection, setConnection] = useState<Connection | null>(null);
    const [origin, setOrigin] = useState("");
    const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [expanded, setExpanded] = useState(!selectedPlaylist);
    const [error, setError] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    const moreRef = useRef(false);
    const controllerRef = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        controllerRef.current = controller;
        void (async () => {
            try {
                const status = await requestJson<Connection>("/api/spotify/status", controller.signal);
                if (controller.signal.aborted) return;
                setConnection(status);
                setOrigin(window.location.origin);
                if (status.configured && status.connected) {
                    const page = await requestJson<PlaylistPage>("/api/spotify/playlists", controller.signal);
                    if (controller.signal.aborted) return;
                    setPlaylists(page.playlists);
                    setNextOffset(page.nextOffset);
                }
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Impossible de charger Spotify.");
            } finally { if (!controller.signal.aborted) setLoading(false); }
        })();
        return () => controller.abort();
    }, [refresh]);
    const loadMore = async () => {
        if (moreRef.current || nextOffset === null || disabled || pending) return;
        moreRef.current = true;
        setLoadingMore(true);
        setError(null);
        try {
            const signal = controllerRef.current?.signal;
            const page = await requestJson<PlaylistPage>(`/api/spotify/playlists?offset=${nextOffset}`, signal);
            if (signal?.aborted) return;
            setPlaylists(current => Array.from(new Map([...current, ...page.playlists].map(playlist => [playlist.id, playlist])).values()));
            setNextOffset(page.nextOffset);
        } catch (cause) { if (!controllerRef.current?.signal.aborted) setError(cause instanceof Error ? cause.message : "Impossible de charger la suite."); }
        finally { moreRef.current = false; if (!controllerRef.current?.signal.aborted) setLoadingMore(false); }
    };
    const wrongOrigin = connection?.appUrl && origin && connection.appUrl !== origin;
    return <section className="lobby-playlist-picker" aria-label="Playlist de la partie">
        <div className="lobby-header"><h3>Playlist de la partie</h3>{connection?.connected && <span className="badge badge-neutral">Spotify connecté</span>}</div>
        <p className="selection-note">{selectedPlaylist ? <>Choix de la salle : <strong>{selectedPlaylist.name}</strong></> : "Aucune playlist choisie pour cette salle."}</p>
        {error && <p className="alert" role="alert">{error}</p>}
        {loading ? <p role="status" className="muted">Chargement des playlists…</p> : !connection ? <p className="muted">Impossible de vérifier la connexion Spotify. Réessaie dans quelques instants.</p> : !connection.configured ? <p>La connexion Spotify doit être configurée. <Link className="inline-link" href="/spotify">Ouvrir les paramètres Spotify</Link></p> : wrongOrigin ? <p>Pour connecter Spotify, utilise l’adresse {connection.appUrl}. <Link className="inline-link" href="/spotify">Vérifier la connexion</Link></p> : <>
            {(!connection.connected || !connection.playbackAuthorized) && <form action="/api/spotify/login" method="post">
                <input type="hidden" name="gameCode" value={code} /><input type="hidden" name="playerId" value={playerId} />
                <p className="field-hint">{connection.connected ? "Autorise la lecture audio pour jouer les extraits chez toi." : "Connecte ton compte Spotify pour retrouver tes playlists. Tu reviendras dans ce lobby après la connexion."}</p>
                <button className="btn btn-secondary" disabled={disabled || pending} type="submit">{connection.connected ? "Autoriser la lecture Spotify" : "Connecter Spotify"}</button>
            </form>}
            {connection.connected && <>
                <button className="btn btn-secondary" type="button" disabled={disabled || pending} onClick={() => setExpanded(value => !value)}>{expanded ? "Masquer les playlists" : "Choisir ou changer la playlist"}</button>
                {expanded && <>
                    {playlists.length ? <ul className="spotify-list lobby-playlist-list">{playlists.map(playlist => <SpotifyPlaylistCard key={playlist.id} playlist={playlist} selected={selectedPlaylist?.id === playlist.id} disabled={disabled || pending} onSelect={id => { if (!disabled && !pending) onSelect(id); }} />)}</ul> : <p className="muted">Aucune playlist chargée pour ce compte.</p>}
                    {nextOffset !== null && <button className="btn btn-secondary" disabled={disabled || pending || loadingMore} type="button" onClick={() => void loadMore()}>{loadingMore ? "Chargement…" : "Afficher la suite"}</button>}
                </>}
            </>}
        </>}
        {pending && <p className="muted" role="status">Enregistrement du choix…</p>}
        {error && <button className="btn btn-secondary" type="button" disabled={disabled || pending || loading} onClick={() => { setError(null); setLoading(true); setRefresh(value => value + 1); }}>Réessayer</button>}
    </section>;
}
