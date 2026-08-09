import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeEventCapabilities,
  indexSession,
  resolveVisibleEvents,
} from "@chronos/core";
import {
  AdapterError,
  CHRONOS_JSONL_SCHEMA_VERSION,
  chronosJsonlAdapter,
  parseChronosJsonl,
} from "../dist/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const UPLOAD_RETRY = readFileSync(join(FIXTURES, "upload-retry.jsonl"), "utf8");

const SESSION_LINE = `{"type":"session","schemaVersion":1,"id":"s1","source":"chronos-jsonl","createdAt":"2026-08-09T00:00:00Z"}`;
const ROOT_LINE = `{"type":"branch","schemaVersion":1,"id":"b1"}`;

function line(overrides = {}) {
  return JSON.stringify({
    type: "event",
    schemaVersion: 1,
    id: "e1",
    branchId: "b1",
    seq: 1,
    kind: "instruction",
    occurredAt: "2026-08-09T00:00:00Z",
    summary: "do the thing",
    payload: { text: "do the thing" },
    ...overrides,
  });
}

function file(...lines) {
  return [SESSION_LINE, ROOT_LINE, ...lines].join("\n");
}

function rejects(input, expectedCode, expectedLine) {
  assert.throws(
    () => parseChronosJsonl(input),
    (error) => {
      assert.ok(error instanceof AdapterError, `expected an AdapterError`);
      assert.equal(error.code, expectedCode, error.message);
      if (expectedLine !== undefined) assert.equal(error.line, expectedLine);
      return true;
    },
  );
}

test("the adapter describes the format it reads", () => {
  assert.equal(chronosJsonlAdapter.id, "chronos-jsonl");
  assert.equal(chronosJsonlAdapter.formatVersion, CHRONOS_JSONL_SCHEMA_VERSION);
  assert.equal(
    chronosJsonlAdapter.documentation,
    "docs/formats/chronos-jsonl.md",
  );
});

test("the documented fixture imports into canonical records", () => {
  const imported = chronosJsonlAdapter.parse(UPLOAD_RETRY);

  assert.deepEqual(imported.session, {
    id: "s_upload",
    source: "chronos-jsonl",
    createdAt: "2026-08-09T00:00:00Z",
  });
  assert.deepEqual(imported.branches, [
    { id: "b_root", sessionId: "s_upload", state: "ready" },
    {
      id: "b_retry",
      sessionId: "s_upload",
      parentId: "b_root",
      forkSeq: 3,
      state: "ready",
    },
  ]);
  assert.deepEqual(
    imported.events.map((event) => `${event.branchId}:${event.seq}`),
    ["b_root:1", "b_root:2", "b_root:3", "b_root:4", "b_retry:4", "b_retry:5"],
  );
  assert.deepEqual(imported.events[0].payload, {
    schemaVersion: 1,
    data: { text: "Fix the flaky upload test" },
  });
  assert.deepEqual(
    imported.checkpoints.map((checkpoint) => checkpoint.id),
    ["cp3", "cp5"],
  );
});

test("raw references are dropped unless retention is opted into", () => {
  const dropped = parseChronosJsonl(UPLOAD_RETRY);
  assert.equal(
    dropped.events.every((event) => event.rawEnvelope === undefined),
    true,
  );
  assert.deepEqual(
    dropped.diagnostics.map((item) => item.code),
    ["raw_envelope_dropped"],
  );

  const retained = parseChronosJsonl(UPLOAD_RETRY, { retainRaw: true });
  assert.deepEqual(retained.diagnostics, []);
  assert.deepEqual(
    retained.events.find((event) => event.id === "e3").rawEnvelope,
    {
      schemaVersion: 1,
      ref: "raw/e3.json",
      retention: "opt_in",
      protection: "encrypted_restricted_store",
      mediaType: "application/json",
      sourceSchemaVersion: "chronos-demo-1",
    },
  );
});

test("an import without checkpoints says nothing can be reconstructed", () => {
  const imported = parseChronosJsonl(file(line()));

  assert.deepEqual(
    imported.diagnostics.map((item) => item.code),
    ["no_checkpoints"],
  );
  assert.equal(imported.diagnostics[0].line, undefined);
});

test("an imported session is indexable and branchable by the domain core", () => {
  const imported = parseChronosJsonl(UPLOAD_RETRY);
  const index = indexSession({
    session: imported.session,
    branches: imported.branches,
    events: imported.events,
    checkpoints: imported.checkpoints,
  });

  assert.deepEqual(
    resolveVisibleEvents(index, "b_retry").map((event) => event.id),
    ["e1", "e2", "e3", "r4", "r5"],
  );
  assert.deepEqual(
    resolveVisibleEvents(index, "b_root").map((event) => event.id),
    ["e1", "e2", "e3", "e4"],
  );

  const atCheckpoint = computeEventCapabilities(index, "b_retry", 5);
  assert.deepEqual(atCheckpoint.branchability, {
    status: "branchable",
    reconstruction: {
      kind: "exact",
      checkpointId: "cp5",
      checkpointEventSeq: 5,
      effectiveRestoreSeq: 5,
    },
  });

  const beforeAnyCheckpoint = computeEventCapabilities(index, "b_root", 1);
  assert.deepEqual(beforeAnyCheckpoint.branchability, {
    status: "unavailable",
    reason: "no_checkpoint",
  });
});

