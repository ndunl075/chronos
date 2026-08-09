import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChronosRepository,
  IN_MEMORY_PATH,
  openStorage,
} from "@chronos/storage";

import { startServer } from "../dist/index.js";

/** A page directory shaped like the built web app, plus a file outside it. */
function assets(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-assets-"));
  t.after(() => rmSync(root, { force: true, recursive: true, maxRetries: 5 }));

  const web = join(root, "web");
  mkdirSync(join(web, "dist"), { recursive: true });
  writeFileSync(
    join(web, "index.html"),
    "<!doctype html><title>chronos</title>",
  );
  writeFileSync(
    join(web, "dist", "index.js"),
    "export const mounted = true;\n",
  );
  writeFileSync(join(web, "notes.txt"), "not a page asset");
  writeFileSync(join(root, "secret.html"), "outside the page directory");
  return { root, web };
}

async function serve(t, web) {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  const repository = new ChronosRepository(storage);
  repository.insertSession({
    id: "s1",
    source: "fixture",
    createdAt: "2026-08-09T00:00:00Z",
  });
  const server = await startServer({ repository, web: { root: web } });
  t.after(() => server.close());
  return server;
}

/** Raw HTTP, so a request can omit the token the way a navigation does. */
function fetchRaw(server, path, headers = {}) {
  const sent = {
    host: `127.0.0.1:${server.port}`,
    ...headers,
  };
  for (const [key, value] of Object.entries(sent)) {
    if (value === null) delete sent[key];
  }
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: "GET",
        headers: sent,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: chunks.join(""),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end();
  });
}

test("the page loads without a token, because a navigation cannot send one", async (t) => {
  const { web } = assets(t);
  const server = await serve(t, web);

  const page = await fetchRaw(server, "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>chronos<\/title>/);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(
    page.headers["content-security-policy"],
    /frame-ancestors 'none'/,
  );
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(page.headers["access-control-allow-origin"], undefined);

  const script = await fetchRaw(server, "/dist/index.js");
  assert.equal(script.status, 200);
  assert.equal(
    script.headers["content-type"],
    "text/javascript; charset=utf-8",
  );
  assert.match(script.body, /mounted/);
});

test("records still require the token the page does not carry", async (t) => {
  const { web } = assets(t);
  const server = await serve(t, web);

  const unauthenticated = await fetchRaw(server, "/sessions");
  assert.equal(unauthenticated.status, 401);

  const authenticated = await fetchRaw(server, "/sessions", {
    authorization: `Bearer ${server.token}`,
  });
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.body, /s1/);
});

test("page requests are still checked for a rebound host or foreign origin", async (t) => {
  const { web } = assets(t);
  const server = await serve(t, web);

  const rebound = await fetchRaw(server, "/", { host: "chronos.evil.example" });
  assert.equal(rebound.status, 403);

  const crossOrigin = await fetchRaw(server, "/", {
    origin: "http://evil.example",
  });
  assert.equal(crossOrigin.status, 403);
});

test("nothing outside the page directory can be read", async (t) => {
  const { web } = assets(t);
  const server = await serve(t, web);

  for (const path of [
    "/../secret.html",
    "/dist/../../secret.html",
    "/%2e%2e/secret.html",
    "/..%2fsecret.html",
    "/dist/%2e%2e%2f%2e%2e%2fsecret.html",
    "//index.html",
  ]) {
    const response = await fetchRaw(server, path);
    assert.notEqual(response.status, 200, path);
    assert.equal(response.body.includes("outside the page"), false, path);
  }

  const normalized = await fetchRaw(server, "/./index.html");
  assert.equal(
    normalized.status,
    200,
    "the URL parser may normalize dot segments",
  );
});

test("only page asset types are served", async (t) => {
  const { web } = assets(t);
  const server = await serve(t, web);

  const text = await fetchRaw(server, "/notes.txt");
  assert.equal(text.status, 404);

  const missing = await fetchRaw(server, "/dist/absent.js");
  assert.equal(missing.status, 404);

  const directory = await fetchRaw(server, "/dist");
  assert.equal(directory.status, 404, "no directory listing");
});

test("an API path always wins over a file of the same name", async (t) => {
  const { web } = assets(t);
  mkdirSync(join(web, "sessions"), { recursive: true });
  writeFileSync(join(web, "sessions", "index.html"), "impostor");
  const server = await serve(t, web);

  const api = await fetchRaw(server, "/sessions", {
    authorization: `Bearer ${server.token}`,
  });
  assert.equal(api.status, 200);
  assert.match(api.body, /"schemaVersion"/);
});

test("without the web option nothing static is served", async (t) => {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  const server = await startServer({
    repository: new ChronosRepository(storage),
  });
  t.after(() => server.close());

  const page = await fetchRaw(server, "/");
  assert.equal(page.status, 404);
});
