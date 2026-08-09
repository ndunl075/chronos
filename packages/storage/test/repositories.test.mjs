import assert from "node:assert/strict";
import test from "node:test";

import {
  computeEventCapabilities,
  indexSession,
  prepareBranchPlan,
  resolveVisibleEvents,
} from "@chronos/core";
import { canonicalEnvelope, logicalSequence } from "@chronos/protocol";
import {
  ChronosRepository,
  IN_MEMORY_PATH,
  openStorage,
} from "../dist/index.js";

const seq = logicalSequence;
const OCCURRED_AT = "2026-08-09T00:00:00Z";
const SESSION = Object.freeze({
  id: "s1",
  source: "chronos-jsonl",
  createdAt: OCCURRED_AT,
});
const ROOT = Object.freeze({ id: "root", sessionId: "s1", state: "ready" });

function event(id, branchId, number, kind = "assistant_message", extra = {}) {
  return {
    id,
    branchId,
    seq: seq(number),
    kind,
    occurredAt: OCCURRED_AT,
    summary: id,
    payload: canonicalEnvelope({ id }),
    ...extra,
  };
}

function openRepository(t) {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  const repository = new ChronosRepository(storage);
  repository.insertSession(SESSION);
  repository.insertBranch(ROOT);
  return repository;
}

function code(expected) {
  return (error) => {
    assert.equal(
      error.code,
      expected,
      `expected ${expected}: ${error.message}`,
    );
    return true;
  };
}

test("canonical records round-trip through the repositories", (t) => {
  const repository = openRepository(t);
  const withRaw = event("r2", "root", 2, "tool_call", {
    rawEnvelope: {
      schemaVersion: 1,
      ref: "raw:0001",
      retention: "opt_in",
      protection: "encrypted_restricted_store",
      mediaType: "application/json",
      sourceSchemaVersion: "vendor-2",
    },
  });

  const appended = repository.appendEvents([
    event("r1", "root", 1, "instruction"),
    withRaw,
  ]);
  const checkpoint = repository.insertCheckpoint({
    id: "cp1",
    branchId: "root",
    eventSeq: seq(2),
    manifestRef: "sha256:abc",
  });

  assert.deepEqual(repository.getSession("s1"), SESSION);
  assert.deepEqual(repository.listSessions(), [SESSION]);
  assert.deepEqual(repository.getBranch("root"), ROOT);
  assert.deepEqual(repository.getEvent("r2"), withRaw);
  assert.deepEqual(
    appended.map((item) => item.id),
    ["r1", "r2"],
  );
  assert.deepEqual(repository.listCheckpoints("root"), [checkpoint]);
  assert.equal(repository.countEvents("root"), 2);
  assert.equal(repository.getSession("missing"), undefined);
  assert.equal(repository.getEvent("missing"), undefined);
});

test("timeline pages are ordered, bounded, and payload-free", (t) => {
  const repository = openRepository(t);
  repository.appendEvents(
    [1, 2, 3, 4, 5].map((number) => event(`r${number}`, "root", number)),
  );

  assert.deepEqual(
    repository.listEventSummaries("root", { limit: 2 }).map((item) => item.id),
    ["r1", "r2"],
  );
  assert.deepEqual(
    repository
      .listEventSummaries("root", { fromSeq: seq(4) })
      .map((item) => item.seq),
    [4, 5],
  );
  assert.deepEqual(Object.keys(repository.listEventSummaries("root")[0]), [
    "id",
    "branchId",
    "seq",
    "kind",
    "occurredAt",
    "summary",
    "hasRawEnvelope",
  ]);
  assert.deepEqual(
    repository.listEvents("root", { fromSeq: seq(5) }).map((item) => item.id),
    ["r5"],
  );

  assert.throws(
    () => repository.listEvents("root", { limit: 0 }),
    code("INVALID_PAGE"),
  );
  assert.throws(
    () => repository.listEvents("root", { limit: 1001 }),
    code("INVALID_PAGE"),
  );
  assert.throws(
    () => repository.listEvents("root", { fromSeq: 0 }),
    code("INVALID_PAGE"),
  );
});

