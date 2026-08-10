import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalEnvelope, logicalSequence } from "@chronos/protocol";
import {
  ContentStore,
  captureWorkspace,
  diffManifests,
  serializeManifest,
  serializeManifestDiff,
} from "@chronos/snapshots";
import {
  ChronosRepository,
  IN_MEMORY_PATH,
  openStorage,
} from "@chronos/storage";

import { BranchError, createBranch } from "../dist/index.js";

const seq = logicalSequence;
const OCCURRED_AT = "2026-08-09T00:00:00Z";

function event(id, number, kind = "assistant_message") {
  return {
    id,
    branchId: "root",
    seq: seq(number),
    kind,
    occurredAt: OCCURRED_AT,
    summary: `summary for ${id}`,
    payload: canonicalEnvelope({ id }),
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-branching-"));
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => {
    storage.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  });

  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "upload.ts"),
    "export const retries = 0;\n",
  );

  const store = new ContentStore({ root: join(root, "store") });
  const { manifest } = captureWorkspace({ workspaceRoot: workspace, store });
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(manifest), "utf8")),
  );

  const repository = new ChronosRepository(storage);
  repository.insertSession({
    id: "s1",
    source: "fixture",
    createdAt: OCCURRED_AT,
  });
  repository.insertBranch({ id: "root", sessionId: "s1", state: "ready" });
  repository.appendEvents([
    event("r1", 1, "instruction"),
    event("r2", 2, "filesystem_change"),
    event("r3", 3),
  ]);
  repository.insertCheckpoint({
    id: "cp2",
    branchId: "root",
    eventSeq: seq(2),
    manifestRef,
  });

  return {
    repository,
    store,
    manifest,
    workspacesRoot: join(root, "workspaces"),
    request(overrides = {}) {
      return {
        repository,
        store,
        workspacesRoot: join(root, "workspaces"),
        sessionId: "s1",
        parentBranchId: "root",
        forkSeq: seq(2),
        instruction: "use a real backoff",
        ...overrides,
      };
    },
  };
}

function code(expected) {
  return (error) => {
    assert.ok(error instanceof BranchError, `expected a BranchError: ${error}`);
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

test("a branch reconstructs its workspace and owns its instruction", (t) => {
  const box = fixture(t);

  const created = createBranch(box.request({ branchId: "retry" }));

  assert.deepEqual(created.branch, {
    id: "retry",
    sessionId: "s1",
    parentId: "root",
    forkSeq: 2,
    state: "ready",
  });
  assert.equal(
    created.launchPlan.workspacePath,
    join(box.workspacesRoot, "retry"),
  );
  assert.equal(created.launchPlan.instruction, "use a real backoff");
  assert.deepEqual(
    created.launchPlan.context.map((item) => item.eventId),
    ["r1", "r2"],
  );
  assert.equal(
    readFileSync(
      join(created.launchPlan.workspacePath, "src", "upload.ts"),
      "utf8",
    ),
    "export const retries = 0;\n",
  );

  assert.equal(created.instructionEvent.seq, 3);
  assert.equal(created.instructionEvent.kind, "instruction");
  const owned = box.repository.listEvents("retry");
  assert.deepEqual(
    owned.map((item) => item.id),
    [created.instructionEvent.id],
  );
});

test("a branch reconstructs through an ordered delta chain", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chronos-branching-delta-"));
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => {
    storage.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  });

  const baseWorkspace = join(root, "base");
  mkdirSync(join(baseWorkspace, "src"), { recursive: true });
  writeFileSync(join(baseWorkspace, "src", "upload.ts"), "export const retries = 0;\n");
  writeFileSync(join(baseWorkspace, "keep.txt"), "same\n");

  const store = new ContentStore({ root: join(root, "store") });
  const { manifest: baseManifest } = captureWorkspace({
    workspaceRoot: baseWorkspace,
    store,
  });
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(baseManifest), "utf8")),
  );

  writeFileSync(join(baseWorkspace, "src", "upload.ts"), "export const retries = 3;\n");
  writeFileSync(join(baseWorkspace, "src", "backoff.ts"), "export const delay = 10;\n");
  rmSync(join(baseWorkspace, "keep.txt"));
  const { manifest: targetManifest } = captureWorkspace({
    workspaceRoot: baseWorkspace,
    store,
  });
  const diff = diffManifests(baseManifest, targetManifest);
  const diffRef = store.put(
    new Uint8Array(Buffer.from(serializeManifestDiff(diff), "utf8")),
  );

  const repository = new ChronosRepository(storage);
  repository.insertSession({
    id: "s1",
    source: "fixture",
    createdAt: OCCURRED_AT,
  });
  repository.insertBranch({ id: "root", sessionId: "s1", state: "ready" });
  repository.appendEvents([
    event("r1", 1, "instruction"),
    event("r2", 2, "filesystem_change"),
    event("r3", 3, "filesystem_change"),
  ]);
  repository.insertCheckpoint({
    id: "cp2",
    branchId: "root",
    eventSeq: seq(2),
    manifestRef,
  });
  repository.insertDelta({
    id: "d3",
    branchId: "root",
    eventSeq: seq(3),
    diffRef,
  });

  const created = createBranch({
    repository,
    store,
    workspacesRoot: join(root, "workspaces"),
    sessionId: "s1",
    parentBranchId: "root",
    forkSeq: seq(3),
    instruction: "keep the backoff",
    branchId: "retry",
  });

  assert.equal(
    readFileSync(
      join(created.launchPlan.workspacePath, "src", "upload.ts"),
      "utf8",
    ),
    "export const retries = 3;\n",
  );
  assert.equal(
    readFileSync(
      join(created.launchPlan.workspacePath, "src", "backoff.ts"),
      "utf8",
    ),
    "export const delay = 10;\n",
  );
  assert.equal(
    existsSync(join(created.launchPlan.workspacePath, "keep.txt")),
    false,
  );
});

