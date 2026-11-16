export interface SpotifyPlaylist {
    id: string;
    name: string;
    ownerName: string;
    url: string;
    trackCount: number | null;
    coverUrl: string | null;
}

/** Safe diagnostic only: never include the upstream message, URL, headers or IDs. */
export interface SpotifyPlaybackDiagnostic {
    operation: "play" | "pause" | "transfer";
    spotifyStatus: number;
    reason: string;
    recovery?: boolean;
}

export interface SpotifyConnection {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    playlists: Map<string, SpotifyPlaylist>;
    selectedPlaylist?: SpotifyPlaylist;
    refreshPromise?: Promise<string>;
    previewPending?: boolean;
    questionPreview?: SpotifyQuestionPreview;
    grantedScopes?: string[];
    playbackDevices?: Map<string, string>;
    lastPlaybackRecoveryAt?: number;
    distractorSearchCache?: Map<string, { expiresAt: number; tracks: SpotifyChoiceCandidate[] }>;
}

export interface SpotifyAuthorization {
    returnTo?: string;
    state: string;
    verifier: string;
    redirectUri: string;
    expiresAt: number;
}
export interface SpotifyPlaylistTrack {
    position: number;
    id: string | null;
    name: string;
    artists: string[];
    albumName: string | null;
    durationMs: number | null;
    url: string | null;
    available: boolean;
}
/** An owner's preview only: never broadcast to a game room. */
export interface SpotifyChoiceCandidate { id: string; title: string; artists: string[]; }
export interface SpotifyQuestionPreview {
    /** Internal launch preparation only; not returned by the preview API. */
    choicePool?: SpotifyChoiceCandidate[];
    playlist: { id: string; name: string; url: string };
    questionCount: number;
    eligibleTrackCount: number;
    questions: {
        number: number;
        prompt: string;
        answer: { title: string; artists: string[] };
        track: { id: string; url: string; durationMs?: number };
    }[];
}
