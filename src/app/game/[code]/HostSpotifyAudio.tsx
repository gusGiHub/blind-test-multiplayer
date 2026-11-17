'use client';
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadSpotifyBrowserSdk, registerSpotifyBrowserDevice, type SpotifyBrowserPlayer } from "@/src/lib/spotifyBrowser";
import type { GameProgress } from "@/src/types/gameProgress";
import type { SpotifyPlaybackDiagnostic } from "@/src/types/spotify";
import { getSpotifyPlayerSession, type SpotifyPlayerLease } from "@/src/lib/spotifyPlayerSession";

export default function HostSpotifyAudio({ code, playerId, progress, serverOffsetMs, onReadyChange }: { code: string; playerId: string; progress: GameProgress | null; serverOffsetMs: number; onReadyChange?: (ready: boolean) => void }) {
    const [sdkReady, setSdkReady] = useState(false);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [diagnostic, setDiagnostic] = useState<SpotifyPlaybackDiagnostic | null>(null);
    const [attempt, setAttempt] = useState(0);
    const playerRef = useRef<SpotifyBrowserPlayer | null>(null);
    const leaseRef = useRef<SpotifyPlayerLease | null>(null);
    const deviceRef = useRef<string | null>(null);
    const aliveRef = useRef(true);
    const readyVersion = useRef(0);
    const sdkDeviceRef = useRef<string | null>(null);
    const registrationRef = useRef<AbortController | null>(null);
    const activationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearActivationTimer = () => { if (activationTimer.current !== null) clearTimeout(activationTimer.current); activationTimer.current = null; };
    const cancelRegistration = () => { registrationRef.current?.abort(); registrationRef.current = null; clearActivationTimer(); };
    const request = async (route: string, body: object, keepalive = false, signal?: AbortSignal) => {
        const response = await fetch(`/api/games/${code}/playback/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId, ...body }), cache: "no-store", keepalive, signal });
        const data = await response.json();
        if (!response.ok) {
            if (data.diagnostic && aliveRef.current && !signal?.aborted && !keepalive) setDiagnostic(data.diagnostic);
            throw Object.assign(new Error(data.error ?? "Le lecteur Spotify ne répond pas."), { code: data.code, diagnostic: data.diagnostic });
        }
        return data;
    };
    const unregister = (id: string) => { void request("device", { deviceId: null, expectedDeviceId: id }, true).catch(() => {}); };
    useEffect(() => {
        aliveRef.current = true;
        void loadSpotifyBrowserSdk().then(() => { if (aliveRef.current) setSdkReady(true); }).catch(cause => { if (aliveRef.current) setError(cause.message); });
        return () => {
            aliveRef.current = false;
            cancelRegistration();
            onReadyChange?.(false);
            if (deviceRef.current) unregister(deviceRef.current);
            deviceRef.current = null;
            sdkDeviceRef.current = null;
            leaseRef.current?.release();
            leaseRef.current = null;
            playerRef.current = null;
        };
        // Session and game identity stay fixed for this mounted player.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code, playerId]);

    const registerDevice = (player: SpotifyBrowserPlayer, id: string) => {
        if (!aliveRef.current || playerRef.current !== player || !leaseRef.current?.isCurrent()) return;
        registrationRef.current?.abort();
        const controller = new AbortController();
        registrationRef.current = controller;
        const version = ++readyVersion.current;
        setPending(true);
        void registerSpotifyBrowserDevice(
            () => request("device", { deviceId: id }, false, controller.signal), controller.signal, undefined,
            () => request("device", { deviceId: id, recover: true }, false, controller.signal)
        ).then(() => {
            if (!aliveRef.current || playerRef.current !== player || !leaseRef.current?.isCurrent() || readyVersion.current !== version) {
                if (playerRef.current !== player || sdkDeviceRef.current !== id) unregister(id);
                return;
            }
            deviceRef.current = id;
            setDeviceId(id);
            onReadyChange?.(true);
            setError(null);
            setDiagnostic(null);
            setPending(false);
            clearActivationTimer();
        }).catch(cause => {
            if (controller.signal.aborted || !aliveRef.current || playerRef.current !== player || readyVersion.current !== version) return;
            if (cause.diagnostic) setDiagnostic(cause.diagnostic);
            clearActivationTimer();
            setError(cause.code === "DEVICE_UNAVAILABLE" ? "Spotify refuse encore l’activation après renouvellement de la connexion. Réessaie dans 30 secondes ; si le problème persiste, indique ce message pour poursuivre le diagnostic." : cause.message);
            setPending(false);
            setDeviceId(null);
            onReadyChange?.(false);
        });
    };

    const createPlayer = (Player: NonNullable<Window["Spotify"]>["Player"]) => {
        const lease = getSpotifyPlayerSession().acquire(Player, {
            getToken: async () => (await request("token", {})).accessToken,
            onTokenError(cause) { if (aliveRef.current && leaseRef.current?.isCurrent()) { cancelRegistration(); setError(cause.message); setPending(false); } },
            onReady(id) {
                if (!aliveRef.current || playerRef.current !== player) return;
                sdkDeviceRef.current = id;
                registerDevice(player, id);
            },
            onNotReady() {
                if (!aliveRef.current || playerRef.current !== player) return;
                cancelRegistration();
                sdkDeviceRef.current = null;
                if (deviceRef.current) unregister(deviceRef.current);
                deviceRef.current = null;
                readyVersion.current++;
                setDeviceId(null);
                onReadyChange?.(false);
                setPending(false);
                setError("Le lecteur Spotify est hors ligne. Réactive le son.");
            },
            onError(event, data) {
                if (!aliveRef.current || playerRef.current !== player) return;
                setPending(false);
                if (["initialization_error", "authentication_error", "account_error"].includes(event)) {
                    cancelRegistration();
                    sdkDeviceRef.current = null;
                    if (deviceRef.current) unregister(deviceRef.current);
                    deviceRef.current = null;
                    readyVersion.current++;
                    setDeviceId(null);
                    onReadyChange?.(false);
                    leaseRef.current?.release();
                    leaseRef.current = null;
                    playerRef.current = null;
                }
                const messages: Record<string, string> = {
                    initialization_error: "Ce navigateur ne permet pas la lecture Spotify protégée. Autorise les contenus protégés ou essaie un navigateur compatible.",
                    authentication_error: /scope/i.test(data?.message ?? "")
                        ? "Les autorisations Spotify sont incomplètes. Ouvre « Compte et autorisations Spotify », autorise à nouveau la lecture et sélectionne ta playlist."
                        : "Spotify refuse l’authentification du lecteur. Reconnecte ton compte dans « Compte et autorisations Spotify », puis réactive le son.",
                    account_error: "Spotify refuse ce compte pour la lecture. Vérifie que le compte connecté chez l’hôte dispose de Premium.",
                    playback_error: "Spotify ne parvient pas à lire cet extrait. Vérifie ta connexion, puis clique sur « Reprendre l’extrait ». Si cela persiste, réactive le son.",
                    autoplay_failed: "Le navigateur a bloqué la lecture automatique. Clique sur « Réactiver le son » pour autoriser la lecture.",
                };
                // Never display raw SDK errors: they may contain account or token details.
                setError(current => current ?? messages[event]);
            },
        });
        const player = lease.player;
        leaseRef.current = lease;
        playerRef.current = player;
        sdkDeviceRef.current = lease.deviceId;
        return player;
    };

    const activate = () => {
        if (!sdkReady || !window.Spotify || pending) return;
        cancelRegistration();
        readyVersion.current++;
        onReadyChange?.(false);
        setDeviceId(null);
        setError(null);
        setPending(true);
        // Reuse the same Connect device after a transient API failure.
        const player = playerRef.current && leaseRef.current?.isCurrent() ? playerRef.current : createPlayer(window.Spotify.Player);
        const version = readyVersion.current;
        activationTimer.current = setTimeout(() => {
            if (!aliveRef.current || playerRef.current !== player) return;
            registrationRef.current?.abort();
            readyVersion.current++;
            setPending(false);
            setDeviceId(null);
            onReadyChange?.(false);
            setError("L’activation Spotify prend trop de temps. Clique sur « Réessayer l’activation ».");
        }, 20000);
        // This must run directly in the user click to satisfy browser autoplay rules.
        void player.activateElement().catch(() => { if (aliveRef.current && playerRef.current === player) setError("Le navigateur demande un clic pour autoriser le son."); });
        if (sdkDeviceRef.current) registerDevice(player, sdkDeviceRef.current);
        else void leaseRef.current!.connect().then(connected => {
            if (!connected && aliveRef.current && playerRef.current === player && readyVersion.current === version) {
                cancelRegistration(); setPending(false); setError(current => current ?? "Le lecteur Spotify ne peut pas se connecter. Réessaie l’activation.");
            }
        }).catch(() => { if (aliveRef.current && playerRef.current === player && readyVersion.current === version) { cancelRegistration(); setPending(false); setError("Impossible de connecter le lecteur Spotify. Réessaie l’activation."); } });
    };

    const phase = progress?.status;
    const number = progress && progress.status !== "finished" ? progress.question.number : 0;
    const startsAt = progress?.status === "question" ? progress.question.startsAt : undefined;
    const endsAt = progress?.status === "question" ? progress.question.audioEndsAt ?? progress.question.endsAt : undefined;
    const localAudio = progress?.status === "question" ? progress.question.audioPath : undefined;
    useEffect(() => {
        const player = playerRef.current;
        const lease = leaseRef.current;
        if (!player || !deviceId || !lease?.isCurrent()) return;
        if (phase !== "question" || !startsAt || !endsAt || localAudio) { void player.pause().catch(() => {}); return; }
        if (Date.now() + serverOffsetMs >= endsAt) { void player.pause().catch(() => {}); return; }
        let current = true;
        const start = setTimeout(() => {
            if (!current || !lease.isCurrent()) return;
            void request("play", { questionNumber: number }).then(() => {
                if (current && Date.now() + serverOffsetMs >= endsAt) void player.pause().catch(() => {});
            }).catch(cause => { if (current && aliveRef.current) {
                if (cause.diagnostic) setDiagnostic(cause.diagnostic);
                setError(cause.message);
                if (cause.code === "DEVICE_UNAVAILABLE" && playerRef.current === player) {
                    if (deviceRef.current) unregister(deviceRef.current);
                    deviceRef.current = null;
                    readyVersion.current++;
                    setDeviceId(null);
                    onReadyChange?.(false);
                }
            } });
        }, Math.max(0, startsAt - Date.now() - serverOffsetMs));
        const stop = setTimeout(() => { if (!current || !lease.isCurrent()) return; void player.pause().catch(() => { if (current && aliveRef.current) setError("Impossible de mettre Spotify en pause. Mets la lecture en pause dans Spotify."); }); }, Math.max(0, endsAt - Date.now() - serverOffsetMs));
        return () => { current = false; clearTimeout(start); clearTimeout(stop); };
        // request is scoped to this game's immutable identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, number, startsAt, endsAt, localAudio, deviceId, serverOffsetMs, attempt, code, playerId]);

    return <section className="host-audio" aria-label="Son de l’hôte">
        <div className="lobby-header"><strong>Son chez l’hôte</strong><span className="badge badge-neutral">{deviceId ? "Lecteur prêt" : pending ? "Connexion…" : "À activer"}</span></div>
        <p className="field-hint">Le son est joué sur cet appareil. Spotify Premium requis.</p>
        {error && <p className="alert" role="alert">{error}</p>}
        {error && diagnostic && <details className="selection-note">
            <summary>Dernier diagnostic Spotify</summary>
            <p>Opération : {diagnostic.operation} · HTTP Spotify : {diagnostic.spotifyStatus} · Motif : {diagnostic.reason} · Récupération : {diagnostic.recovery ? "oui" : "non"}</p>
        </details>}
        <div className="actions">
            <button className="btn btn-secondary" type="button" disabled={!sdkReady || pending} onClick={activate}>{pending ? "Activation…" : deviceId ? "Réactiver le son" : error ? "Réessayer l’activation" : "Activer le son Spotify"}</button>
            {deviceId && phase === "question" && <button className="btn btn-secondary" onClick={() => { setError(null); setAttempt(value => value + 1); }}>Reprendre l’extrait</button>}
            {!sdkReady && error && <button className="btn btn-secondary" onClick={() => { setError(null); void loadSpotifyBrowserSdk().then(() => setSdkReady(true)).catch(cause => setError(cause.message)); }}>Recharger le lecteur</button>}
            <Link className="inline-link" href="/spotify">Compte et autorisations Spotify</Link>
        </div>
    </section>;
}
