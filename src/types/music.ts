/** Server-side catalog entry: title and artist are the answers to a question. */
export interface MusicTrack {
    readonly id: string;
    readonly title: string;
    readonly artist: string;
    readonly audioPath: `/audio/${string}`;
}