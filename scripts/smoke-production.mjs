import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { io } from "socket.io-client";

// Isolated process and synthetic Spotify identity: never uses a real account.
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = "https://blind-test.example";
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["start.mjs"], { env: { ...process.env, PORT: String(port), APP_URL: origin, SPOTIFY_CLIENT_ID: "production-smoke-test" }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", data => { output = (output + data).slice(-4000); });
child.stderr.on("data", data => { output = (output + data).slice(-4000); });
const clients = [];
const event = (socket, name) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${name}`)), 10000);
    socket.once(name, data => { clearTimeout(timeout); resolve(data); });
});
// Node fetch ignores a custom Host header; raw HTTP faithfully simulates the proxy.
const call = (path, body, cookie) => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method: "POST", headers: { Host: "blind-test.example", Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) } }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
        });
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
});
try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error("Production server exited during startup");
        try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, "production server must become healthy");
    const created = await call("/api/games", { nickname: "Production Host", questionCount: 5 });
    assert.equal(created.status, 200);
    const { game, player: host } = await created.json();
    const ownerCookie = created.headers.get("set-cookie").split(";")[0];
    assert.match(created.headers.get("set-cookie"), /Secure/);
    const joined = await call(`/api/games/${game.code}/join`, { nickname: "Production Guest" });
    const guest = await joined.json();
    const guestCookie = joined.headers.get("set-cookie").split(";")[0];
    const page = await fetch(`${base}/game/${game.code}?playerId=${host.id}`, { headers: { Host: "blind-test.example", Cookie: ownerCookie } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Production Host"), "SSR must reach this process on its dynamic port");
    for (const [player, cookie] of [[host, ownerCookie], [guest, guestCookie]]) {
        const socket = io(base, { autoConnect: false, reconnection: false, transports: ["websocket"], extraHeaders: { Origin: origin, Cookie: cookie } });
        clients.push(socket);
        const connected = event(socket, "connect");
        socket.connect();
        await connected;
        const admitted = event(socket, "game_joined");
        socket.emit("join_game", { code: game.code, playerId: player.id });
        assert.equal((await admitted).game.code, game.code);
    }
    const updated = event(clients[0], "player_ready");
    clients[1].emit("set_ready", { code: game.code, playerId: guest.id, ready: true, round: 0 });
    assert.equal((await updated).player.ready, true);
    const login = await call("/api/spotify/login", {});
    assert.equal(login.status, 303);
    assert.equal(new URL(login.headers.get("location")).searchParams.get("redirect_uri"), origin + "/api/spotify/callback");
    console.log("Production OK: health, secure sessions, dynamic-port SSR, Socket.IO lobby/readiness and HTTPS OAuth redirect.");
} catch (error) {
    console.error(output);
    throw error;
} finally {
    clients.forEach(socket => socket.disconnect());
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
}
