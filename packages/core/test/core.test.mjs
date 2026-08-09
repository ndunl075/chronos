import assert from "node:assert/strict";
import test from "node:test";

import { canonicalEnvelope, logicalSequence } from "@chronos/protocol";
import {
  CoreDomainError,
  computeEventCapabilities,
  computeReplayContext,
  indexSession,
  prepareBranchPlan,
  resolveVisibleEvents,
} from "../dist/index.js";

const seq = logicalSequence;
const session = Object.freeze({
  id: "s1",
  source: "fixture",
  createdAt: "2026-08-09T00:00:00Z",
});
const root = Object.freeze({ id: "root", sessionId: "s1", state: "ready" });
const child = Object.freeze({
  id: "child",
  sessionId: "s1",
  parentId: "root",
  forkSeq: seq(2),
  state: "ready",
});
const grandchild = Object.freeze({
  id: "grand",
  sessionId: "s1",
  parentId: "child",
  forkSeq: seq(3),
  state: "ready",
});

function event(id, branchId, number, kind = "assistant_message") {
  return {
    id,
    branchId,
    seq: seq(number),
    kind,
    occurredAt: "2026-08-09T00:00:00Z",
    summary: id,
    payload: canonicalEnvelope({ id }),
  };
}

function graph(overrides = {}) {
  return {
    session,
    branches: [root, child, grandchild],
    events: [
      event("r1", "root", 1, "checkpoint"),
      event("r2", "root", 2),
      event("r3-hidden", "root", 3),
      event("c3", "child", 3, "filesystem_change"),
      event("c4-hidden", "child", 4),
      event("g4", "grand", 4),
    ],
    checkpoints: [
      {
        id: "cp1",
        branchId: "root",
        eventSeq: seq(1),
        manifestRef: "sha256:1",
      },
    ],
    ...overrides,
  };
}

function expectCode(code, action) {
  assert.throws(
    action,
    (error) => error instanceof CoreDomainError && error.code === code,
  );
}

test("indexes a root and resolves nested fork ancestry in logical order", () => {
  const index = indexSession(graph());
  assert.equal(index.rootBranchId, "root");
  assert.deepEqual(
    resolveVisibleEvents(index, "grand").map((item) => item.id),
    ["r1", "r2", "c3", "g4"],
  );
  assert.deepEqual(
    computeReplayContext(index, "grand", seq(3)).map((item) => [
      item.eventId,
      item.sourceBranchId,
    ]),
    [
      ["r1", "root"],
      ["r2", "root"],
      ["c3", "child"],
    ],
  );
});

test("computes exact, delta, missing-delta, no-checkpoint, and state capabilities", () => {
  const index = indexSession(graph());
  assert.equal(
    computeEventCapabilities(index, "root", seq(1)).branchability.reconstruction
      .kind,
    "exact",
  );
  const delta = computeEventCapabilities(index, "grand", seq(4), {
    availableDeltaEventIds: ["c3"],
  });
  assert.deepEqual(delta.branchability.reconstruction.deltaEventSeqs, [3]);
  assert.equal(
    computeEventCapabilities(index, "grand", seq(4)).branchability.reason,
    "missing_delta",
  );

  const noCheckpoint = indexSession(graph({ checkpoints: [] }));
  assert.equal(
    computeEventCapabilities(noCheckpoint, "root", seq(1)).branchability.reason,
    "no_checkpoint",
  );
});

test("prepares a frozen branch state-transition intent without executing I/O", () => {
  const index = indexSession(graph());
  const plan = prepareBranchPlan(index, {
    id: "new",
    parentBranchId: "grand",
    forkSeq: seq(4),
    instruction: "Try another approach",
    evidence: { availableDeltaEventIds: ["c3"] },
  });
  assert.deepEqual(plan.branch, {
    id: "new",
    sessionId: "s1",
    parentId: "grand",
    forkSeq: 4,
    state: "preparing",
  });
  assert.deepEqual(plan.completionTransition, {
    from: "preparing",
    success: "ready",
    failure: "failed",
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.context), true);
  assert.equal(Object.isFrozen(plan.context[0].payload.data), true);
  assert.throws(() => {
    plan.context[0].payload.data.id = "mutated";
  }, TypeError);
});

