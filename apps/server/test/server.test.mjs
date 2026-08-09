import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import {
  ServerConfigError,
  generateToken,
  isAllowedHost,
  isAllowedOrigin,
  startServer,
  tokensMatch,
} from "../dist/index.js";

/**
 * `fetch` refuses to set a Host header, and Host is exactly what the
 * rebinding check inspects, so the tests speak HTTP directly.
 */
function call(server, options = {}) {
  const { path = "/info", method = "GET", headers = {}, body } = options;
  const sent = {
    host: `127.0.0.1:${server.port}`,
    authorization: `Bearer ${server.token}`,
    ...headers,
  };
  for (const [key, value] of Object.entries(sent)) {
    if (value === null) delete sent[key];
  }
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method,
        headers: sent,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = chunks.join("");
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text.length === 0 ? undefined : JSON.parse(text),
          });
        });
      },
    );
    call.on("error", reject);
    if (body !== undefined) call.write(body);
    call.end();
  });
}

async function serve(t, options = {}) {
  const server = await startServer(options);
  t.after(() => server.close());
  return server;
}

test("a per-run token is unguessable and compared in constant time", () => {
  const token = generateToken();

  assert.equal(token.length >= 32, true);
  assert.notEqual(token, generateToken());
  assert.equal(tokensMatch(token, token), true);
  assert.equal(tokensMatch(`${token}x`, token), false);
  assert.equal(tokensMatch("", token), false);
  assert.equal(tokensMatch(undefined, token), false);
});

test("only this loopback server on this port is an acceptable host", () => {
  assert.equal(isAllowedHost("127.0.0.1:8080", 8080), true);
  assert.equal(isAllowedHost("localhost:8080", 8080), true);
  assert.equal(isAllowedHost("[::1]:8080", 8080), true);
  assert.equal(isAllowedHost("LOCALHOST:8080", 8080), true);

  assert.equal(isAllowedHost("127.0.0.1:9090", 8080), false, "wrong port");
  assert.equal(isAllowedHost("chronos.example:8080", 8080), false);
  assert.equal(isAllowedHost("127.0.0.1", 8080), false, "no port");
  assert.equal(isAllowedHost(undefined, 8080), false);
});

test("a request with no origin is local; any other origin is refused", () => {
  assert.equal(isAllowedOrigin(undefined, 8080), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8080", 8080), true);
  assert.equal(isAllowedOrigin("http://localhost:8080", 8080), true);

  assert.equal(isAllowedOrigin("http://localhost:9090", 8080), false);
  assert.equal(isAllowedOrigin("https://localhost:8080", 8080), false);
  assert.equal(isAllowedOrigin("http://evil.example", 8080), false);
  assert.equal(isAllowedOrigin("null", 8080), false);
  assert.equal(isAllowedOrigin("not a url", 8080), false);
});

test("the server binds to loopback and reports what it is", async (t) => {
  const server = await serve(t);

  assert.equal(server.host, "127.0.0.1");
  assert.equal(server.port > 0, true);
  assert.equal(server.url, `http://127.0.0.1:${server.port}`);

  const response = await call(server);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    schemaVersion: 1,
    name: "chronos",
    protocolVersion: 1,
    bind: `127.0.0.1:${server.port}`,
  });
  assert.equal(
    response.headers["content-type"],
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("a non-loopback bind is refused instead of silently exposed", async () => {
  await assert.rejects(
    () => startServer({ host: "0.0.0.0" }),
    (error) => error instanceof ServerConfigError,
  );
  await assert.rejects(
    () => startServer({ port: -1 }),
    (error) => error instanceof ServerConfigError,
  );
  await assert.rejects(
    () => startServer({ token: "short" }),
    (error) => error instanceof ServerConfigError,
  );
});

test("requests without a valid token are refused", async (t) => {
  const server = await serve(t);

  for (const authorization of [
    null,
    "",
    "Bearer",
    "Bearer wrong-token-value-here",
    `Basic ${server.token}`,
    server.token,
  ]) {
    const response = await call(server, { headers: { authorization } });
    assert.equal(response.status, 401, String(authorization));
    assert.equal(response.body.error.code, "unauthorized");
    assert.equal(response.body.schemaVersion, 1);
  }
});

test("a rebound host or a foreign origin is refused before the token", async (t) => {
  const server = await serve(t);

  const rebound = await call(server, {
    headers: { host: "chronos.evil.example", authorization: null },
  });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.error.code, "forbidden");

  const wrongPort = await call(server, {
    headers: { host: `127.0.0.1:${server.port + 1}` },
  });
  assert.equal(wrongPort.status, 403);

  const crossOrigin = await call(server, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers["access-control-allow-origin"], undefined);
});

test("unknown paths, methods, and oversized targets are rejected", async (t) => {
  const server = await serve(t);

  const missing = await call(server, { path: "/nope" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "not_found");

  const wrongMethod = await call(server, { method: "POST", path: "/info" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.error.code, "method_not_allowed");

  const unsupported = await call(server, { method: "DELETE", path: "/info" });
  assert.equal(unsupported.status, 405);

  const preflight = await call(server, { method: "OPTIONS", path: "/info" });
  assert.equal(preflight.status, 405);

  const longTarget = await call(server, {
    path: `/info?q=${"x".repeat(4096)}`,
  });
  assert.equal(longTarget.status, 400);
  assert.equal(longTarget.body.error.code, "bad_request");
});

test("request bodies are parsed, typed, and capped", async (t) => {
  const seen = [];
  const server = await serve(t, {
    maxRequestBytes: 64,
    routes: [
      {
        method: "POST",
        path: "/echo/:id",
        handler: (context) => {
          seen.push(context);
          return {
            status: 201,
            body: { id: context.params.id, body: context.body },
          };
        },
      },
    ],
  });

  const created = await call(server, {
    method: "POST",
    path: "/echo/abc%20def?limit=5",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: "abc def", body: { hello: "world" } });
  assert.equal(seen[0].query.get("limit"), "5");

  const wrongType = await call(server, {
    method: "POST",
    path: "/echo/x",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal(wrongType.status, 415);

  const malformed = await call(server, {
    method: "POST",
    path: "/echo/x",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(malformed.status, 400);

  const tooLarge = await call(server, {
    method: "POST",
    path: "/echo/x",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(256) }),
  });
  assert.equal(tooLarge.status, 413);
});

test("a handler failure never leaks internals", async (t) => {
  const server = await serve(t, {
    routes: [
      {
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new Error("connection string: postgres://user:pw@host/db");
        },
      },
    ],
  });

  const response = await call(server, { path: "/boom" });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, {
    code: "internal",
    message: "The server could not complete the request",
  });
});
