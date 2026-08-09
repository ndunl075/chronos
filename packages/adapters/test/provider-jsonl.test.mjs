import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdapterError,
  CLAUDE_SAVED_SESSION_VERSION,
  CODEX_SAVED_SESSION_VERSION,
  claudeJsonlAdapter,
  codexJsonlAdapter,
} from "../dist/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const codex = readFileSync(
  join(fixtures, `codex-${CODEX_SAVED_SESSION_VERSION}.jsonl`),
  "utf8",
);
const claude = readFileSync(
  join(fixtures, `claude-${CLAUDE_SAVED_SESSION_VERSION}.jsonl`),
  "utf8",
);

test("Codex imports the exact visible surface once", () => {
  const imported = codexJsonlAdapter.parse(codex);
  assert.deepEqual(imported.session, {
    id: "codex-fixture",
    source: "codex",
    createdAt: "2026-08-09T12:00:00Z",
  });
  assert.deepEqual(imported.branches, [
    {
      id: "codex:codex-fixture:root",
      sessionId: "codex-fixture",
      state: "ready",
    },
  ]);
  assert.deepEqual(
    imported.events.map(({ id, seq, kind, payload }) => ({
      id,
      seq,
      kind,
      data: payload.data,
    })),
    [
      {
        id: "codex:codex-fixture:2:1",
        seq: 1,
        kind: "instruction",
        data: { text: "Fix the retry test" },
      },
      {
        id: "codex:codex-fixture:4:2",
        seq: 2,
        kind: "assistant_message",
        data: { text: "I will inspect the test.", block: 0 },
      },
      {
        id: "codex:codex-fixture:6:3",
        seq: 3,
        kind: "tool_call",
        data: {
          callId: "call-1",
          name: "read_file",
          input: { path: "test/retry.test.ts" },
        },
      },
      {
        id: "codex:codex-fixture:7:4",
        seq: 4,
        kind: "tool_result",
        data: { callId: "call-1", output: "const retries = 2;" },
      },
      {
        id: "codex:codex-fixture:8:5",
        seq: 5,
        kind: "error",
        data: { text: "Synthetic provider warning" },
      },
    ],
  );
  assert.deepEqual(
    imported.diagnostics.map(({ code, line }) => [code, line]),
    [
      ["unsupported_record", 3],
      ["unsupported_record", 5],
      ["no_checkpoints", undefined],
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(imported),
    /encrypted_content|synthetic-omitted/,
  );
});

test("Claude imports exact visible blocks and omits hidden/file history", () => {
  const imported = claudeJsonlAdapter.parse(claude);
  assert.deepEqual(imported.session, {
    id: "claude-fixture",
    source: "claude",
    createdAt: "2026-08-09T13:00:00Z",
  });
  assert.deepEqual(
    imported.events.map(({ id, seq, kind, payload }) => ({
      id,
      seq,
      kind,
      data: payload.data,
    })),
    [
      {
        id: "claude:claude-fixture:1:1",
        seq: 1,
        kind: "instruction",
        data: { text: "Fix the retry test" },
      },
      {
        id: "claude:claude-fixture:2:2",
        seq: 2,
        kind: "assistant_message",
        data: { text: "I will inspect the test." },
      },
      {
        id: "claude:claude-fixture:2:3",
        seq: 3,
        kind: "tool_call",
        data: {
          callId: "tool-1",
          name: "Read",
          input: { file_path: "test/retry.test.ts" },
        },
      },
      {
        id: "claude:claude-fixture:3:4",
        seq: 4,
        kind: "tool_result",
        data: {
          callId: "tool-1",
          output: "const retries = 2;",
          isError: false,
        },
      },
      {
        id: "claude:claude-fixture:5:5",
        seq: 5,
        kind: "error",
        data: {
          text: "Synthetic provider warning",
          subtype: "error",
          level: "error",
        },
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(imported),
    /thinking|signature|trackedFileBackups/,
  );
});

for (const [name, adapter, fixture, field, version] of [
  [
    "Codex",
    codexJsonlAdapter,
    codex,
    "cli_version",
    CODEX_SAVED_SESSION_VERSION,
  ],
  [
    "Claude",
    claudeJsonlAdapter,
    claude,
    "version",
    CLAUDE_SAVED_SESSION_VERSION,
  ],
]) {
  test(`${name} rejects missing and unknown source versions`, () => {
    assert.throws(
      () =>
        adapter.parse(
          fixture.replace(`"${field}":"${version}"`, `"${field}":"future"`),
        ),
      isError("UNSUPPORTED_SCHEMA_VERSION"),
    );
    assert.throws(
      () => adapter.parse(fixture.replace(`"${field}":"${version}",`, "")),
      isError("INVALID_RECORD"),
    );
  });
  test(`${name} rejects raw retention`, () =>
    assert.throws(
      () => adapter.parse(fixture, { retainRaw: true }),
      isError("INVALID_OPTIONS"),
    ));
}

test("provider input is capped before line splitting", () => {
  assert.throws(
    () =>
      codexJsonlAdapter.parse("x".repeat(11), {
        limits: { maxInputLength: 10 },
      }),
    isError("LIMIT_EXCEEDED"),
  );
});

test("Codex requires one exact metadata record and valid function JSON", () => {
  assert.throws(
    () => codexJsonlAdapter.parse(`${codex}\n${codex.split("\n")[0]}`),
    isError("DUPLICATE_SESSION"),
  );
  assert.throws(
    () =>
      codexJsonlAdapter.parse(
        codex.replace('"id":"codex-fixture"', '"session_id":"codex-fixture"'),
      ),
    isError("INVALID_RECORD"),
  );
  assert.throws(
    () =>
      codexJsonlAdapter.parse(
        codex.replace('{\\"path\\":\\"test/retry.test.ts\\"}', "not-json"),
      ),
    isError("INVALID_RECORD"),
  );
});

test("Codex diagnoses unsupported assistant aliases", () => {
  const imported = codexJsonlAdapter.parse(
    codex.replace(
      '"type":"output_text","text":"I will inspect the test."',
      '"type":"text","text":"alias"',
    ),
  );
  assert.equal(
    imported.events.some(({ kind }) => kind === "assistant_message"),
    false,
  );
  assert.equal(
    imported.diagnostics.some(({ line }) => line === 4),
    true,
  );
});

test("Claude requires explicit, unique, linear root identity", () => {
  for (const [input, code] of [
    [claude.replace('"isSidechain":false,', ""), "UNSUPPORTED_RECORD"],
    [claude.replace('"uuid":"u2"', '"uuid":"u1"'), "DUPLICATE_ID"],
    [
      claude.replace(
        '"parentUuid":"u1","isSidechain":false,"uuid":"u2"',
        '"parentUuid":"u2","isSidechain":false,"uuid":"u2"',
      ),
      "UNSUPPORTED_RECORD",
    ],
    [
      claude.replace('"parentUuid":"u1"', '"parentUuid":"missing"'),
      "UNSUPPORTED_RECORD",
    ],
    [
      claude.replace('"parentUuid":"u2"', '"parentUuid":"u1"'),
      "UNSUPPORTED_RECORD",
    ],
  ])
    assert.throws(() => claudeJsonlAdapter.parse(input), isError(code));
});

test("Claude diagnoses mixed user blocks and never stringifies system objects", () => {
  const mixed = claude.replace(
    '{"type":"tool_result","tool_use_id":"tool-1","content":"const retries = 2;","is_error":false}',
    '{"type":"tool_result","tool_use_id":"tool-1","content":"ok","is_error":false},{"type":"text","text":"not an instruction"}',
  );
  const imported = claudeJsonlAdapter.parse(mixed);
  assert.equal(
    imported.events.filter(({ kind }) => kind === "instruction").length,
    1,
  );
  assert.equal(
    imported.events.filter(({ kind }) => kind === "tool_result").length,
    1,
  );
  assert.equal(
    imported.diagnostics.some(({ line }) => line === 3),
    true,
  );

  const arbitrary = claude.replace(
    '"subtype":"error","level":"error","message":"Synthetic provider warning"',
    '"subtype":"invented","level":"error","message":{"secret":"must-not-stringify"}',
  );
  const omitted = claudeJsonlAdapter.parse(arbitrary);
  assert.equal(
    omitted.events.some(({ kind }) => kind === "error"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(omitted), /must-not-stringify/);
  assert.equal(
    omitted.diagnostics.some(({ line }) => line === 5),
    true,
  );
});

function isError(code) {
  return (error) => error instanceof AdapterError && error.code === code;
}
