import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { canonicalEnvelope, logicalSequence } from "@chronos/protocol";
import {
  ChronosRepository,
  IN_MEMORY_PATH,
  openStorage,
} from "@chronos/storage";

import { startServer } from "../dist/index.js";

const seq = logicalSequence;
const OCCURRED_AT = "2026-08-09T00:00:00Z";

function event(id, branchId, number, kind = "assistant_message") {
  return {
    id,
    branchId,
    seq: seq(number),
    kind,
    occurredAt: OCCURRED_AT,
    summary: `summary for ${id}`,
    payload: canonicalEnvelope({ id }),
  };
}

/**
 * A session with a fork: the root owns 1..4 and a child forks at 2 and owns
 * 3..4, so inherited history and owned history are both exercised.
 */
function seed(repository) {
  repository.insertSession({
    id: "s1",
    source: "chronos-jsonl",
    createdAt: OCCURRED_AT,
  });
  repository.insertBranch({ id: "root", sessionId: "s1", state: "ready" });
  repository.appendEvents([
    event("r1", "root", 1, "instruction"),
    event("r2", "root", 2, "filesystem_change"),
    event("r3", "root", 3),
    event("r4", "root", 4),
  ]);
  repository.insertCheckpoint({
    id: "cp2",
    branchId: "root",
    eventSeq: seq(2),
    manifestRef: "sha256:abc",
  });
  repository.transaction(() => {
    repository.insertBranch({
      id: "child",
      sessionId: "s1",
      parentId: "root",
      forkSeq: seq(2),
      state: "preparing",
    });
    repository.settleBranch("child", "ready");
    repository.appendEvents([
      event("c3", "child", 3, "instruction"),
      event("c4", "child", 4),
    ]);
  });
  repository.insertSession({
    id: "failed-session",
    source: "codex-record",
    createdAt: OCCURRED_AT,
  });
  repository.insertBranch({
    id: "failed-root",
    sessionId: "failed-session",
    state: "preparing",
  });
  repository.appendEvents([
    event("failed-instruction", "failed-root", 1, "instruction"),
    event("failed-terminal", "failed-root", 2, "error"),
  ]);
  repository.settleBranch("failed-root", "failed");
}

async function serve(t) {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  const repository = new ChronosRepository(storage);
  seed(repository);
  const server = await startServer({ repository });
  t.after(() => server.close());
  return server;
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: "GET",
        headers: {
          host: `127.0.0.1:${server.port}`,
          authorization: `Bearer ${server.token}`,
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
    call.on("error", reject);
    call.end();
  });
}

test("sessions and their lineage are listed", async (t) => {
  const server = await serve(t);

  const list = await get(server, "/sessions");
  assert.equal(list.status, 200);
  assert.equal(list.body.schemaVersion, 1);
  assert.equal(list.body.total, 2);
  assert.deepEqual(
    list.body.items.map((session) => session.id),
    ["failed-session", "s1"],
  );

  const overview = await get(server, "/sessions/s1");
  assert.equal(overview.status, 200);
  assert.equal(overview.body.data.session.id, "s1");
  assert.deepEqual(
    overview.body.data.branches.map((branch) => branch.id),
    ["root", "child"],
  );

  assert.equal((await get(server, "/sessions/missing")).status, 404);
});

test("owned events page as payload-free summaries", async (t) => {
  const server = await serve(t);

  const firstPage = await get(server, "/branches/root/events?limit=2");
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.total, 4);
  assert.deepEqual(
    firstPage.body.items.map((item) => item.id),
    ["r1", "r2"],
  );
  assert.equal(firstPage.body.nextSeq, 3);
  assert.equal(firstPage.body.items[0].payload, undefined);
  assert.equal(firstPage.body.items[0].hasRawEnvelope, false);

  const lastPage = await get(server, "/branches/root/events?fromSeq=3&limit=2");
  assert.deepEqual(
    lastPage.body.items.map((item) => item.id),
    ["r3", "r4"],
  );
  assert.equal(lastPage.body.nextSeq, 5);

  const beyond = await get(server, "/branches/root/events?fromSeq=9");
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.nextSeq, undefined);
});

