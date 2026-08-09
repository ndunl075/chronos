import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { canonicalEnvelope, logicalSequence } from "@chronos/protocol";
import {
  ChronosRepository,
  IN_MEMORY_PATH,
  openStorage,
} from "@chronos/storage";

import {
  EventBroadcaster,
  appendedNotice,
  startServer,
} from "../dist/index.js";

const seq = logicalSequence;
const OCCURRED_AT = "2026-08-09T00:00:00Z";

function event(id, number, overrides = {}) {
  return {
    id,
    branchId: "root",
    seq: seq(number),
    kind: "assistant_message",
    occurredAt: OCCURRED_AT,
    summary: `summary for ${id}`,
    payload: canonicalEnvelope({ id }),
    ...overrides,
  };
}

async function serve(t) {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  const repository = new ChronosRepository(storage);
  repository.insertSession({
    id: "s1",
    source: "live",
    createdAt: OCCURRED_AT,
  });
  repository.insertBranch({ id: "root", sessionId: "s1", state: "ready" });
  const server = await startServer({ repository, heartbeatMs: 20 });
  t.after(() => server.close());
  return { server, repository };
}

function call(server, options) {
  const { path, method = "GET", body } = options;
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method,
        headers: {
          host: `127.0.0.1:${server.port}`,
          authorization: `Bearer ${server.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(chunks.join("")),
          }),
        );
      },
    );
    outbound.on("error", reject);
    if (body !== undefined) outbound.write(JSON.stringify(body));
    outbound.end();
  });
}

/** Open an event stream and expose the frames as they arrive. */
function openStream(t, server, path) {
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: "GET",
        headers: {
          host: `127.0.0.1:${server.port}`,
          authorization: `Bearer ${server.token}`,
          accept: "text/event-stream",
        },
      },
      (response) => {
        let buffered = "";
        const frames = [];
        const waiters = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffered += chunk;
          let boundary = buffered.indexOf("\n\n");
          while (boundary !== -1) {
            frames.push(buffered.slice(0, boundary));
            buffered = buffered.slice(boundary + 2);
            boundary = buffered.indexOf("\n\n");
          }
          while (waiters.length > 0 && frames.length > 0) {
            waiters.shift()(frames.shift());
          }
        });
        const next = () =>
          frames.length > 0
            ? Promise.resolve(frames.shift())
            : new Promise((settle) => waiters.push(settle));
        const stream = {
          status: response.statusCode,
          headers: response.headers,
          next,
          /** Skip the retry hint and keep-alive comments. */
          async nextEvent() {
            for (;;) {
              const frame = parseFrame(await next());
              if (frame.event !== undefined) return frame;
            }
          },
          async nextComment() {
            for (;;) {
              const frame = parseFrame(await next());
              if (frame.comment) return frame;
            }
          },
          close: () => outbound.destroy(),
        };
        t.after(() => stream.close());
        resolve(stream);
      },
    );
    outbound.on("error", reject);
    outbound.end();
  });
}

function parseFrame(frame) {
  const lines = frame.split("\n");
  const name = lines.find((line) => line.startsWith("event: "));
  const data = lines.find((line) => line.startsWith("data: "));
  return {
    comment: lines.some((line) => line.startsWith(":")),
    event: name?.slice("event: ".length),
    data:
      data === undefined ? undefined : JSON.parse(data.slice("data: ".length)),
  };
}

test("a broadcaster fans out and releases its subscribers", () => {
  const broadcaster = new EventBroadcaster();
  const received = [];
  const stop = broadcaster.subscribe("s1", (notice) => received.push(notice));
  broadcaster.subscribe("other", () => {
    throw new Error("a listener that throws is dropped, not propagated");
  });

  assert.equal(broadcaster.subscriberCount("s1"), 1);
  broadcaster.publish(appendedNotice("s1", "root", ["e1"]));
  broadcaster.publish(appendedNotice("other", "root", ["x"]));
  broadcaster.publish(appendedNotice("unwatched", "root", ["y"]));

  assert.deepEqual(received, [
    { schemaVersion: 1, sessionId: "s1", branchId: "root", eventIds: ["e1"] },
  ]);
  assert.equal(
    broadcaster.subscriberCount("other"),
    0,
    "throwing listener dropped",
  );

  stop();
  assert.equal(broadcaster.subscriberCount("s1"), 0);
  broadcaster.publish(appendedNotice("s1", "root", ["e2"]));
  assert.equal(received.length, 1);
});

test("appended events land transactionally and reach the stream", async (t) => {
  const { server, repository } = await serve(t);
  const stream = await openStream(t, server, "/sessions/s1/stream");

  assert.equal(stream.status, 200);
  assert.equal(
    stream.headers["content-type"],
    "text/event-stream; charset=utf-8",
  );
  assert.equal(stream.headers["cache-control"], "no-store");
  assert.equal(stream.headers["access-control-allow-origin"], undefined);

  const opened = await stream.nextEvent();
  assert.equal(opened.event, "open");
  assert.deepEqual(opened.data, { schemaVersion: 1, sessionId: "s1" });

  const appended = await call(server, {
    method: "POST",
    path: "/branches/root/events",
    body: { events: [event("e1", 1), event("e2", 2)] },
  });
  assert.equal(appended.status, 201);
  assert.deepEqual(
    appended.body.items.map((item) => item.id),
    ["e1", "e2"],
  );

  const frame = await stream.nextEvent();
  assert.equal(frame.event, "appended");
  assert.deepEqual(frame.data, {
    schemaVersion: 1,
    sessionId: "s1",
    branchId: "root",
    eventIds: ["e1", "e2"],
  });

  // The stream carries identifiers only; the records come from the API.
  assert.equal(repository.countEvents("root"), 2);
  const detail = await call(server, { path: "/events/e1" });
  assert.equal(detail.body.data.summary, "summary for e1");
});

test("a stream keeps itself alive and lets go when the client does", async (t) => {
  const { server } = await serve(t);
  const stream = await openStream(t, server, "/sessions/s1/stream");

  assert.equal((await stream.nextEvent()).event, "open");
  assert.equal((await stream.nextComment()).comment, true);

  stream.close();
  await delay(50);

  // A later append must not throw against the closed subscription.
  const appended = await call(server, {
    method: "POST",
    path: "/branches/root/events",
    body: { events: [event("e1", 1)] },
  });
  assert.equal(appended.status, 201);
});

test("a rejected append leaves no partial history and no broadcast", async (t) => {
  const { server, repository } = await serve(t);

  const gap = await call(server, {
    method: "POST",
    path: "/branches/root/events",
    body: { events: [event("e1", 1), event("gap", 3)] },
  });
  assert.equal(gap.status, 409, "a gap conflicts with stored history");
  assert.equal(repository.countEvents("root"), 0);

  for (const body of [
    { events: [] },
    { events: "all of them" },
    {},
    { events: [event("e1", 1, { branchId: "other" })] },
    { events: [{ ...event("e1", 1), payload: "not an envelope" }] },
  ]) {
    const response = await call(server, {
      method: "POST",
      path: "/branches/root/events",
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(repository.countEvents("root"), 0);

  const unknownBranch = await call(server, {
    method: "POST",
    path: "/branches/missing/events",
    body: { events: [event("e1", 1)] },
  });
  assert.equal(unknownBranch.status, 404);
});

test("live append cannot bypass the record coordinator for mutating events", async (t) => {
  const { server } = await serve(t);
  for (const kind of ["tool_call", "tool_result", "filesystem_change"]) {
    const response = await call(server, {
      method: "POST",
      path: "/branches/root/events",
      body: { events: [event(`blocked-${kind}`, 1, { kind })] },
    });
    assert.equal(response.status, 400, kind);
    assert.match(response.body.error.message, /record coordinator/);
  }
});

test("appended data is redacted before it is stored", async (t) => {
  const { server } = await serve(t);

  await call(server, {
    method: "POST",
    path: "/branches/root/events",
    body: {
      events: [
        event("e1", 1, {
          kind: "assistant_message",
          summary: "exported AKIAIOSFODNN7EXAMPLE",
          payload: canonicalEnvelope({
            stdout: "AKIAIOSFODNN7EXAMPLE",
            token: "raw-secret-value",
          }),
        }),
      ],
    },
  });

  const stored = await call(server, { path: "/events/e1" });
  assert.equal(stored.body.data.summary, "exported [redacted:aws key]");
  assert.deepEqual(stored.body.data.payload.data, {
    stdout: "[redacted:aws key]",
    token: "[redacted:field]",
  });
});

test("an unknown session cannot be streamed", async (t) => {
  const { server } = await serve(t);

  const response = await call(server, { path: "/sessions/missing/stream" });
  assert.equal(response.status, 404);
});
