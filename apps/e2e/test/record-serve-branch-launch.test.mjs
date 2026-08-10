import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { buildLaunchCommand, run } from "@chronos/cli";
import { ContentStore, parseManifest } from "@chronos/snapshots";
import { ChronosRepository, openStorage } from "@chronos/storage";
import { ChronosApiClient } from "@chronos/web";
import { startServer } from "@chronos/server";

/**
 * Product acceptance, part (b): a fake-provider recording, served live,
 * scrubbed and refreshed through the real web client, forked into a
 * verified workspace, and handed to a confirmed launch — one assembled
 * flow through every v0.1 surface, under one temporary home.
 *
 * Individual pieces already have deep unit coverage in their own packages.
 * What only this test proves is that the pieces still agree with each
 * other once real data flows through all of them together: the manifest
 * `chronos record` captures is the one `chronos branch` restores from and
 * `chronos launch` verifies against; the workspace the web client is told
 * about is the one actually on disk; the replay file a launch writes
 * quotes the exact history that was actually recorded, not a fixture.
 */

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-e2e-product-"));
  t.after(() => rmSync(root, { force: true, recursive: true, maxRetries: 5 }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

async function cli(box, argv, extra = {}) {
  const out = [];
  const err = [];
  const exitCode = await run(argv, {
    streams: {
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
    ...extra,
  });
  return { exitCode, out: out.join(""), err: err.join("") };
}

async function cliJson(box, argv, extra = {}) {
  const result = await cli(box, [...argv, "--json"], extra);
  assert.equal(result.exitCode, 0, result.err);
  return JSON.parse(result.out);
}

/** A fake `codex exec --json` stream: one command_execution tool call/result. */
function fakeCodexRecorder(workspace) {
  return async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "e2e-thread" }),
    );
    await onLine(JSON.stringify({ type: "turn.started" }));
    await onLine(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "call-1",
          type: "command_execution",
          command: "write src/app.ts",
        },
      }),
    );
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src", "app.ts"),
      "export const version = 1;\n",
    );
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "call-1",
          type: "command_execution",
          command: "write src/app.ts",
          aggregated_output: "wrote src/app.ts",
          exit_code: 0,
        },
      }),
    );
    await onLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      }),
    );
    return 0;
  };
}

/** Every regular file's content under `root`, recursively. */
function readAllFiles(root) {
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...readAllFiles(path));
    else if (entry.isFile()) results.push(readFileSync(path, "utf8"));
  }
  return results;
}

