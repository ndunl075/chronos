import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  ChronosApiClient,
  ChronosApiError,
  boundRenderedRows,
  eventTone,
  nearestEvent,
  normalizeBaseUrl,
  openEventStream,
} from "../dist/index.js";

const event = (id, seq, kind = "assistant_message") => ({
  id,
  branchId: "root",
  seq,
  kind,
  occurredAt: "2026-08-09T00:00:00Z",
  summary: id,
  hasRawEnvelope: false,
});

test("normalizes loopback URLs and rejects non-HTTP values", () => {
  assert.equal(
    normalizeBaseUrl(" http://127.0.0.1:4242/// "),
    "http://127.0.0.1:4242",
  );
  assert.throws(() => normalizeBaseUrl("file:///tmp/chronos"), /http/);
});

test("scrubbing selects the nearest recorded coordinate", () => {
  const events = [event("one", 1), event("four", 4), event("nine", 9)];
  assert.equal(nearestEvent(events, 6)?.id, "four");
  assert.equal(nearestEvent(events, 8)?.id, "nine");
  assert.equal(nearestEvent([], 1), undefined);
});

test("event tones keep people, agents, machines, and faults distinct", () => {
  assert.equal(eventTone("instruction"), "human");
  assert.equal(eventTone("assistant_message"), "agent");
  assert.equal(eventTone("filesystem_change"), "machine");
  assert.equal(eventTone("error"), "fault");
});

test("API client pages timelines and authenticates every request", async () => {
  const calls = [];
  const client = new ChronosApiClient({
    baseUrl: "http://127.0.0.1:4242/",
    token: "secret",
    fetch: async (url, init) => {
      calls.push({ url, init });
      const second = url.includes("fromSeq=3");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          items: second
            ? [event("three", 3)]
            : [event("one", 1), event("two", 2)],
          ...(second ? {} : { nextSeq: 3 }),
        }),
      };
    },
  });

  const events = await client.getTimeline("branch/a");
  assert.deepEqual(
    events.map(({ id }) => id),
    ["one", "two", "three"],
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /branch%2Fa/);
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.equal(Object.isFrozen(events), true);
});

test("API errors expose safe server messages", async () => {
  const client = new ChronosApiClient({
    baseUrl: "http://127.0.0.1:4242",
    token: "secret",
    fetch: async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: { message: "That event cannot reconstruct workspace state" },
      }),
    }),
  });
  await assert.rejects(
    () => client.getEvent("missing"),
    (error) => error instanceof ChronosApiError && error.status === 409,
  );
});

test("boundRenderedRows keeps everything under the cap and the newest tail over it", () => {
  const small = [1, 2, 3];
  assert.deepEqual(boundRenderedRows(small, 5), {
    visible: small,
    hiddenCount: 0,
  });

  const large = Array.from({ length: 10 }, (_, index) => index + 1);
  const bounded = boundRenderedRows(large, 4);
  assert.deepEqual(bounded.visible, [7, 8, 9, 10]);
  assert.equal(bounded.hiddenCount, 6);
});

/** One or more "\n\n"-joined SSE frames, delivered in awkward byte chunks. */
function frameStream(frames, chunkSize = 23) {
  const text = frames.map((frame) => `${frame}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

/** A body that never closes and never abort-reacts, until told to. */
function pendingStream(signal) {
  return frameThenPendingStream([], signal);
}

/** Delivers the given frames, then holds the connection open until aborted. */
function frameThenPendingStream(frames, signal) {
  const text = frames.map((frame) => `${frame}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      const onAbort = () => {
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {
          // Already closed/errored by a prior path; nothing further to do.
        }
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
  });
}

function notice(branchId, eventIds) {
  return { schemaVersion: 1, sessionId: "s1", branchId, eventIds };
}

test("openEventStream dispatches valid appended notices and ignores malformed frames", async () => {
  const controller = new AbortController();
  const states = [];
  const received = [];
  const frames = [
    'event: open\ndata: {"schemaVersion":1,"sessionId":"s1"}',
    ": keep-alive",
    "event: appended",
    "event: appended\ndata: {not json",
    'event: appended\ndata: {"schemaVersion":1}',
    "event: mystery\ndata: {}",
    `event: appended\ndata: ${JSON.stringify(notice("root", ["e1"]))}`,
    `event: appended\ndata: ${JSON.stringify(notice("root", ["e2", "e3"]))}`,
  ];

  openEventStream(
    {
      baseUrl: "http://127.0.0.1:4242",
      token: "secret",
      sessionId: "s1",
      fetch: async () => ({
        ok: true,
        status: 200,
        body: frameStream(frames),
      }),
      reconnectDelayMs: 10_000,
    },
    {
      onAppended: (item) => received.push(item),
      onStateChange: (state) => states.push(state),
    },
    controller.signal,
  );

  while (received.length < 2) await delay(1);
  controller.abort();
  while (states.at(-1) !== "closed") await delay(1);

  assert.deepEqual(
    received.map((item) => item.eventIds),
    [["e1"], ["e2", "e3"]],
  );
  assert.equal(states[0], "connecting");
  assert.equal(states.includes("open"), true);
});

