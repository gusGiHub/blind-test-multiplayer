import "server-only";
import type { MusicTrack } from "@/src/types/music";

// Add only real excerpts you are allowed to use. See docs/music-catalog.md.
const tracks: readonly MusicTrack[] = Object.freeze([]);

/** The game engine reads its tracks here, independently of their source. */
export function getMusicCatalog(): readonly MusicTrack[] {
    return tracks;
}