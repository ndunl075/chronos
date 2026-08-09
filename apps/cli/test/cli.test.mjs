import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
