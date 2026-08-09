import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalEnvelope, logicalSequence } from "@chronos/protocol";
import {
  ContentStore,
  captureWorkspace,
  serializeManifest,
} from "@chronos/snapshots";
import {
  ChronosRepository,
  IN_MEMORY_PATH,
  openStorage,
} from "@chronos/storage";

import { startServer } from "../dist/index.js";

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

/**
 * A real workspace, captured into a real store, recorded as a checkpoint on a
 * real session: the branch endpoint is only meaningful end to end.
 */
async function serve(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-branching-"));
  t.after(() => rmSync(root, { force: true, recursive: true, maxRetries: 5 }));

  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "readme");
  writeFileSync(
    join(workspace, "src", "upload.ts"),
    "export const retries = 0;\n",
  );

  const store = new ContentStore({ root: join(root, "store") });
  const { manifest } = captureWorkspace({ workspaceRoot: workspace, store });
  // A manifest is itself a blob, so its address is the checkpoint reference.
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(manifest), "utf8")),
  );
  assert.equal(manifestRef, manifest.ref);

  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
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

  const workspacesRoot = join(root, "workspaces");
  const server = await startServer({
    repository,
    branching: { store, workspacesRoot },
  });
  t.after(() => server.close());
  return { server, repository, workspacesRoot, store, manifest };
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

function branch(server, body) {
  return call(server, { method: "POST", path: "/sessions/s1/branches", body });
}

test("a branch reconstructs its workspace and settles ready", async (t) => {
  const { server, repository, workspacesRoot } = await serve(t);

  const created = await branch(server, {
    id: "retry",
    parentBranchId: "root",
    forkSeq: 2,
    instruction: "use a real backoff instead of a sleep",
  });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.branch, {
    id: "retry",
    sessionId: "s1",
    parentId: "root",
    forkSeq: 2,
    state: "ready",
  });

  const plan = created.body.data.launchPlan;
  assert.equal(plan.workspacePath, join(workspacesRoot, "retry"));
  assert.equal(plan.instruction, "use a real backoff instead of a sleep");
  assert.deepEqual(
    plan.context.map((item) => item.eventId),
    ["r1", "r2"],
  );

  // The reconstructed workspace is real, isolated, and content-identical.
  assert.equal(
    readFileSync(join(plan.workspacePath, "src", "upload.ts"), "utf8"),
    "export const retries = 0;\n",
  );
  assert.deepEqual(readdirSync(plan.workspacePath).sort(), [
    "README.md",
    "src",
  ]);

  // The new instruction is the branch's first owned event.
  const owned = repository.listEvents("retry");
  assert.equal(owned.length, 1);
  assert.equal(owned[0].seq, 3);
  assert.equal(owned[0].kind, "instruction");
  assert.deepEqual(owned[0].payload.data, {
    text: "use a real backoff instead of a sleep",
  });

  const timeline = await call(server, { path: "/branches/retry/timeline" });
  assert.deepEqual(
    timeline.body.items.map((item) => item.seq),
    [1, 2, 3],
  );
});

test("a branch is generated an id when the caller does not supply one", async (t) => {
  const { server } = await serve(t);

  const created = await branch(server, {
    parentBranchId: "root",
    forkSeq: 2,
    instruction: "try something else",
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.data.branch.id.length >= 32, true);
  assert.equal(created.body.data.branch.state, "ready");
});

test("an event with no reconstructable state cannot be branched from", async (t) => {
  const { server, repository } = await serve(t);

  const tooEarly = await branch(server, {
    parentBranchId: "root",
    forkSeq: 1,
    instruction: "branch before any checkpoint",
  });

  assert.equal(tooEarly.status, 409);
  assert.equal(
    repository.listBranches("s1").length,
    1,
    "no lineage is inserted when the plan is refused",
  );
});

test("a failed reconstruction leaves the branch recorded as failed", async (t) => {
  const { server, repository, store, manifest } = await serve(t);

  // Lose a blob the manifest needs, after the checkpoint was recorded.
  rmSync(store.blobPath(manifest.files[0].digest));

  const created = await branch(server, {
    id: "doomed",
    parentBranchId: "root",
    forkSeq: 2,
    instruction: "this cannot be reconstructed",
  });

  assert.equal(created.status, 409);
  assert.equal(repository.getBranch("doomed").state, "failed");
  assert.equal(repository.countEvents("doomed"), 0);
});

test("branch requests are validated before anything is created", async (t) => {
  const { server, repository } = await serve(t);

  for (const body of [
    {},
    { parentBranchId: "root", forkSeq: 2 },
    { parentBranchId: "root", forkSeq: 0, instruction: "x" },
    { parentBranchId: "", forkSeq: 2, instruction: "x" },
    { parentBranchId: "root", forkSeq: 2, instruction: "   " },
    { parentBranchId: "root", forkSeq: 2, instruction: "x", id: "" },
  ]) {
    const response = await branch(server, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const unknownParent = await branch(server, {
    parentBranchId: "missing",
    forkSeq: 2,
    instruction: "x",
  });
  assert.equal(unknownParent.status, 404);

  const beyondHistory = await branch(server, {
    parentBranchId: "root",
    forkSeq: 99,
    instruction: "x",
  });
  assert.equal(beyondHistory.status, 404);

  assert.equal(repository.listBranches("s1").length, 1);
});

test("a stored instruction is redacted like any other record", async (t) => {
  const { server } = await serve(t);

  const created = await branch(server, {
    parentBranchId: "root",
    forkSeq: 2,
    instruction: "redeploy with AKIAIOSFODNN7EXAMPLE",
  });

  assert.equal(
    created.body.data.launchPlan.instruction,
    "redeploy with [redacted:aws key]",
  );
});

test("branching is not served when the server was started without it", async (t) => {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  const repository = new ChronosRepository(storage);
  repository.insertSession({
    id: "s1",
    source: "fixture",
    createdAt: OCCURRED_AT,
  });
  const server = await startServer({ repository });
  t.after(() => server.close());

  const response = await branch(server, {
    parentBranchId: "root",
    forkSeq: 1,
    instruction: "x",
  });
  assert.equal(response.status, 404);
});
