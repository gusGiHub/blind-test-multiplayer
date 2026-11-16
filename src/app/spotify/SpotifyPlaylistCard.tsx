'use client';

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { SpotifyPlaylist, SpotifyPlaylistTrack } from "@/src/types/spotify";

interface PlaylistCardProps {
    playlist: SpotifyPlaylist;
    selected: boolean;
    disabled: boolean;
    onSelect: (playlistId: string) => void;
}
interface TrackPage { tracks: SpotifyPlaylistTrack[]; nextOffset: number | null; }

function formatDuration(durationMs: number | null): string {
    if (durationMs === null) return "—";
    const seconds = Math.floor(durationMs / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function SpotifyPlaylistCard({ playlist, selected, disabled, onSelect }: PlaylistCardProps) {
    const [expanded, setExpanded] = useState(false);
    const [tracks, setTracks] = useState<SpotifyPlaylistTrack[] | null>(null);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const loadingRef = useRef(false);
    const panelId = `playlist-tracks-${playlist.id}`;

    useEffect(() => () => controllerRef.current?.abort(), []);

    const loadTracks = async (offset: number) => {
        if (loadingRef.current) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        loadingRef.current = true;
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`/api/spotify/playlists/${encodeURIComponent(playlist.id)}/tracks?offset=${offset}`, {
                cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? "Impossible de charger les morceaux.");
            if (controller.signal.aborted) return;
            const page = data as TrackPage;
            setTracks((current) => offset === 0 ? page.tracks : [...(current ?? []), ...page.tracks]);
            setNextOffset(page.nextOffset);
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error && cause.name !== "TimeoutError"
                ? cause.message : "Le chargement a pris trop de temps. Réessaie.");
        } finally {
            loadingRef.current = false;
            if (!controller.signal.aborted) setLoading(false);
        }
    };

    const toggleTracks = () => {
        if (!expanded && tracks === null) void loadTracks(0);
        setExpanded((current) => !current);
    };

    return (
        <li className="spotify-card">
            <div className="spotify-card-heading">
                <a className="playlist-cover" href={playlist.url} target="_blank" rel="noopener noreferrer" aria-label={`Ouvrir ${playlist.name} sur Spotify`}>
                    {playlist.coverUrl && failedCoverUrl !== playlist.coverUrl ? (
                        <Image src={playlist.coverUrl} width={64} height={64} alt={`Pochette de ${playlist.name}`} unoptimized loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedCoverUrl(playlist.coverUrl)} />
                    ) : <span className="playlist-cover-placeholder" aria-label="Pochette indisponible">♫</span>}
                </a>
                <div className="spotify-details">
                    <h3>{playlist.name || "Playlist sans nom"}</h3>
                    <p>{playlist.ownerName || "Spotify"}{playlist.trackCount !== null ? ` · ${playlist.trackCount} titres` : ""}</p>
                    <a className="inline-link music-link" href={playlist.url} target="_blank" rel="noopener noreferrer">Ouvrir sur Spotify ↗</a>
                </div>
                <button className="btn btn-secondary playlist-select" disabled={disabled} aria-pressed={selected} onClick={() => onSelect(playlist.id)}>{selected ? "Sélectionnée" : "Choisir"}</button>
            </div>
            <button className="playlist-expand" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={toggleTracks}>
                {expanded ? "Masquer les morceaux" : "Voir les morceaux"}<span aria-hidden="true">{expanded ? "−" : "+"}</span>
            </button>
            <div id={panelId} hidden={!expanded} className="playlist-track-panel" aria-busy={loading}>
                {error && <p className="alert" role="alert">{error}</p>}
                {tracks?.length === 0 && <p className="muted">Cette playlist ne contient aucun morceau.</p>}
                {tracks && tracks.length > 0 && (
                    <ol className="track-list" aria-label={`Morceaux de ${playlist.name}`}>
                        {tracks.map((track) => (
                            <li className="track-row" key={track.position} value={track.position}>
                                <span className="track-position" aria-hidden="true">{track.position}</span>
                                <div className="track-details">
                                    {track.url ? <a href={track.url} target="_blank" rel="noopener noreferrer" className="track-title" aria-label={`${track.name}, ouvrir sur Spotify`}>{track.name} <span aria-hidden="true">↗</span></a> : <span className="track-title">{track.name}</span>}
                                    {track.artists.length > 0 && <p>{track.artists.join(", ")}</p>}
                                    {track.albumName && <p className="track-album">{track.albumName}</p>}
                                    {!track.available && <span className="badge badge-neutral">Indisponible ou fichier local</span>}
                                </div>
                                <span className="track-duration" aria-label="Durée">{formatDuration(track.durationMs)}</span>
                            </li>
                        ))}
                    </ol>
                )}
                {loading && <p className="muted" role="status">Chargement des morceaux…</p>}
                {!loading && error && <button className="btn btn-secondary" onClick={() => void loadTracks(tracks === null ? 0 : nextOffset ?? 0)}>Réessayer</button>}
                {!loading && !error && nextOffset !== null && <button className="btn btn-secondary" onClick={() => void loadTracks(nextOffset)}>Afficher les morceaux suivants</button>}
            </div>
        </li>
    );
}
