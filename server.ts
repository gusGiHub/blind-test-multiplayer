import next from "next";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerGameSockets } from "./src/server/gameSockets";
import { getServerPort, getInternalApiOrigin, getAllowedOrigins } from "./src/lib/serverConfig";

const dev = process.env.NODE_ENV !== "production";
const hostname = "127.0.0.1";
const port = getServerPort();

const app = next({ dev, hostname, port });

const handle = app.getRequestHandler();

const httpServer = createServer((req, res) => {
    handle(req, res);
});

app.prepare().then(() => {
    // Next has loaded environment files before the public origin is read.
    const allowedOrigins = getAllowedOrigins();
    const io = new Server(httpServer, {
        allowRequest: (request, callback) => {
            callback(null, !request.headers.origin || allowedOrigins.includes(request.headers.origin));
        },
        cors: { origin: allowedOrigins },
    });
    registerGameSockets(io, getInternalApiOrigin());
    httpServer.listen(port, "0.0.0.0", () => {
        console.log(`> Ready on port ${port} (${dev ? "development" : "production"})`);
    });
    const shutdown = () => {
        const timeout = setTimeout(() => process.exit(1), 10000);
        timeout.unref();
        io.close(() => { void app.close().finally(() => process.exit(0)); });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}).catch(error => {
    console.error("Le serveur n’a pas pu démarrer :", error instanceof Error ? error.message : "Erreur inconnue");
    process.exit(1);
});