test("rejects malformed roots, parents, sessions, forks, cycles, and target ranges", () => {
  expectCode("MISSING_ROOT", () =>
    indexSession(graph({ branches: [], events: [], checkpoints: [] })),
  );
  expectCode("MULTIPLE_ROOTS", () =>
    indexSession(
      graph({
        branches: [root, { id: "root2", sessionId: "s1", state: "ready" }],
        events: [],
        checkpoints: [],
      }),
    ),
  );
  expectCode("MISSING_PARENT", () =>
    indexSession(
      graph({
        branches: [root, { ...child, parentId: "absent" }],
        events: [event("r1", "root", 1), event("r2", "root", 2)],
        checkpoints: [],
      }),
    ),
  );
  expectCode("INVALID_BRANCH", () =>
    indexSession(
      graph({
        branches: [{ ...root, sessionId: "other" }],
        events: [],
        checkpoints: [],
      }),
    ),
  );
  expectCode("INVALID_FORK", () =>
    indexSession(
      graph({
        branches: [root, { ...child, forkSeq: seq(3) }],
        events: [
          event("r1", "root", 1),
          event("r2", "root", 2),
          event("c4", "child", 4),
        ],
        checkpoints: [],
      }),
    ),
  );
  expectCode("BRANCH_CYCLE", () =>
    indexSession(
      graph({
        branches: [
          root,
          {
            id: "a",
            sessionId: "s1",
            parentId: "b",
            forkSeq: seq(1),
            state: "ready",
          },
          {
            id: "b",
            sessionId: "s1",
            parentId: "a",
            forkSeq: seq(1),
            state: "ready",
          },
        ],
        events: [event("r1", "root", 1)],
        checkpoints: [],
      }),
    ),
  );
  const index = indexSession(graph());
  expectCode("INVALID_TARGET", () => resolveVisibleEvents(index, "root", 0));
  expectCode("UNKNOWN_EVENT", () =>
    resolveVisibleEvents(index, "child", seq(5)),
  );
});

test("rejects duplicate, non-monotonic, non-contiguous, and wrong-owner records", () => {
  expectCode("DUPLICATE_BRANCH", () =>
    indexSession(
      graph({ branches: [root, root], events: [], checkpoints: [] }),
    ),
  );
  expectCode("DUPLICATE_EVENT", () =>
    indexSession(
      graph({
        branches: [root],
        events: [event("same", "root", 1), event("same", "root", 2)],
        checkpoints: [],
      }),
    ),
  );
  expectCode("NON_MONOTONIC_EVENT", () =>
    indexSession(
      graph({
        branches: [root],
        events: [event("r2", "root", 2), event("r1", "root", 1)],
        checkpoints: [],
      }),
    ),
  );
  expectCode("NON_CONTIGUOUS_EVENT", () =>
    indexSession(
      graph({
        branches: [root],
        events: [event("r2", "root", 2)],
        checkpoints: [],
      }),
    ),
  );
  expectCode("UNKNOWN_BRANCH", () =>
    indexSession(
      graph({
        branches: [root],
        events: [event("x", "absent", 1)],
        checkpoints: [],
      }),
    ),
  );
  expectCode("INVALID_CHECKPOINT", () =>
    indexSession(
      graph({
        branches: [root],
        events: [event("r1", "root", 1)],
        checkpoints: [
          { id: "cp", branchId: "child", eventSeq: seq(1), manifestRef: "x" },
        ],
      }),
    ),
  );
});

test("rejects non-branchable plans and duplicate branch ids", () => {
  const index = indexSession(graph());
  expectCode("NOT_BRANCHABLE", () =>
    prepareBranchPlan(index, {
      id: "new",
      parentBranchId: "grand",
      forkSeq: seq(4),
      instruction: "retry",
    }),
  );
  expectCode("DUPLICATE_NEW_BRANCH", () =>
    prepareBranchPlan(index, {
      id: "child",
      parentBranchId: "root",
      forkSeq: seq(1),
      instruction: "retry",
    }),
  );
  expectCode("INVALID_INSTRUCTION", () =>
    prepareBranchPlan(index, {
      id: "new",
      parentBranchId: "root",
      forkSeq: seq(1),
      instruction: " ",
    }),
  );
});

test("input mutation cannot alter the indexed snapshot", () => {
  const mutable = graph();
  const index = indexSession(mutable);
  mutable.events[0].summary = "changed";
  mutable.events[0].payload.data.id = "changed";
  assert.equal(resolveVisibleEvents(index, "root", seq(1))[0].summary, "r1");
  assert.equal(
    resolveVisibleEvents(index, "root", seq(1))[0].payload.data.id,
    "r1",
  );
});

test("rejects unsafe records, timestamps, raw metadata, and lifecycle violations", () => {
  expectCode("INVALID_SESSION", () =>
    indexSession(graph({ session: { ...session, extra: true } })),
  );
  expectCode("INVALID_SESSION", () =>
    indexSession(
      graph({ session: { ...session, createdAt: "2026-02-30T00:00:00Z" } }),
    ),
  );
  const accessor = { source: "fixture", createdAt: session.createdAt };
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get() {
      throw new Error("unsafe");
    },
  });
  expectCode("INVALID_SESSION", () =>
    indexSession(graph({ session: accessor })),
  );
  expectCode("INVALID_EVENT", () =>
    indexSession(
      graph({
        branches: [root],
        checkpoints: [],
        events: [
          {
            ...event("r1", "root", 1),
            rawEnvelope: {
              schemaVersion: 1,
              ref: "raw",
              retention: "opt_in",
              protection: "plaintext",
            },
          },
        ],
      }),
    ),
  );
  expectCode("INVALID_BRANCH", () =>
    indexSession(
      graph({
        branches: [{ ...root, state: "failed" }, child],
        events: [],
        checkpoints: [],
      }),
    ),
  );
  expectCode("INVALID_EVENT", () =>
    indexSession(
      graph({
        branches: [{ ...root, state: "preparing" }],
        events: [event("r1", "root", 1)],
        checkpoints: [],
      }),
    ),
  );
});