test("openEventStream reconnects with backoff after the stream ends", async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const states = [];
  const received = [];
  let calls = 0;

  openEventStream(
    {
      baseUrl: "http://127.0.0.1:4242",
      token: "secret",
      sessionId: "s1",
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          // Closes immediately: an ordinary, clean end of stream.
          return {
            ok: true,
            status: 200,
            body: frameStream(["event: open\ndata: {}"]),
          };
        }
        // Delivers one frame, then holds the connection open.
        return {
          ok: true,
          status: 200,
          body: frameThenPendingStream(
            [
              `event: appended\ndata: ${JSON.stringify(notice("root", ["from-reconnect"]))}`,
            ],
            init.signal,
          ),
        };
      },
      reconnectDelayMs: 5,
    },
    {
      onAppended: (item) => received.push(item),
      onStateChange: (state) => states.push(state),
    },
    controller.signal,
  );

  while (received.length < 1) await delay(1);
  assert.equal(calls, 2);
  assert.equal(received[0].eventIds[0], "from-reconnect");
  assert.deepEqual(
    states.filter((state) => state === "open" || state === "reconnecting"),
    ["open", "reconnecting", "open"],
  );
});

test("openEventStream stops reconnecting once its signal is aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const states = [];

  openEventStream(
    {
      baseUrl: "http://127.0.0.1:4242",
      token: "secret",
      sessionId: "s1",
      fetch: async (_url, init) => {
        calls += 1;
        return { ok: true, status: 200, body: pendingStream(init.signal) };
      },
      reconnectDelayMs: 5,
    },
    {
      onAppended: () => undefined,
      onStateChange: (state) => states.push(state),
    },
    controller.signal,
  );

  await delay(20);
  assert.equal(calls, 1);
  controller.abort();
  while (states.at(-1) !== "closed") await delay(1);
  const callsAtAbort = calls;
  await delay(30);
  assert.equal(
    calls,
    callsAtAbort,
    "no further connection attempts after abort",
  );
});

test("openEventStream treats a fetch failure as a reconnect, not a crash", async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let calls = 0;
  const states = [];
  const received = [];

  openEventStream(
    {
      baseUrl: "http://127.0.0.1:4242",
      token: "secret",
      sessionId: "s1",
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("network unreachable");
        return {
          ok: true,
          status: 200,
          body: frameStream([
            `event: appended\ndata: ${JSON.stringify(notice("root", ["survived"]))}`,
          ]),
        };
      },
      reconnectDelayMs: 5,
    },
    {
      onAppended: (item) => received.push(item),
      onStateChange: (state) => states.push(state),
    },
    controller.signal,
  );

  while (received.length < 1) await delay(1);
  assert.equal(calls, 2);
  assert.equal(received[0].eventIds[0], "survived");
  assert.equal(states.includes("reconnecting"), true);
});

test("openEventStream delivers a large history in order across split chunks", async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const total = 2000;
  const frames = Array.from(
    { length: total },
    (_, index) =>
      `event: appended\ndata: ${JSON.stringify(notice("root", [`e${String(index)}`]))}`,
  );
  const received = [];

  openEventStream(
    {
      baseUrl: "http://127.0.0.1:4242",
      token: "secret",
      sessionId: "s1",
      fetch: async () => ({
        ok: true,
        status: 200,
        // Odd chunk size guarantees frame boundaries land mid-chunk.
        body: frameStream(frames, 37),
      }),
      reconnectDelayMs: 10_000,
    },
    {
      onAppended: (item) => received.push(item.eventIds[0]),
      onStateChange: () => undefined,
    },
    controller.signal,
  );

  while (received.length < total) await delay(1);
  assert.deepEqual(
    received,
    frames.map((_, index) => `e${String(index)}`),
  );
});

test("ChronosApiClient.openStream authenticates the session-scoped stream URL", async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let seen;
  const client = new ChronosApiClient({
    baseUrl: "http://127.0.0.1:4242/",
    token: "secret",
    streamFetch: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, body: pendingStream(init.signal) };
    },
  });

  client.openStream("s 1", { onAppended: () => undefined }, controller.signal);
  await delay(10);
  assert.equal(seen.url, "http://127.0.0.1:4242/sessions/s%201/stream");
  assert.equal(seen.init.headers.authorization, "Bearer secret");
});