test("an event batch lands atomically", (t) => {
  const repository = openRepository(t);

  assert.throws(
    () =>
      repository.appendEvents([
        event("r1", "root", 1),
        event("gap", "root", 3),
      ]),
    code("CONSTRAINT_VIOLATION"),
  );
  assert.equal(repository.countEvents("root"), 0);

  repository.appendEvents([event("r1", "root", 1)]);
  assert.throws(
    () => repository.appendEvents([event("r1", "root", 2)]),
    code("DUPLICATE_RECORD"),
  );
  assert.equal(repository.countEvents("root"), 1);
  assert.deepEqual(repository.appendEvents([]), []);
});

test("invalid records are rejected before they reach the database", (t) => {
  const repository = openRepository(t);

  assert.throws(
    () => repository.appendEvents([event("bad", "root", 1, "speculation")]),
    code("INVALID_RECORD"),
  );
  assert.throws(
    () =>
      repository.appendEvents([
        { ...event("bad", "root", 1), payload: { id: "unwrapped" } },
      ]),
    code("INVALID_RECORD"),
  );
  assert.throws(
    () => repository.insertBranch({ id: "", sessionId: "s1", state: "ready" }),
    code("INVALID_RECORD"),
  );
  assert.throws(
    () =>
      repository.insertCheckpoint({
        id: "cp",
        branchId: "root",
        eventSeq: 0,
        manifestRef: "sha256:abc",
      }),
    code("INVALID_RECORD"),
  );
  assert.equal(repository.countEvents("root"), 0);
});

test("a branch settles exactly once", (t) => {
  const repository = openRepository(t);
  repository.appendEvents([event("r1", "root", 1)]);
  const child = repository.insertBranch({
    id: "child",
    sessionId: "s1",
    parentId: "root",
    forkSeq: seq(1),
    state: "preparing",
  });

  assert.equal(child.state, "preparing");
  assert.equal(repository.settleBranch("child", "ready").state, "ready");
  assert.throws(
    () => repository.settleBranch("child", "failed"),
    code("INVALID_STATE_TRANSITION"),
  );
  assert.throws(
    () => repository.settleBranch("missing", "ready"),
    code("UNKNOWN_RECORD"),
  );
  assert.throws(
    () => repository.settleBranch("child", "preparing"),
    code("INVALID_RECORD"),
  );
});

test("a rolled-back transaction leaves no partial lineage", (t) => {
  const repository = openRepository(t);
  repository.appendEvents([event("r1", "root", 1)]);

  assert.throws(() =>
    repository.transaction(() => {
      repository.insertBranch({
        id: "child",
        sessionId: "s1",
        parentId: "root",
        forkSeq: seq(1),
        state: "preparing",
      });
      repository.appendEvents([event("c2", "child", 2)]);
    }),
  );

  assert.equal(repository.getBranch("child"), undefined);
  assert.equal(repository.countEvents("child"), 0);
});

test("a stored session graph is indexable by the domain core", (t) => {
  const repository = openRepository(t);
  repository.appendEvents([
    event("r1", "root", 1, "instruction"),
    event("r2", "root", 2, "filesystem_change"),
    event("r3", "root", 3),
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
    repository.appendEvents([event("c3", "child", 3, "instruction")]);
  });

  const graph = repository.loadSessionGraph("s1");
  assert.deepEqual(
    graph.events.map((item) => item.id),
    ["c3", "r1", "r2", "r3"],
  );

  const index = indexSession(graph);
  assert.deepEqual(
    resolveVisibleEvents(index, "child").map((item) => item.id),
    ["r1", "r2", "c3"],
  );

  const capabilities = computeEventCapabilities(index, "child", seq(3));
  assert.equal(capabilities.branchability.status, "branchable");
  assert.equal(capabilities.branchability.reconstruction.checkpointId, "cp2");

  const plan = prepareBranchPlan(index, {
    id: "grandchild",
    parentBranchId: "child",
    forkSeq: seq(3),
    instruction: "try the other fix",
  });
  const persisted = repository.insertBranch(plan.branch);
  assert.deepEqual(persisted, plan.branch);
  assert.deepEqual(
    plan.context.map((item) => item.eventId),
    ["r1", "r2", "c3"],
  );

  assert.throws(
    () => repository.loadSessionGraph("missing"),
    code("UNKNOWN_RECORD"),
  );
});
