import { NextResponse } from "next/server";
import { readGameAccess } from "@/src/lib/gameAccess";

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
    let body;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: "Le corps de la requête doit être un JSON valide." }, { status: 400 }); }
    return readGameAccess((await params).code, body?.playerId);
}
export const maxDuration = 60;