test("record -> serve -> browser SSE refresh/scrub -> restore/branch -> confirmed launch", async (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.workspace, ".env"), "SECRET_TOKEN=abc123\n");
  const instructionFile = join(box.root, "instruction.txt");
  writeFileSync(instructionFile, "add a version file");

  // --- (b.1) fake-provider record/capture -------------------------------
  const recorded = await cliJson(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      box.workspace,
      "--instruction-file",
      instructionFile,
    ],
    { providerExecutor: fakeCodexRecorder(box.workspace) },
  );
  assert.equal(recorded.agent, "codex");
  assert.equal(recorded.events, 6);
  assert.equal(recorded.checkpoints, 2);
  // .env is excluded as a secret, .chronos as reserved runtime material.
  assert.deepEqual(recorded.baselineExcluded.map((item) => item.path).sort(), [
    ".chronos",
    ".env",
  ]);

  const storage = openStorage({ path: join(box.home, "chronos.sqlite") });
  const repository = new ChronosRepository(storage);
  const events = repository.listEvents(recorded.branchId, { limit: 100 });
  assert.deepEqual(
    events.map((item) => item.kind),
    [
      "system",
      "instruction",
      "tool_call",
      "tool_result",
      "filesystem_change",
      "system",
    ],
  );
  const checkpoints = repository.listCheckpoints(recorded.branchId);
  assert.deepEqual(
    checkpoints.map((item) => item.eventSeq),
    [1, 5],
  );

  // The checkpoint manifest itself excludes the secret and Chronos's own
  // runtime directory; this is the durable artifact restore later reads.
  const store = new ContentStore({ root: join(box.home, "store") });
  const captureManifest = parseManifest(
    new TextDecoder().decode(store.get(checkpoints.at(-1).manifestRef)),
  );
  assert.deepEqual(
    captureManifest.files.map((item) => item.path),
    ["src/app.ts"],
  );
  storage.close();

  // --- (b.2) serve --------------------------------------------------------
  const serveStorage = openStorage({ path: join(box.home, "chronos.sqlite") });
  const serveRepository = new ChronosRepository(serveStorage);
  const serveStore = new ContentStore({ root: join(box.home, "store") });
  const workspacesRoot = join(box.home, "workspaces");
  const server = await startServer({
    repository: serveRepository,
    branching: { store: serveStore, workspacesRoot },
    heartbeatMs: 100_000,
  });
  // The test explicitly closes both before launching; these are only the
  // safety net for a failure that happens before that point is reached.
  t.after(async () => {
    try {
      await server.close();
    } catch {
      // Already closed by the explicit shutdown below.
    }
  });
  t.after(() => serveStorage.close());

  // --- token handling -------------------------------------------------
  await t.test(
    "the token is required, correct, and never written to disk",
    async () => {
      const unauthenticated = await fetch(`${server.url}/sessions`);
      assert.equal(unauthenticated.status, 401);
      const wrongToken = await fetch(`${server.url}/sessions`, {
        headers: { authorization: "Bearer not-the-real-token" },
      });
      assert.equal(wrongToken.status, 401);
      const authenticated = await fetch(`${server.url}/sessions`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      assert.equal(authenticated.status, 200);

      const onDisk = readAllFiles(box.home);
      assert.equal(
        onDisk.every((content) => !content.includes(server.token)),
        true,
        "the per-run token must never be persisted anywhere under home",
      );
    },
  );

  const client = new ChronosApiClient({
    baseUrl: server.url,
    token: server.token,
  });

  // --- (b.3) browser scrub -----------------------------------------------
  await t.test("the web client browses the recorded session", async () => {
    const sessions = await client.listSessions();
    assert.equal(
      sessions.some((item) => item.id === recorded.sessionId),
      true,
    );
    const overview = await client.getSession(recorded.sessionId);
    const branch = overview.branches.find(
      (item) => item.id === recorded.branchId,
    );
    assert.equal(branch.state, "ready");

    const timeline = await client.getTimeline(recorded.branchId);
    assert.deepEqual(
      timeline.map((item) => item.kind),
      [
        "system",
        "instruction",
        "tool_call",
        "tool_result",
        "filesystem_change",
        "system",
      ],
    );
    // The workspace's secret never reaches the API surface at all.
    assert.equal(JSON.stringify(timeline).includes("abc123"), false);

    const capabilities = await client.getCapabilities(recorded.branchId, 5);
    assert.equal(capabilities.branchability.status, "branchable");
    assert.equal(capabilities.branchability.reconstruction.kind, "exact");
  });

  // --- (b.4) SSE refresh ---------------------------------------------
  await t.test(
    "a live append reaches the browser over SSE and refetches",
    async () => {
      const states = [];
      const notices = [];
      const controller = new AbortController();
      t.after(() => controller.abort());
      client.openStream(
        recorded.sessionId,
        {
          onAppended: (notice) => notices.push(notice),
          onStateChange: (state) => states.push(state),
        },
        controller.signal,
      );
      while (states.at(-1) !== "open") await delay(2);

      // A live, non-mutating commentary event lands through the write API -
      // exactly what the record coordinator's mutating kinds are reserved
      // against, and everything else is free to use.
      const liveAppend = await fetch(
        `${server.url}/branches/${recorded.branchId}/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            events: [
              {
                id: "live-1",
                branchId: recorded.branchId,
                seq: 7,
                kind: "assistant_message",
                occurredAt: "2026-08-09T00:01:00Z",
                summary: "checking in live",
                payload: {
                  schemaVersion: 1,
                  data: { text: "checking in live" },
                },
              },
            ],
          }),
        },
      );
      assert.equal(liveAppend.status, 201);

      while (notices.length < 1) await delay(2);
      assert.deepEqual(notices[0].eventIds, ["live-1"]);

      // The browser refetches only what is new, not the whole history again.
      const fresh = await client.getTimelineSince(recorded.branchId, 7);
      assert.deepEqual(
        fresh.map((item) => [item.seq, item.kind, item.summary]),
        [[7, "assistant_message", "checking in live"]],
      );
    },
  );

  // --- (b.5) restore/branch --------------------------------------------
  let branchResult;
  await t.test(
    "the web client forks a verified, isolated workspace",
    async () => {
      branchResult = await client.createBranch(recorded.sessionId, {
        parentBranchId: recorded.branchId,
        forkSeq: 5,
        instruction: "add a test for the version file",
      });
      assert.equal(branchResult.branch.state, "ready");
      assert.equal(
        branchResult.launchPlan.workspacePath,
        join(workspacesRoot, branchResult.branch.id),
      );

      const restoredFiles = readdirSync(branchResult.launchPlan.workspacePath, {
        recursive: true,
      });
      assert.equal(restoredFiles.includes(join("src", "app.ts")), true);
      assert.equal(
        readFileSync(
          join(branchResult.launchPlan.workspacePath, "src", "app.ts"),
          "utf8",
        ),
        "export const version = 1;\n",
      );
      // The excluded secret and Chronos's own runtime directory never land
      // in a restored workspace either.
      assert.equal(
        restoredFiles.some((item) => item === ".env"),
        false,
      );
      assert.equal(
        restoredFiles.some((item) => item.startsWith(".chronos")),
        false,
      );
    },
  );

  // Release the server's own connection before the CLI opens its own.
  await server.close();
  serveStorage.close();

  // --- (b.6) confirmed launch --------------------------------------------
  await t.test(
    "a confirmed launch resolves the exact plan for the forked workspace",
    async () => {
      let received;
      const launched = await cliJson(
        box,
        [
          "launch",
          "--agent",
          "codex",
          "--branch",
          branchResult.branch.id,
          "--confirm",
        ],
        {
          providerExecutable: realpathSync(process.execPath),
          launchExecutor: async (command) => {
            received = command;
            return 0;
          },
        },
      );
      assert.equal(launched.confirmed, true);
      assert.equal(launched.exitCode, 0);
      assert.equal(received.cwd, branchResult.launchPlan.workspacePath);

      // Command-builder compatibility: the real plan matches the pure builder
      // given the same real inputs, not a hand-maintained expectation.
      const rebuilt = buildLaunchCommand(
        "codex",
        branchResult.launchPlan.workspacePath,
        received.args[3].split("Replay file: ")[1],
        received.executable,
      );
      assert.deepEqual(received.args, rebuilt.args);
      assert.equal(received.args[0], "-C");
      assert.equal(received.args[2], "--");

      const replayPath = join(
        branchResult.launchPlan.workspacePath,
        received.args[3].split("Replay file: ")[1],
      );
      assert.equal(existsSync(replayPath), true);
      const replay = readFileSync(replayPath, "utf8");
      assert.equal(Buffer.byteLength(replay, "utf8") <= 64 * 1024, true);

      // Instruction delivery: the new instruction is the task, in full.
      assert.match(replay, /== Task ==\n> add a test for the version file/);
      // Context ordering: the branch point's first inherited instruction is
      // quoted (this lineage's original task), so a fresh agent has the
      // "why", not only the most recent record.
      assert.match(replay, /> add a version file/);
      // Inert historical commands: the recorded tool call/result read only as
      // quoted, blockquoted history - never as an executable line of their own.
      assert.match(replay, /> command execution/);
      for (const line of replay
        .split("\n== Quoted history ==\n")[1]
        .split("\n")) {
        if (line.length > 0 && !line.startsWith("[")) {
          assert.equal(line.startsWith(">") || line.startsWith("#"), true);
        }
      }
    },
  );
});

test("a checkpoint transaction failure leaves a dirty, non-branchable, failed recording", async (t) => {
  const box = sandbox(t);
  const instructionFile = join(box.root, "instruction.txt");
  writeFileSync(instructionFile, "change a file");

  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(JSON.stringify({ type: "thread.started", thread_id: "s" }));
    await onLine(JSON.stringify({ type: "turn.started" }));
    await onLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "call", type: "command_execution", command: "write" },
      }),
    );
    writeFileSync(join(box.workspace, "changed.txt"), "dirty\n");
    const sabotage = openStorage({ path: join(box.home, "chronos.sqlite") });
    try {
      sabotage._database().exec(`
        CREATE TRIGGER e2e_reject_post_tool_checkpoint
        BEFORE INSERT ON checkpoint WHEN NEW.event_seq > 1
        BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END
      `);
    } finally {
      sabotage.close();
    }
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "call",
          type: "command_execution",
          command: "write",
          aggregated_output: "done",
          exit_code: 0,
        },
      }),
    );
    return 0;
  };

  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      box.workspace,
      "--instruction-file",
      instructionFile,
    ],
    { providerExecutor: executor },
  );
  assert.equal(response.exitCode, 1);

  const storage = openStorage({ path: join(box.home, "chronos.sqlite") });
  const repository = new ChronosRepository(storage);
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  // The failed transaction leaves neither the tool result nor a checkpoint
  // behind - only the tool call and a safe, dirty terminal error.
  assert.deepEqual(
    events.map((item) => item.kind),
    ["system", "instruction", "tool_call", "error"],
  );
  assert.equal(
    events.at(-1).payload.data.workspaceState,
    "unknown_after_tool_call",
  );
  assert.deepEqual(
    repository.listCheckpoints(branch.id).map((item) => item.eventSeq),
    [1],
  );
  assert.equal(branch.state, "failed");
  storage.close();
});
