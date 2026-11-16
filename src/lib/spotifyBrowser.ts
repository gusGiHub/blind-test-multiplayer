export interface SpotifyBrowserPlayer {
    connect(): Promise<boolean>;
    disconnect(): void;
    activateElement(): Promise<void>;
    pause(): Promise<void>;
    addListener(event: string, callback: (data: { device_id?: string; message?: string }) => void): boolean;
}
interface PlayerOptions { name: string; volume: number; enableMediaSession: boolean; getOAuthToken: (callback: (token: string) => void) => void; }

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const aborted = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
        signal.addEventListener("abort", aborted, { once: true });
    });
}

/** Keep the SDK device alive while Spotify Connect finishes registering it. */
export async function registerSpotifyBrowserDevice(register: () => Promise<unknown>, signal: AbortSignal,
    wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForRetry,
    recover?: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try { await register(); signal.throwIfAborted(); return; }
        catch (error) {
            signal.throwIfAborted();
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "DEVICE_UNAVAILABLE") throw error;
            if (attempt === 3) {
                if (!recover) throw error;
                await recover();
                signal.throwIfAborted();
                return;
            }
            await wait(400 * 2 ** attempt, signal);
        }
    }
}
declare global {
    interface Window {
        Spotify?: { Player: new (options: PlayerOptions) => SpotifyBrowserPlayer };
        onSpotifyWebPlaybackSDKReady?: () => void;
    }
}
let sdkPromise: Promise<void> | undefined;
export function loadSpotifyBrowserSdk(): Promise<void> {
    if (window.Spotify) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { sdkPromise = undefined; reject(new Error("Le lecteur Spotify ne se charge pas. Vérifie ta connexion puis réessaie.")); }, 15000);
        const previous = window.onSpotifyWebPlaybackSDKReady;
        window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timeout); previous?.(); resolve(); };
        let script = document.getElementById("spotify-web-playback-sdk") as HTMLScriptElement | null;
        if (!script) {
            script = document.createElement("script");
            script.id = "spotify-web-playback-sdk";
            script.src = "https://sdk.scdn.co/spotify-player.js";
            script.async = true;
            script.onerror = () => { clearTimeout(timeout); script?.remove(); sdkPromise = undefined; reject(new Error("Impossible de charger le lecteur Spotify.")); };
            document.head.appendChild(script);
        }
    });
    return sdkPromise;
}
