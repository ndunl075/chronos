import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  ContentStore,
  captureWorkspace,
  serializeManifest,
} from "@chronos/snapshots";
import { ChronosRepository, openStorage } from "@chronos/storage";

import { CLI_VERSION, run } from "../dist/index.js";

const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "adapters",
    "test",
    "fixtures",
    "upload-retry.jsonl",
  ),
  "utf8",
);

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-cli-"));
  const home = join(root, "home");
  const opened = [];
  // Windows will not unlink an open database file, so handles close first.
  t.after(() => {
    for (const storage of opened) storage.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  });
  return {
    root,
    home,
    file(name, contents) {
      const path = join(root, name);
      writeFileSync(path, contents);
      return path;
    },
    /** Open the database the CLI wrote, to check what actually landed. */
    read() {
      const storage = openStorage({ path: join(home, "chronos.sqlite") });
      opened.push(storage);
      return new ChronosRepository(storage);
    },
  };
}

async function cli(box, argv, signal) {
  const out = [];
  const err = [];
  const exitCode = await run(argv, {
    ...(signal === undefined ? {} : { signal }),
    streams: {
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
  });
  return { exitCode, out: out.join(""), err: err.join("") };
}

test("help and version answer without touching anything", async (t) => {
  const box = sandbox(t);

  const help = await cli(box, []);
  assert.equal(help.exitCode, 0);
  assert.match(help.out, /Usage: chronos <command>/);
  assert.match(help.out, /^ {2}import/m);

  assert.equal((await cli(box, ["--help"])).exitCode, 0);
  assert.equal((await cli(box, ["--version"])).out.trim(), CLI_VERSION);

  const commandHelp = await cli(box, ["import", "--help"]);
  assert.equal(commandHelp.exitCode, 0);
  assert.match(commandHelp.out, /Usage: chronos import <file>/);
  assert.match(commandHelp.out, /--retain-raw/);
});

test("a typo is a usage error, not a silent default", async (t) => {
  const box = sandbox(t);

  const unknownCommand = await cli(box, ["improt", "x.jsonl"]);
  assert.equal(unknownCommand.exitCode, 2);
  assert.match(unknownCommand.err, /Unknown command: improt/);

  const unknownFlag = await cli(box, ["import", "x.jsonl", "--no-redakt"]);
  assert.equal(unknownFlag.exitCode, 2);
  assert.match(unknownFlag.err, /Unknown option: --no-redakt/);

  const missingValue = await cli(box, ["import", "x.jsonl", "--home"]);
  assert.equal(missingValue.exitCode, 2);
  assert.match(missingValue.err, /--home needs a value/);

  const valueOnBoolean = await cli(box, ["import", "x.jsonl", "--json=yes"]);
  assert.equal(valueOnBoolean.exitCode, 2);

  const noFile = await cli(box, ["import"]);
  assert.equal(noFile.exitCode, 2);
  assert.match(noFile.err, /Usage: chronos import <file>/);
});

test("a session file imports into the local database", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const result = await cli(box, ["import", path]);
  assert.equal(result.exitCode, 0);
  assert.match(result.out, /Imported session s_upload from chronos-jsonl/);
  assert.match(result.out, /events {7}6/);
  assert.match(result.err, /warning: Raw data for event e3 was dropped/);

  const repository = box.read();
  assert.equal(repository.getSession("s_upload").source, "chronos-jsonl");
  assert.deepEqual(
    repository.listBranches("s_upload").map((branch) => branch.id),
    ["b_root", "b_retry"],
  );
  assert.equal(repository.countEvents("b_root"), 4);
  assert.equal(repository.countEvents("b_retry"), 2);
  assert.deepEqual(
    repository.listCheckpoints("b_root").map((item) => item.id),
    ["cp3"],
  );
});

test("json mode prints one object and no prose", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const result = await cli(box, ["import", path, "--json"]);
  assert.equal(result.exitCode, 0);

  const parsed = JSON.parse(result.out);
  assert.equal(parsed.sessionId, "s_upload");
  assert.equal(parsed.events, 6);
  assert.equal(parsed.checkpoints, 2);
  assert.equal(parsed.databasePath, join(box.home, "chronos.sqlite"));
  assert.deepEqual(
    parsed.diagnostics.map((item) => item.code),
    ["raw_envelope_dropped"],
  );
});