test("an id is generated when the caller does not choose one", (t) => {
  const box = fixture(t);

  const first = createBranch(box.request());
  const second = createBranch(box.request({ instruction: "and another" }));

  assert.notEqual(first.branch.id, second.branch.id);
  assert.equal(first.branch.state, "ready");
  assert.equal(second.branch.state, "ready");
});

test("an event with no reconstructable state is refused before lineage exists", (t) => {
  const box = fixture(t);

  assert.throws(
    () => createBranch(box.request({ forkSeq: seq(1) })),
    code("NOT_BRANCHABLE"),
  );
  assert.deepEqual(
    box.repository.listBranches("s1").map((branch) => branch.id),
    ["root"],
  );
});

test("a reconstruction that fails leaves the branch recorded as failed", (t) => {
  const box = fixture(t);
  rmSync(box.store.blobPath(box.manifest.files[0].digest));

  assert.throws(
    () => createBranch(box.request({ branchId: "doomed" })),
    code("RESTORE_FAILED"),
  );

  assert.equal(box.repository.getBranch("doomed").state, "failed");
  assert.equal(box.repository.countEvents("doomed"), 0);
});

test("requests are validated before any work begins", (t) => {
  const box = fixture(t);

  assert.throws(
    () => createBranch(box.request({ instruction: "   " })),
    code("INVALID_REQUEST"),
  );
  assert.throws(
    () => createBranch(box.request({ forkSeq: 0 })),
    code("INVALID_REQUEST"),
  );
  assert.throws(
    () => createBranch(box.request({ branchId: "" })),
    code("INVALID_REQUEST"),
  );
  assert.throws(
    () => createBranch(box.request({ branchId: "root" })),
    code("INVALID_REQUEST"),
  );
  assert.throws(
    () => createBranch(box.request({ parentBranchId: "missing" })),
    code("UNKNOWN_TARGET"),
  );
  assert.throws(
    () => createBranch(box.request({ forkSeq: seq(99) })),
    code("UNKNOWN_TARGET"),
  );
  assert.throws(
    () => createBranch(box.request({ sessionId: "missing" })),
    code("UNKNOWN_SESSION"),
  );
  assert.equal(box.repository.listBranches("s1").length, 1);
});

test("the stored instruction is redacted", (t) => {
  const box = fixture(t);

  const created = createBranch(
    box.request({ instruction: "redeploy with AKIAIOSFODNN7EXAMPLE" }),
  );

  assert.equal(
    created.launchPlan.instruction,
    "redeploy with [redacted:aws key]",
  );
  assert.deepEqual(created.instructionEvent.payload.data, {
    text: "redeploy with [redacted:aws key]",
  });
});
