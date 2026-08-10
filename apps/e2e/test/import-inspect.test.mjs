import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "@chronos/cli";

/**
 * Product acceptance, part (a): exact-version provider fixture import,
 * through the real CLI, inspected through the real CLI.
 *
 * This does not re-derive adapter parsing rules — packages/adapters already
 * proves those exhaustively. What this proves is the assembled product
 * behavior a user actually sees: the two saved-session formats Chronos ships
 * import cleanly from the CLI, land under a fresh, isolated home directory,
 * and read back through `chronos inspect` exactly as imported, with omitted
 * content staying omitted and non-branchable history staying visibly so.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "adapters",
  "test",
  "fixtures",
);

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-e2e-import-"));
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

test("a Codex saved session imports and inspects end to end under a fresh home", async (t) => {
  const box = sandbox(t);

  const imported = await cliJson(box, [
    "import",
    join(FIXTURES, "codex-0.146.0-alpha.3.jsonl"),
    "--format",
    "codex",
  ]);
  assert.equal(imported.sessionId, "codex-fixture");
  assert.equal(imported.source, "codex");
  assert.equal(imported.branches, 1);
  assert.equal(imported.events, 5);
  assert.equal(imported.checkpoints, 0);
  assert.equal(imported.databasePath, join(box.home, "chronos.sqlite"));

  // Encrypted reasoning and the duplicate agent-message surface are
  // diagnosed as omitted, never silently dropped or invented as events.
  assert.deepEqual(
    imported.diagnostics.map((item) => item.code),
    ["unsupported_record", "unsupported_record", "no_checkpoints"],
  );
  assert.match(imported.diagnostics[0].message, /response_item\.reasoning/);
  assert.match(imported.diagnostics[1].message, /event_msg\.agent_message/);

  const overview = await cliJson(box, ["inspect", "codex-fixture"]);
  assert.equal(overview.session.source, "codex");
  assert.equal(overview.branches.length, 1);
  const branch = overview.branches[0];
  assert.equal(branch.state, "ready");
  assert.equal(branch.ownedEvents, 5);
  assert.equal(branch.checkpoints, 0);

  const timeline = await cliJson(box, ["inspect", "--branch", branch.id]);
  assert.deepEqual(
    timeline.events.map((item) => [item.kind, item.summary]),
    [
      ["instruction", "Fix the retry test"],
      ["assistant_message", "I will inspect the test."],
      ["tool_call", "read_file call"],
      ["tool_result", "result for call-1"],
      ["error", "Synthetic provider warning"],
    ],
  );
  // No checkpoint was ever imported for this transcript, so every event is
  // visibly, explicitly non-branchable rather than silently unreconstructable.
  assert.equal(
    timeline.events.every((item) => item.branchable === false),
    true,
  );
  assert.equal(
    timeline.events.every((item) => item.reason === "no_checkpoint"),
    true,
  );

  const toolCall = await cliJson(box, [
    "inspect",
    "--event",
    timeline.events[2].id,
  ]);
  assert.deepEqual(toolCall.event.payload.data, {
    callId: "call-1",
    name: "read_file",
    input: { path: "test/retry.test.ts" },
  });
  // A recorded command is display-only in the CLI's own words, not merely
  // by omission of a run command.
  assert.equal(
    (
      await cli(box, ["inspect", "--event", timeline.events[2].id])
    ).out.includes("Chronos displays it and never runs it"),
    true,
  );

  // Reasoning and the raw provider record never cross into canonical data.
  const fullTimeline = JSON.stringify(timeline);
  assert.equal(fullTimeline.includes("encrypted"), false);
  assert.equal(fullTimeline.includes("reasoning"), false);
});

test("a Claude Code saved session imports and inspects end to end under a fresh home", async (t) => {
  const box = sandbox(t);

  const imported = await cliJson(box, [
    "import",
    join(FIXTURES, "claude-2.1.225.jsonl"),
    "--format",
    "claude",
  ]);
  assert.equal(imported.sessionId, "claude-fixture");
  assert.equal(imported.source, "claude");
  assert.equal(imported.events, 5);
  assert.equal(imported.checkpoints, 0);
  assert.deepEqual(
    imported.diagnostics.map((item) => item.code),
    ["no_checkpoints"],
  );

  const overview = await cliJson(box, ["inspect", "claude-fixture"]);
  const branch = overview.branches[0];
  assert.equal(branch.state, "ready");
  assert.equal(branch.ownedEvents, 5);

  const timeline = await cliJson(box, ["inspect", "--branch", branch.id]);
  assert.deepEqual(
    timeline.events.map((item) => [item.kind, item.summary]),
    [
      ["instruction", "Fix the retry test"],
      ["assistant_message", "I will inspect the test."],
      ["tool_call", "Read call"],
      ["tool_result", "result for tool-1"],
      ["error", "Synthetic provider warning"],
    ],
  );
  assert.equal(
    timeline.events.every(
      (item) => item.branchable === false && item.reason === "no_checkpoint",
    ),
    true,
  );

  // Thinking blocks and file-history snapshots are never imported as events.
  const fullTimeline = JSON.stringify(timeline);
  assert.equal(fullTimeline.includes("thinking"), false);
  assert.equal(fullTimeline.includes("file-history"), false);

  // A second provider's saved session coexists in the same home, under its
  // own session id, without disturbing the first.
  await cliJson(box, [
    "import",
    join(FIXTURES, "codex-0.146.0-alpha.3.jsonl"),
    "--format",
    "codex",
  ]);
  const sessions = await cliJson(box, ["inspect"]);
  assert.deepEqual(sessions.sessions.map((item) => item.id).sort(), [
    "claude-fixture",
    "codex-fixture",
  ]);
});
