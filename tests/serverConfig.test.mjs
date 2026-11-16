import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(env) {
    const exports = {};
    const source = fs.readFileSync(new URL("../src/lib/serverConfig.ts", import.meta.url), "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports, process: { env }, URL });
    return exports;
}

test("production binds the supplied port but keeps internal requests on loopback", () => {
    const config = load({ NODE_ENV: "production", PORT: "10000", APP_URL: "https://blind-test.example" });
    assert.equal(config.getServerPort(), 10000);
    assert.equal(config.getInternalApiOrigin(), "http://127.0.0.1:10000");
    assert.deepEqual(Array.from(config.getAllowedOrigins()), ["https://blind-test.example"]);
});

test("invalid production origins and ports fail rather than accepting a public wildcard", () => {
    for (const APP_URL of [undefined, "http://blind-test.example", "https://user:secret@blind-test.example", "https://blind-test.example/path", "https://blind-test.example?query=1"]) {
        assert.throws(() => load({ NODE_ENV: "production", APP_URL }).getAllowedOrigins());
    }
    for (const PORT of ["", "0", "-1", "65536", "abc", "3.5"]) assert.throws(() => load({ PORT }).getServerPort());
    assert.deepEqual(Array.from(load({}).getAllowedOrigins()), ["http://127.0.0.1:3000", "http://localhost:3000"]);
});