test("raw retention and redaction are opt-in and opt-out", async (t) => {
  const box = sandbox(t);
  const retained = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const result = await cli(retained, [
    "import",
    path,
    "--retain-raw",
    "--json",
  ]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.out).diagnostics, []);

  const repository = retained.read();
  assert.equal(repository.getEvent("e3").rawEnvelope.ref, "raw/e3.json");

  const plain = sandbox(t);
  const secret = plain.file(
    "secret.jsonl",
    [
      `{"type":"session","schemaVersion":1,"id":"s2","source":"x","createdAt":"2026-08-09T00:00:00Z"}`,
      `{"type":"branch","schemaVersion":1,"id":"b1"}`,
      `{"type":"event","schemaVersion":1,"id":"e1","branchId":"b1","seq":1,"kind":"tool_result","occurredAt":"2026-08-09T00:00:00Z","summary":"key AKIAIOSFODNN7EXAMPLE","payload":{"text":"ok"}}`,
    ].join("\n"),
  );

  assert.equal((await cli(plain, ["import", secret])).exitCode, 0);
  assert.equal(plain.read().getEvent("e1").summary, "key [redacted:aws key]");

  const raw = sandbox(t);
  const disabled = await cli(raw, ["import", secret, "--no-redact"]);
  assert.equal(disabled.exitCode, 0);
  assert.match(disabled.err, /warning: Redaction was disabled/);
  assert.equal(raw.read().getEvent("e1").summary, "key AKIAIOSFODNN7EXAMPLE");
});

test("a bad file fails before anything is written", async (t) => {
  const box = sandbox(t);

  const missing = await cli(box, ["import", "nope.jsonl"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err, /Could not read/);
  assert.match(missing.err, /The file does not exist/);

  const malformed = box.file("bad.jsonl", "{not json\n");
  const rejected = await cli(box, ["import", malformed]);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.err, /line 1/);
  assert.match(rejected.err, /docs\/formats\/chronos-jsonl\.md/);

  const truncated = box.file(
    "half.jsonl",
    [
      `{"type":"session","schemaVersion":1,"id":"s3","source":"x","createdAt":"2026-08-09T00:00:00Z"}`,
      `{"type":"branch","schemaVersion":1,"id":"b1"}`,
      `{"type":"event","schemaVersion":1,"id":"e1","branchId":"b1","seq":1,"kind":"system","occurredAt":"2026-08-09T00:00:00Z","summary":"ok","payload":{}}`,
      `{"type":"event","schemaVersion":1,"id":"e2","branchId":"b1","seq":9,"kind":"system","occurredAt":"2026-08-09T00:00:00Z","summary":"gap","payload":{}}`,
    ].join("\n"),
  );
  const gap = await cli(box, ["import", truncated]);
  assert.equal(gap.exitCode, 1);

  // Nothing from either rejected file reached the database.
  await cli(box, ["import", box.file("ok.jsonl", FIXTURE)]);
  const repository = box.read();
  assert.deepEqual(
    repository.listSessions().map((session) => session.id),
    ["s_upload"],
  );
});

test("a session is never imported twice", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  assert.equal((await cli(box, ["import", path])).exitCode, 0);
  const again = await cli(box, ["import", path]);
  assert.equal(again.exitCode, 1);
  assert.match(again.err, /already imported/);
  assert.match(again.err, /never rewrites history/);

  assert.equal(box.read().listSessions().length, 1);
});

test("inspect lists what has been imported", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const empty = await cli(box, ["inspect"]);
  assert.equal(empty.exitCode, 1);
  assert.match(empty.err, /No Chronos database/);

  await cli(box, ["import", path]);

  const list = await cli(box, ["inspect"]);
  assert.equal(list.exitCode, 0);
  assert.match(list.out, /^SESSION\s+SOURCE\s+CREATED\s+BRANCHES\s+EVENTS/m);
  assert.match(list.out, /s_upload\s+chronos-jsonl\s+\S+\s+2\s+6/);

  const json = JSON.parse((await cli(box, ["inspect", "--json"])).out);
  assert.deepEqual(json.sessions, [
    {
      id: "s_upload",
      source: "chronos-jsonl",
      createdAt: "2026-08-09T00:00:00Z",
      branches: 2,
      events: 6,
    },
  ]);
});

test("inspect describes a session's lineage", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const overview = await cli(box, ["inspect", "s_upload"]);
  assert.equal(overview.exitCode, 0);
  assert.match(overview.out, /Session s_upload/);
  assert.match(overview.out, /b_root\s+ready\s+\(root\)\s+4\s+1/);
  assert.match(overview.out, /b_retry\s+ready\s+b_root@3\s+2\s+1/);

  const missing = await cli(box, ["inspect", "nope"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err, /No such session: nope/);
});

