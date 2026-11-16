import "server-only";
import { randomInt } from "node:crypto";
import type { PlayerSession } from "./playerSession";
import type { SpotifyPlaylistTrack, SpotifyQuestionPreview, SpotifyChoiceCandidate } from "@/src/types/spotify";
import { getSpotifyPlaylistTracks, searchSpotifyArtistTracks, SpotifyError } from "./spotify";

const MAX_PAGES = 100;

/** Generates a private metadata preview; never creates a game or an audio excerpt. */
export async function createSpotifyQuestionPreview(
    session: PlayerSession, playlistId: string, questionCount: number, signal?: AbortSignal, excerptSeconds = 30, includeChoices = false, roomSelection?: SpotifyQuestionPreview["playlist"]
): Promise<SpotifyQuestionPreview> {
    if (![5, 10, 15].includes(questionCount)) throw new SpotifyError("Choisis 5, 10 ou 15 questions.", 400);
    if (!Number.isInteger(excerptSeconds) || excerptSeconds < 1 || excerptSeconds > 30) throw new SpotifyError("La durée d’extrait doit être comprise entre 1 et 30 secondes.", 400);
    const connection = session.spotify;
    if (!connection) throw new SpotifyError("Connecte ton compte Spotify.", 401);
    const selected = roomSelection ?? connection.selectedPlaylist;
    if (!selected) throw new SpotifyError("Sélectionne d’abord une playlist.", 400);
    if (selected.id !== playlistId) throw new SpotifyError("La playlist sélectionnée a changé. Actualise la page.", 409);
    if (roomSelection && !connection.playlists.has(playlistId)) throw new SpotifyError("Choisis une playlist parmi celles de ton compte.", 403);
    if (connection.previewPending) throw new SpotifyError("Un aperçu est déjà en cours de génération.", 409);

    connection.previewPending = true;
    const deadline = AbortSignal.timeout(25000);
    const cancellation = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const assertCurrentSelection = () => {
        if (session.spotify !== connection || session.expiresAt <= Date.now()) throw new SpotifyError("La session Spotify a été déconnectée ou a expiré.", 401);
        if (!roomSelection && connection.selectedPlaylist?.id !== playlistId) throw new SpotifyError("La playlist sélectionnée a changé pendant la génération. Réessaie.", 409);
    };
    try {
        const eligible = new Map<string, SpotifyPlaylistTrack>();
        const choicePool = new Map<string, SpotifyChoiceCandidate>();
        let offset = 0;
        let complete = false;
        for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
            assertCurrentSelection();
            cancellation.throwIfAborted();
            const page = await getSpotifyPlaylistTracks(session, playlistId, offset, 50, cancellation);
            assertCurrentSelection();
            for (const track of page.tracks) {
                if (!track.id || !track.url || !track.available || !track.name.trim()) continue;
                const artists = track.artists.map(artist => artist.trim()).filter(Boolean);
                if (artists.length === 0) continue;
                if (includeChoices) choicePool.set(track.id, { id: track.id, title: track.name, artists });
                if (track.durationMs !== null && track.durationMs < excerptSeconds * 1000) continue;
                if (!eligible.has(track.id)) eligible.set(track.id, { ...track, artists });
            }
            if (page.nextOffset === null) { complete = true; break; }
            offset = page.nextOffset;
        }
        if (!complete) throw new SpotifyError("Cette playlist dépasse la limite de 5 000 éléments pour un aperçu. Choisis une playlist plus courte.", 422);
        cancellation.throwIfAborted();
        assertCurrentSelection();
        if (eligible.size < questionCount) {
            throw new SpotifyError(`La playlist contient ${eligible.size} morceau(x) distinct(s) utilisable(s) pour ${questionCount} questions demandées. Choisis moins de questions ou une autre playlist.`, 422);
        }
        const pool = Array.from(eligible.values());
        const questions: SpotifyQuestionPreview["questions"] = [];
        for (let index = 0; index < questionCount; index++) {
            const candidate = index + randomInt(pool.length - index);
            [pool[index], pool[candidate]] = [pool[candidate], pool[index]];
            const track = pool[index];
            questions.push({
                number: index + 1,
                prompt: "Quel est le titre de ce morceau et qui l’interprète ?",
                answer: { title: track.name, artists: [...track.artists] },
                track: { id: track.id!, url: track.url!, ...(track.durationMs !== null ? { durationMs: track.durationMs } : {}) },
            });
        }
        if (includeChoices) {
            const artists = Array.from(new Map(questions.map(question => [question.answer.artists[0].toLocaleLowerCase(), question.answer.artists[0]])).values()).slice(0, 5);
            connection.distractorSearchCache ??= new Map();
            for (const artist of artists) {
                assertCurrentSelection();
                cancellation.throwIfAborted();
                const key = artist.toLocaleLowerCase();
                let cached = connection.distractorSearchCache.get(key);
                if (!cached || cached.expiresAt <= Date.now()) {
                    try {
                        const tracks = await searchSpotifyArtistTracks(session, artist, AbortSignal.any([cancellation, AbortSignal.timeout(2000)]));
                        assertCurrentSelection();
                        cached = { expiresAt: Date.now() + 10 * 60 * 1000, tracks };
                        if (connection.distractorSearchCache.size >= 100) connection.distractorSearchCache.delete(connection.distractorSearchCache.keys().next().value!);
                        connection.distractorSearchCache.set(key, cached);
                    } catch (error) {
                        assertCurrentSelection();
                        cancellation.throwIfAborted();
                        if (error instanceof SpotifyError && error.status === 401) throw error;
                        // Metadata enrichment is optional; never retry a quota or permission error.
                        if (error instanceof SpotifyError && [403, 429].includes(error.status)) break;
                        continue;
                    }
                }
                for (const track of cached.tracks) choicePool.set(track.id, track);
            }
        }
        assertCurrentSelection();
        cancellation.throwIfAborted();
        return {
            playlist: { id: selected.id, name: selected.name, url: selected.url },
            questionCount, eligibleTrackCount: eligible.size, questions,
            ...(includeChoices ? { choicePool: Array.from(choicePool.values()) } : {}),
        };
    } catch (error) {
        if (deadline.aborted) throw new SpotifyError("La génération a pris trop de temps. Réessaie avec une playlist plus courte.", 504);
        if (signal?.aborted) throw new SpotifyError("La génération a été annulée.", 408);
        throw error;
    } finally {
        delete connection.previewPending;
    }
}