test("a branch timeline resolves inherited history", async (t) => {
  const server = await serve(t);

  const child = await get(server, "/branches/child/timeline");
  assert.equal(child.status, 200);
  assert.deepEqual(
    child.body.items.map((item) => `${item.branchId}:${item.seq}`),
    ["root:1", "root:2", "child:3", "child:4"],
  );
  assert.equal(child.body.total, 4);

  const through = await get(server, "/branches/child/timeline?through=3");
  assert.deepEqual(
    through.body.items.map((item) => item.id),
    ["r1", "r2", "c3"],
  );

  const root = await get(server, "/branches/root/timeline");
  assert.deepEqual(
    root.body.items.map((item) => item.id),
    ["r1", "r2", "r3", "r4"],
  );
});

test("failed recording history is readable but never branchable", async (t) => {
  const server = await serve(t);
  const timeline = await get(server, "/branches/failed-root/timeline");
  assert.equal(timeline.status, 200);
  assert.deepEqual(
    timeline.body.items.map((event) => event.id),
    ["failed-instruction", "failed-terminal"],
  );
  const capability = await get(
    server,
    "/branches/failed-root/events/2/capabilities",
  );
  assert.equal(capability.status, 200);
  assert.deepEqual(capability.body.data.branchability, {
    status: "unavailable",
    reason: "branch_not_ready",
  });
});

test("an event detail carries its canonical payload", async (t) => {
  const server = await serve(t);

  const detail = await get(server, "/events/r2");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data, {
    id: "r2",
    branchId: "root",
    seq: 2,
    kind: "filesystem_change",
    occurredAt: OCCURRED_AT,
    summary: "summary for r2",
    payload: { schemaVersion: 1, data: { id: "r2" } },
  });

  assert.equal((await get(server, "/events/missing")).status, 404);
});

test("checkpoints and capabilities describe what can be branched from", async (t) => {
  const server = await serve(t);

  const checkpoints = await get(server, "/branches/root/checkpoints");
  assert.deepEqual(checkpoints.body.items, [
    { id: "cp2", branchId: "root", eventSeq: 2, manifestRef: "sha256:abc" },
  ]);

  const branchable = await get(server, "/branches/child/events/3/capabilities");
  assert.equal(branchable.status, 200);
  assert.deepEqual(branchable.body.data, {
    eventId: "c3",
    replayability: { status: "replayable" },
    branchability: {
      status: "branchable",
      reconstruction: {
        kind: "exact",
        checkpointId: "cp2",
        checkpointEventSeq: 2,
        effectiveRestoreSeq: 3,
      },
    },
  });

  const beforeCheckpoint = await get(
    server,
    "/branches/root/events/1/capabilities",
  );
  assert.deepEqual(beforeCheckpoint.body.data.branchability, {
    status: "unavailable",
    reason: "no_checkpoint",
  });
});

test("bad coordinates and unknown records answer with a status, not a stack", async (t) => {
  const server = await serve(t);

  for (const [path, status] of [
    ["/branches/missing/events", 404],
    ["/branches/missing/checkpoints", 404],
    ["/branches/missing/timeline", 404],
    ["/branches/root/events?limit=0", 400],
    ["/branches/root/events?limit=9999", 400],
    ["/branches/root/events?fromSeq=0", 400],
    ["/branches/root/timeline?through=abc", 400],
    ["/branches/root/events/0/capabilities", 400],
    ["/branches/root/events/99/capabilities", 404],
  ]) {
    const response = await get(server, path);
    assert.equal(response.status, status, path);
    assert.equal(typeof response.body.error.message, "string", path);
    assert.equal(response.body.error.message.includes("SELECT"), false, path);
  }
});