test("rejects duplicate checkpoints and malicious evidence", () => {
  expectCode("DUPLICATE_CHECKPOINT", () =>
    indexSession(
      graph({
        branches: [root],
        events: [event("r1", "root", 1)],
        checkpoints: [
          { id: "same", branchId: "root", eventSeq: seq(1), manifestRef: "a" },
          { id: "same", branchId: "root", eventSeq: seq(1), manifestRef: "b" },
        ],
      }),
    ),
  );
  const index = indexSession(graph());
  expectCode("INVALID_EVIDENCE", () =>
    computeEventCapabilities(index, "root", seq(1), {
      redactedEventIds: ["absent"],
    }),
  );
  expectCode("INVALID_EVIDENCE", () =>
    computeEventCapabilities(
      index,
      "root",
      seq(1),
      Object.create({ redactedEventIds: ["r1"] }),
    ),
  );
  expectCode("UNKNOWN_BRANCH", () => resolveVisibleEvents(index, {}));
});

test("falls back to an older checkpoint and marks redacted replay immutably", () => {
  const index = indexSession(
    graph({
      branches: [root],
      events: [
        event("r1", "root", 1, "checkpoint"),
        event("r2", "root", 2, "checkpoint"),
        event("r3", "root", 3, "filesystem_change"),
      ],
      checkpoints: [
        { id: "old", branchId: "root", eventSeq: seq(1), manifestRef: "old" },
        { id: "new", branchId: "root", eventSeq: seq(2), manifestRef: "new" },
      ],
    }),
  );
  const result = computeEventCapabilities(index, "root", seq(3), {
    availableDeltaEventIds: ["r3"],
    redactedEventIds: ["r3"],
    unusableCheckpoints: [{ checkpointId: "new", reason: "invalid_manifest" }],
  });
  assert.equal(result.branchability.reconstruction.checkpointId, "old");
  assert.equal(result.replayability.reason, "required_data_redacted");
  assert.equal(Object.isFrozen(result.branchability.reconstruction), true);
  const failure = computeEventCapabilities(index, "root", seq(3), {
    unusableCheckpoints: [{ checkpointId: "new", reason: "invalid_manifest" }],
  });
  assert.equal(failure.branchability.reason, "invalid_manifest");
});

test("resolves increasing-history leaf-first lineage without cached prefixes", () => {
  const branches = [];
  const events = [event("r1", "root", 1)];
  for (let number = 1500; number >= 1; number -= 1)
    branches.push({
      id: `b${number}`,
      sessionId: "s1",
      parentId: number === 1 ? "root" : `b${number - 1}`,
      forkSeq: seq(number),
      state: "ready",
    });
  for (let number = 1; number <= 1500; number += 1)
    events.push(event(`e${number + 1}`, `b${number}`, number + 1));
  branches.push(root);
  const index = indexSession(graph({ branches, events, checkpoints: [] }));
  const visible = resolveVisibleEvents(index, "b1500");
  assert.equal(visible.length, 1501);
  assert.equal(visible[0].id, "r1");
  assert.equal(visible.at(-1).id, "e1501");
});

test("no SessionIndex return surface exposes mutable index state", () => {
  const index = indexSession(graph());
  const exposed = index._branch("root");
  assert.equal(Object.isFrozen(exposed), true);
  assert.equal(Reflect.ownKeys(exposed).includes("ownedSequences"), false);
  assert.throws(
    () => exposed.ownedEvents.push(event("x", "root", 4)),
    TypeError,
  );
  assert.throws(() => {
    exposed.branch.state = "failed";
  }, TypeError);
  assert.throws(() => index._checkpoints().push({}), TypeError);
  assert.throws(() => {
    index._event("r1").payload.data.id = "changed";
  }, TypeError);
  assert.deepEqual(
    resolveVisibleEvents(index, "root").map((item) => item.id),
    ["r1", "r2", "r3-hidden"],
  );
});

test("materializes a single branch above JavaScript argument limits", () => {
  const eventCount = 130_000;
  const events = new Array(eventCount);
  for (let index = 0; index < eventCount; index += 1) {
    events[index] = event(`large-${index + 1}`, "root", index + 1);
  }
  const index = indexSession(
    graph({ branches: [root], events, checkpoints: [] }),
  );
  const visible = resolveVisibleEvents(index, "root");
  assert.equal(visible.length, eventCount);
  assert.equal(visible[0].id, "large-1");
  assert.equal(visible.at(-1).id, `large-${eventCount}`);
});