test("inspect shows a branch timeline with inherited history", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const timeline = await cli(box, ["inspect", "--branch", "b_retry"]);
  assert.equal(timeline.exitCode, 0);
  assert.match(timeline.out, /Branch b_retry \(5 events visible\)/);
  assert.match(timeline.out, /instruction \(inherited\)/);
  assert.match(timeline.out, /\* marks an event a branch can be created from/);

  const json = JSON.parse(
    (await cli(box, ["inspect", "--branch", "b_retry", "--json"])).out,
  );
  assert.deepEqual(
    json.events.map((event) => [event.seq, event.inherited, event.branchable]),
    [
      [1, true, false],
      [2, true, false],
      [3, true, true],
      [4, false, true],
      [5, false, true],
    ],
  );
  assert.equal(json.events[0].reason, "no_checkpoint");
  assert.equal(json.events[2].reason, undefined);
});

test("a timeline pages and validates its window", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const firstPage = await cli(box, [
    "inspect",
    "--branch",
    "b_retry",
    "--limit",
    "2",
    "--json",
  ]);
  assert.deepEqual(
    JSON.parse(firstPage.out).events.map((event) => event.seq),
    [1, 2],
  );

  const secondPage = await cli(box, [
    "inspect",
    "--branch",
    "b_retry",
    "--from",
    "3",
    "--json",
  ]);
  assert.deepEqual(
    JSON.parse(secondPage.out).events.map((event) => event.seq),
    [3, 4, 5],
  );

  assert.match(
    (await cli(box, ["inspect", "--branch", "b_retry", "--limit", "2"])).out,
    /continue with --from 3/,
  );

  for (const bad of [
    ["--limit", "0"],
    ["--limit", "5000"],
    ["--from", "0"],
    ["--from", "x"],
  ]) {
    const response = await cli(box, ["inspect", "--branch", "b_retry", ...bad]);
    assert.equal(response.exitCode, 2, bad.join(" "));
  }

  const unknownBranch = await cli(box, ["inspect", "--branch", "nope"]);
  assert.equal(unknownBranch.exitCode, 1);
});

test("inspect shows one event without running anything", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const detail = await cli(box, ["inspect", "--event", "e2"]);
  assert.equal(detail.exitCode, 0);
  assert.match(detail.out, /Event e2/);
  assert.match(detail.out, /kind {6}tool_call/);
  assert.match(detail.out, /"path": "src\/upload\.ts"/);
  assert.match(detail.out, /Chronos displays it and never runs it/);

  const missing = await cli(box, ["inspect", "--event", "nope"]);
  assert.equal(missing.exitCode, 1);

  const conflicting = await cli(box, [
    "inspect",
    "--event",
    "e2",
    "--branch",
    "b_root",
  ]);
  assert.equal(conflicting.exitCode, 2);
});

test("serve runs the API until it is asked to stop", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const stopping = new AbortController();
  const running = cli(box, ["serve", "--json"], stopping.signal);

  // The server is up as soon as the result is printed, so read it by polling
  // the promise's resolution rather than guessing at a delay.
  const finished = (async () => {
    const result = await running;
    return JSON.parse(result.out.split("\n").slice(0).join("\n"));
  })();

  stopping.abort();
  const served = await finished;

  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(served.host, "127.0.0.1");
  assert.equal(served.token.length >= 32, true);
  assert.equal(served.databasePath, join(box.home, "chronos.sqlite"));
  assert.equal(served.workspacesRoot, join(box.home, "workspaces"));
});

test("serve answers the API it advertises", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const stopping = new AbortController();
  const out = [];
  const running = run(["serve", "--json"], {
    streams: {
      write: (text) => out.push(text),
      writeError: () => undefined,
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
    signal: stopping.signal,
  });

  // Wait for the server to advertise itself before calling it.
  while (out.length === 0) await delay(5);
  const served = JSON.parse(out.join(""));

  const sessions = await fetch(`${served.url}/sessions`, {
    headers: { authorization: `Bearer ${served.token}` },
  });
  assert.equal(sessions.status, 200);
  assert.deepEqual(
    (await sessions.json()).items.map((item) => item.id),
    ["s_upload"],
  );

  const unauthorized = await fetch(`${served.url}/sessions`);
  assert.equal(unauthorized.status, 401);

  stopping.abort();
  assert.equal(await running, 0);

  // The port is released once the command returns.
  await assert.rejects(() => fetch(`${served.url}/sessions`));
});

test("serve reports a port it cannot use", async (t) => {
  const box = sandbox(t);

  const badPort = await cli(box, ["serve", "--port", "99999"]);
  assert.equal(badPort.exitCode, 2);
  assert.match(badPort.err, /--port must be an integer/);
});

/**
 * A session whose checkpoint really does address a captured workspace, so
 * branching from it reconstructs real files rather than a fixture stub.
 */
