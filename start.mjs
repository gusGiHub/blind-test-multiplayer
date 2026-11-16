// Set the environment before loading Next, on Windows as well as Linux.
process.env.NODE_ENV = "production";
await import("./dist/server.js");