test("blank lines and trailing newlines are ignored", () => {
  const imported = parseChronosJsonl(`${file(line())}\n\n`);
  assert.equal(imported.events.length, 1);

  const withCarriageReturns = parseChronosJsonl(
    file(line()).split("\n").join("\r\n"),
  );
  assert.equal(withCarriageReturns.events.length, 1);
});

test("malformed records fail the whole import", () => {
  rejects("", "MISSING_SESSION");
  rejects(`${ROOT_LINE}`, "MISSING_SESSION", 1);
  rejects(`${SESSION_LINE}\n${SESSION_LINE}`, "DUPLICATE_SESSION", 2);
  rejects(SESSION_LINE, "MISSING_ROOT");
  rejects(`${SESSION_LINE}\nnot json`, "MALFORMED_LINE", 2);
  rejects(`${SESSION_LINE}\n[1,2]`, "MALFORMED_LINE", 2);
  rejects(
    `${SESSION_LINE}\n{"type":"branch","schemaVersion":2,"id":"b1"}`,
    "UNSUPPORTED_SCHEMA_VERSION",
    2,
  );
  rejects(
    `${SESSION_LINE}\n{"type":"snapshot","schemaVersion":1,"id":"x"}`,
    "UNKNOWN_RECORD_TYPE",
    2,
  );
  rejects(`${SESSION_LINE}\n${ROOT_LINE}\n${ROOT_LINE}`, "DUPLICATE_ID", 3);
  rejects(
    `${SESSION_LINE}\n${ROOT_LINE}\n{"type":"branch","schemaVersion":1,"id":"b2"}`,
    "MULTIPLE_ROOTS",
    3,
  );
});

test("event records must name a declared branch and extend it in order", () => {
  rejects(file(line({ branchId: "missing" })), "UNKNOWN_BRANCH", 3);
  rejects(file(line({ seq: 2 })), "NON_CONTIGUOUS_EVENT", 3);
  rejects(file(line(), line({ id: "e2", seq: 3 })), "NON_CONTIGUOUS_EVENT", 4);
  rejects(file(line(), line({ seq: 2 })), "DUPLICATE_ID", 4);
  rejects(file(line({ kind: "speculation" })), "INVALID_RECORD", 3);
  rejects(file(line({ occurredAt: "yesterday" })), "INVALID_RECORD", 3);
  rejects(file(line({ seq: 0 })), "INVALID_RECORD", 3);
  rejects(file(line({ summary: 7 })), "INVALID_RECORD", 3);
  rejects(file(line({ notes: "extra" })), "INVALID_RECORD", 3);
});

test("a fork must land on a coordinate its parent reached", () => {
  const child = `{"type":"branch","schemaVersion":1,"id":"b2","parentId":"b1","forkSeq":4}`;
  rejects(file(line(), child), "INVALID_FORK", 4);

  const orphan = `{"type":"branch","schemaVersion":1,"id":"b2","parentId":"nope","forkSeq":1}`;
  rejects(file(line(), orphan), "UNKNOWN_BRANCH", 4);

  const halfChild = `{"type":"branch","schemaVersion":1,"id":"b2","parentId":"b1"}`;
  rejects(file(line(), halfChild), "INVALID_RECORD", 4);
});

test("a checkpoint must follow the event it captures", () => {
  const checkpoint = (overrides = {}) =>
    JSON.stringify({
      type: "checkpoint",
      schemaVersion: 1,
      id: "cp1",
      branchId: "b1",
      eventSeq: 1,
      manifestRef: "sha256:abc",
      ...overrides,
    });

  assert.equal(
    parseChronosJsonl(file(line(), checkpoint())).checkpoints.length,
    1,
  );
  rejects(file(checkpoint(), line()), "UNKNOWN_EVENT", 3);
  rejects(file(line(), checkpoint({ eventSeq: 2 })), "UNKNOWN_EVENT", 4);
  rejects(file(line(), checkpoint(), checkpoint()), "DUPLICATE_ID", 5);
  rejects(file(line(), checkpoint({ manifestRef: "" })), "INVALID_RECORD", 4);
});

test("import limits bound what one file can do", () => {
  const input = file(line());

  assert.throws(
    () => parseChronosJsonl(input, { limits: { maxLineLength: 10 } }),
    (error) => error.code === "LIMIT_EXCEEDED" && error.line === 1,
  );
  assert.throws(
    () => parseChronosJsonl(input, { limits: { maxRecords: 2 } }),
    (error) => error.code === "LIMIT_EXCEEDED" && error.line === 3,
  );
  assert.throws(
    () => parseChronosJsonl(input, { limits: { maxRecords: 0 } }),
    (error) => error.code === "INVALID_OPTIONS",
  );
  assert.throws(
    () => parseChronosJsonl(42),
    (error) => error.code === "INVALID_INPUT",
  );
});
