import type { SpotifyBrowserPlayer } from "./spotifyBrowser";

type PlayerConstructor = NonNullable<Window["Spotify"]>["Player"];
type PlayerEvent = { device_id?: string; message?: string };
interface Binding {
    getToken: () => Promise<string>;
    onReady: (id: string) => void;
    onNotReady: () => void;
    onError: (event: string, data: PlayerEvent) => void;
    onTokenError: (error: Error) => void;
}
export interface SpotifyPlayerLease {
    player: SpotifyBrowserPlayer;
    deviceId: string | null;
    isCurrent(): boolean;
    connect(): Promise<boolean>;
    release(): void;
}

/** One SDK instance per tab; room bindings can change without replacing the device. */
export function createSpotifyPlayerSession() {
    let player: SpotifyBrowserPlayer | null = null;
    let deviceId: string | null = null;
    let binding: Binding | null = null;
    let tokenProvider: Binding["getToken"] | null = null;
    let connecting: Promise<boolean> | null = null;
    let generation = 0;
    const destroy = () => {
        const previous = player;
        player = null; deviceId = null; connecting = null; generation++;
        previous?.disconnect();
    };
    const reset = () => {
        binding?.onNotReady();
        binding = null; tokenProvider = null;
        destroy();
    };
    return {
        reset,
        acquire(Player: PlayerConstructor, next: Binding): SpotifyPlayerLease {
            if (binding && binding !== next) binding.onNotReady();
            binding = next;
            tokenProvider = next.getToken;
            if (!player) {
                const version = ++generation;
                const created = new Player({
                    name: "Blind Test — lecteur de l’hôte", volume: 0.7, enableMediaSession: false,
                    getOAuthToken(callback) {
                        const getToken = tokenProvider;
                        if (!getToken) { callback(""); return; }
                        void getToken().then(token => callback(generation === version ? token : "")).catch(error => {
                            if (generation === version) binding?.onTokenError(error);
                            callback("");
                        });
                    },
                });
                player = created;
                const current = () => player === created && generation === version;
                created.addListener("ready", data => {
                    if (!current() || !data?.device_id) return;
                    deviceId = data.device_id;
                    binding?.onReady(deviceId);
                });
                created.addListener("not_ready", () => {
                    if (!current()) return;
                    deviceId = null;
                    binding?.onNotReady();
                });
                for (const event of ["initialization_error", "authentication_error", "account_error", "playback_error", "autoplay_failed"]) {
                    created.addListener(event, data => {
                        if (!current()) return;
                        binding?.onError(event, data ?? {});
                        if (["initialization_error", "authentication_error", "account_error"].includes(event)) {
                            binding = null; tokenProvider = null; destroy();
                        }
                    });
                }
            }
            const leasedPlayer = player;
            const isCurrent = () => binding === next && player === leasedPlayer;
            return {
                player: leasedPlayer,
                get deviceId() { return isCurrent() ? deviceId : null; },
                isCurrent,
                connect() {
                    if (!isCurrent()) return Promise.resolve(false);
                    if (deviceId) return Promise.resolve(true);
                    if (connecting) return connecting;
                    const promise = leasedPlayer.connect();
                    connecting = promise;
                    void promise.finally(() => { if (connecting === promise) connecting = null; }).catch(() => {});
                    return promise;
                },
                release() {
                    if (!isCurrent()) return;
                    binding = null;
                    // Retain the last protected token provider for SDK renewal while idle.
                    void leasedPlayer.pause().catch(() => {});
                },
            };
        },
    };
}

declare global {
    interface Window { blindTestSpotifyPlayerSession?: ReturnType<typeof createSpotifyPlayerSession>; }
}
export function getSpotifyPlayerSession() {
    if (!window.blindTestSpotifyPlayerSession) {
        window.blindTestSpotifyPlayerSession = createSpotifyPlayerSession();
        window.addEventListener("pagehide", () => window.blindTestSpotifyPlayerSession?.reset());
    }
    return window.blindTestSpotifyPlayerSession;
}
export function disconnectSpotifyBrowserPlayer() {
    window.blindTestSpotifyPlayerSession?.reset();
}
