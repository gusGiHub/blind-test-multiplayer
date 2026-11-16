import "server-only";
import { NextResponse } from "next/server";
import { normalizeGameCode } from "./gameValidation";
import { readPlayerSession } from "./playerSession";
import { getGameActionError, progressGame, startGame, submitGameAnswer, selectGamePlaylist, rematchGame, setPlayerReady } from "./gameActions";
import { games } from "./gameStore";

/** HTTP adapter: identity checks before calling the game service. */
export async function handleGameCommand(request: Request, params: Promise<{ code: string }>, action: "start" | "reveal" | "next" | "answer" | "playlist" | "rematch" | "ready") {
    const code = normalizeGameCode((await params).code);
    if (!code) return NextResponse.json({ error: "Le code doit contenir 5 chiffres." }, { status: 400 });
    let body;
    try { body = await request.json(); } catch {
        return NextResponse.json({ error: "Le corps de la requête doit être un JSON valide." }, { status: 400 });
    }
    const playerId = body?.playerId;
    if (typeof playerId !== "string" || !playerId) return NextResponse.json({ error: "L’identifiant du joueur est requis." }, { status: 400 });
    if (action !== "start" && action !== "playlist" && action !== "rematch" && action !== "ready" && (!Number.isSafeInteger(body?.questionNumber) || body.questionNumber <= 0)) {
        return NextResponse.json({ error: "Le numéro de question est invalide." }, { status: 400 });
    }
    if (action === "answer" && body.choiceId === undefined && body.text === undefined) return NextResponse.json({ error: "La réponse n’a pas été reçue. Recharge la page de la partie avant de réessayer." }, { status: 400 });
    if (action === "answer" && !(
        (typeof body.choiceId === "string" && body.choiceId.length > 0 && body.choiceId.length <= 100 && body.text === undefined) ||
        (typeof body.text === "string" && body.text.trim().length > 0 && body.text.length <= 200 && body.choiceId === undefined)
    )) return NextResponse.json({ error: "La réponse est invalide (200 caractères maximum)." }, { status: 400 });
    const hasSubmission = body.confirmed !== undefined || body.revision !== undefined;
    if (action === "ready" && typeof body.ready !== "boolean") return NextResponse.json({ error: "Le statut prêt doit être un booléen." }, { status: 400 });
    if (action === "playlist" && (typeof body.playlistId !== "string" || !/^[a-zA-Z0-9]{1,100}$/.test(body.playlistId))) return NextResponse.json({ error: "Playlist invalide." }, { status: 400 });
    if (action === "answer" && hasSubmission && (body.text !== undefined || typeof body.confirmed !== "boolean" || !Number.isSafeInteger(body.revision) || body.revision <= 0)) return NextResponse.json({ error: "La présélection est invalide." }, { status: 400 });
    const session = await readPlayerSession();
    if (!session) return NextResponse.json({ error: "Session absente ou expirée. Crée ou rejoins une partie." }, { status: 401 });
    if (!session.playerIds.has(playerId)) return NextResponse.json({ error: "Ce joueur n’appartient pas à ta session." }, { status: 403 });
    if (body.round !== undefined && (!Number.isSafeInteger(body.round) || body.round !== (games.get(code)?.round ?? 0))) return NextResponse.json({ error: "Cette commande concerne une partie précédente. Actualise le lobby." }, { status: 409 });
    try {
        if (action === "ready") return NextResponse.json(setPlayerReady(code, playerId, body.ready), { headers: { "Cache-Control": "private, no-store" } });
        if (action === "rematch") return NextResponse.json(rematchGame(code, playerId), { headers: { "Cache-Control": "private, no-store" } });
        if (action === "playlist") return NextResponse.json(selectGamePlaylist(code, playerId, session, body.playlistId), { headers: { "Cache-Control": "private, no-store" } });
        if (action === "answer") return NextResponse.json({ ...submitGameAnswer(code, playerId, body.questionNumber, body.text ?? body.choiceId, body.text !== undefined ? "text" : "choice", hasSubmission ? { confirmed: body.confirmed, revision: body.revision } : undefined), ...(games.get(code)?.round !== undefined ? { round: games.get(code)!.round } : {}) }, { headers: { "Cache-Control": "private, no-store" } });
        const result = action === "start" ? await startGame(code, playerId, session, request.signal) : progressGame(code, playerId, action, body.questionNumber);
        return NextResponse.json(result, { status: action === "start" ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        const failure = getGameActionError(error);
        return NextResponse.json({ error: failure.error }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
    }
}
