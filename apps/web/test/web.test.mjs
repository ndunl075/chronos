import assert from "node:assert/strict";
import test from "node:test";

import {
  ChronosApiClient,
  ChronosApiError,
  eventTone,
  nearestEvent,
  normalizeBaseUrl,
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