function branchable(box) {
  const workspace = join(box.root, "project");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "upload.ts"),
    "export const retries = 0;\n",
  );
  writeFileSync(join(workspace, "README.md"), "# upload\n");

  mkdirSync(box.home, { recursive: true });
  const store = new ContentStore({ root: join(box.home, "store") });
  const { manifest } = captureWorkspace({ workspaceRoot: workspace, store });
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(manifest), "utf8")),
  );

  return box.file(
    "branchable.jsonl",
    [
      `{"type":"session","schemaVersion":1,"id":"s_live","source":"fixture","createdAt":"2026-08-09T00:00:00Z"}`,
      `{"type":"branch","schemaVersion":1,"id":"b_root"}`,
      `{"type":"event","schemaVersion":1,"id":"e1","branchId":"b_root","seq":1,"kind":"instruction","occurredAt":"2026-08-09T00:00:00Z","summary":"add retries","payload":{"text":"add retries"}}`,
      `{"type":"event","schemaVersion":1,"id":"e2","branchId":"b_root","seq":2,"kind":"filesystem_change","occurredAt":"2026-08-09T00:00:05Z","summary":"wrote src/upload.ts","payload":{"paths":["src/upload.ts"]}}`,
      `{"type":"checkpoint","schemaVersion":1,"id":"cp2","branchId":"b_root","eventSeq":2,"manifestRef":"${manifestRef}"}`,
      `{"type":"event","schemaVersion":1,"id":"e3","branchId":"b_root","seq":3,"kind":"assistant_message","occurredAt":"2026-08-09T00:00:09Z","summary":"used a fixed sleep","payload":{"text":"used a fixed sleep"}}`,
    ].join("\n"),
  );
}

test("branch forks a session and reconstructs its workspace", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const created = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "2",
    "--instruction",
    "use a real backoff instead of a sleep",
    "--id",
    "retry",
    "--json",
  ]);
  assert.equal(created.exitCode, 0);

  const result = JSON.parse(created.out);
  assert.deepEqual(result.branch, {
    id: "retry",
    sessionId: "s_live",
    parentId: "b_root",
    forkSeq: 2,
    state: "ready",
  });
  assert.equal(
    result.launchPlan.workspacePath,
    join(box.home, "workspaces", "retry"),
  );
  assert.equal(result.launchPlan.context.length, 2);

  // The reconstructed workspace holds the real files, isolated from the source.
  assert.equal(
    readFileSync(
      join(result.launchPlan.workspacePath, "src", "upload.ts"),
      "utf8",
    ),
    "export const retries = 0;\n",
  );

  // The branch is visible to inspect, with the instruction as its own event.
  const timeline = JSON.parse(
    (await cli(box, ["inspect", "--branch", "retry", "--json"])).out,
  );
  assert.deepEqual(
    timeline.events.map((item) => [item.seq, item.inherited, item.kind]),
    [
      [1, true, "instruction"],
      [2, true, "filesystem_change"],
      [3, false, "instruction"],
    ],
  );
});

test("branch says plainly that it has run nothing", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const created = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "2",
    "--instruction",
    "try the other fix",
  ]);
  assert.equal(created.exitCode, 0);
  assert.match(created.out, /Created branch \S+ from b_root@2/);
  assert.match(created.out, /Chronos has run nothing/);
});

test("branch refuses an event with no reconstructable state", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const tooEarly = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "1",
    "--instruction",
    "branch before the checkpoint",
  ]);
  assert.equal(tooEarly.exitCode, 1);
  assert.match(tooEarly.err, /cannot reconstruct a workspace/);
  assert.match(tooEarly.err, /marked with \*/);

  // Only the root branch exists; the refused attempt created no lineage.
  const overview = JSON.parse(
    (await cli(box, ["inspect", "s_live", "--json"])).out,
  );
  assert.deepEqual(
    overview.branches.map((branch) => branch.id),
    ["b_root"],
  );
});

test("branch validates what it was asked to do", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const noAt = await cli(box, ["branch", "s_live", "--instruction", "x"]);
  assert.equal(noAt.exitCode, 2);
  assert.match(noAt.err, /--at is required/);

  const noInstruction = await cli(box, ["branch", "s_live", "--at", "2"]);
  assert.equal(noInstruction.exitCode, 2);
  assert.match(noInstruction.err, /--instruction is required/);

  const badAt = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "0",
    "--instruction",
    "x",
  ]);
  assert.equal(badAt.exitCode, 2);

  const unknownSession = await cli(box, [
    "branch",
    "nope",
    "--at",
    "2",
    "--instruction",
    "x",
  ]);
  assert.equal(unknownSession.exitCode, 1);
  assert.match(unknownSession.err, /No such session: nope/);

  const unknownParent = await cli(box, [
    "branch",
    "s_live",
    "--from",
    "nope",
    "--at",
    "2",
    "--instruction",
    "x",
  ]);
  assert.equal(unknownParent.exitCode, 1);
});
