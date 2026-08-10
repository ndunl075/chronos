import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "@chronos/cli";
import {
  ContentStore,
  captureWorkspace,
  diffManifests,
  serializeManifest,
  serializeManifestDiff,
} from "@chronos/snapshots";

/**
 * Product acceptance for persisted delta reconstruction: a Chronos JSONL
 * import whose intervening mutation is a content-addressed ManifestDiff,
 * branched through the real CLI into a workspace that matches the final
 * captured state — not the baseline checkpoint alone.
 */

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-e2e-delta-"));
  t.after(() => rmSync(root, { force: true, recursive: true, maxRetries: 5 }));
  return { root, home: join(root, "home") };
}

async function cli(box, argv) {
  const out = [];
  const err = [];
  const exitCode = await run(argv, {
    streams: {
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
  });
  return { exitCode, out: out.join(""), err: err.join("") };
}

async function cliJson(box, argv) {
  const result = await cli(box, [...argv, "--json"]);
  assert.equal(result.exitCode, 0, result.err);
  return JSON.parse(result.out);
}

test("importing a delta chain branches into the final reconstructed workspace", async (t) => {
  const box = sandbox(t);
  mkdirSync(join(box.home, "store"), { recursive: true });
  const store = new ContentStore({ root: join(box.home, "store") });

  const baseWorkspace = join(box.root, "base");
  mkdirSync(join(baseWorkspace, "src"), { recursive: true });
  writeFileSync(
    join(baseWorkspace, "src", "upload.ts"),
    "export const retries = 0;\n",
  );
  const { manifest: baseManifest } = captureWorkspace({
    workspaceRoot: baseWorkspace,
    store,
  });
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(baseManifest), "utf8")),
  );

  writeFileSync(
    join(baseWorkspace, "src", "upload.ts"),
    "export const retries = 3;\n",
  );
  writeFileSync(join(baseWorkspace, "README.md"), "retry with backoff\n");
  const { manifest: targetManifest } = captureWorkspace({
    workspaceRoot: baseWorkspace,
    store,
  });
  const diffRef = store.put(
    new Uint8Array(
      Buffer.from(
        serializeManifestDiff(diffManifests(baseManifest, targetManifest)),
        "utf8",
      ),
    ),
  );

  const sessionPath = join(box.root, "session.jsonl");
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        schemaVersion: 1,
        id: "s_delta",
        source: "chronos-jsonl",
        createdAt: "2026-08-09T00:00:00Z",
      }),
      JSON.stringify({ type: "branch", schemaVersion: 1, id: "b_root" }),
      JSON.stringify({
        type: "event",
        schemaVersion: 1,
        id: "e1",
        branchId: "b_root",
        seq: 1,
        kind: "instruction",
        occurredAt: "2026-08-09T00:00:00Z",
        summary: "Add retries",
        payload: { text: "Add retries" },
      }),
      JSON.stringify({
        type: "event",
        schemaVersion: 1,
        id: "e2",
        branchId: "b_root",
        seq: 2,
        kind: "filesystem_change",
        occurredAt: "2026-08-09T00:00:05Z",
        summary: "Baseline workspace",
        payload: { paths: ["src/upload.ts"] },
      }),
      JSON.stringify({
        type: "checkpoint",
        schemaVersion: 1,
        id: "cp2",
        branchId: "b_root",
        eventSeq: 2,
        manifestRef,
      }),
      JSON.stringify({
        type: "event",
        schemaVersion: 1,
        id: "e3",
        branchId: "b_root",
        seq: 3,
        kind: "filesystem_change",
        occurredAt: "2026-08-09T00:00:10Z",
        summary: "Applied retry patch",
        payload: { paths: ["src/upload.ts", "README.md"] },
      }),
      JSON.stringify({
        type: "delta",
        schemaVersion: 1,
        id: "d3",
        branchId: "b_root",
        eventSeq: 3,
        diffRef,
      }),
    ].join("\n"),
  );

  const imported = await cliJson(box, ["import", sessionPath]);
  assert.equal(imported.sessionId, "s_delta");
  assert.equal(imported.checkpoints, 1);
  assert.equal(imported.deltas, 1);

  const timeline = await cliJson(box, ["inspect", "--branch", "b_root"]);
  const atDelta = timeline.events.find((item) => item.seq === 3);
  assert.equal(atDelta.branchable, true);
  assert.equal(atDelta.reason, undefined);
  const atBaseline = timeline.events.find((item) => item.seq === 2);
  assert.equal(atBaseline.branchable, true);

  const branched = await cliJson(box, [
    "branch",
    "s_delta",
    "--from",
    "b_root",
    "--at",
    "3",
    "--instruction",
    "keep the backoff",
    "--id",
    "b_retry",
  ]);
  assert.equal(branched.branch.id, "b_retry");
  const workspace = branched.launchPlan.workspacePath;
  assert.equal(existsSync(workspace), true);
  assert.equal(
    readFileSync(join(workspace, "src", "upload.ts"), "utf8"),
    "export const retries = 3;\n",
  );
  assert.equal(
    readFileSync(join(workspace, "README.md"), "utf8"),
    "retry with backoff\n",
  );
});
