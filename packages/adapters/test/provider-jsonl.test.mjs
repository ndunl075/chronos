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
  createProviderStreamNormalizer,
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

function completeCodex(stream) {
  stream.push(JSON.stringify({ type: "turn.started" }));
  stream.push(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    }),
  );
}

function finishStartedCodex(stream) {
  stream.push(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    }),
  );
}

function completeClaude(stream, sessionId = "session-1") {
  stream.push(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: sessionId,
    }),
  );
}

test("exact provider streams normalize tool boundaries incrementally", () => {
  const codexStream = createProviderStreamNormalizer("codex");
  assert.deepEqual(
    codexStream.push(
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    ),
    [],
  );
  assert.equal(codexStream.sessionId, "thread-1");
  codexStream.push(JSON.stringify({ type: "turn.started" }));
  assert.equal(
    codexStream.push(
      JSON.stringify({
        type: "item.started",
        timestamp: "2026-08-09T12:00:00Z",
        item: { id: "call-1", type: "command_execution", command: "echo ok" },
      }),
    )[0].kind,
    "tool_call",
  );
  assert.equal(
    codexStream.push(
      JSON.stringify({
        type: "item.completed",
        timestamp: "2026-08-09T12:00:01Z",
        item: {
          id: "call-1",
          type: "command_execution",
          command: "echo ok",
          aggregated_output: "ok",
          exit_code: 0,
        },
      }),
    )[0].kind,
    "tool_result",
  );
  finishStartedCodex(codexStream);
  codexStream.finish();

  const claudeStream = createProviderStreamNormalizer("claude");
  claudeStream.push(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-1",
    }),
  );
  const call = claudeStream.push(
    JSON.stringify({
      type: "assistant",
      session_id: "session-1",
      uuid: "record-assistant-1",
      message: {
        role: "assistant",
        id: "message-1",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Write",
            input: { path: "a" },
          },
        ],
      },
    }),
  );
  assert.equal(call[0].kind, "tool_call");
  const result = claudeStream.push(
    JSON.stringify({
      type: "user",
      session_id: "session-1",
      uuid: "record-user-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "done" },
        ],
      },
    }),
  );
  assert.equal(result[0].kind, "tool_result");
  completeClaude(claudeStream);
  claudeStream.finish();
});

test("stream normalization rejects missing initialization and dangling calls", () => {
  assert.throws(
    () => createProviderStreamNormalizer("codex").push("{}"),
    (error) =>
      error instanceof AdapterError && error.code === "MISSING_SESSION",
  );
  const stream = createProviderStreamNormalizer("codex");
  stream.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  stream.push(JSON.stringify({ type: "turn.started" }));
  stream.push(
    JSON.stringify({
      type: "item.started",
      item: { id: "c", type: "command_execution", command: "x" },
    }),
  );
  assert.throws(
    () => stream.finish(),
    (error) => error instanceof AdapterError && error.code === "INVALID_RECORD",
  );
});

test("Codex requires one ordered successful terminal turn", () => {
  const missing = createProviderStreamNormalizer("codex");
  missing.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  assert.throws(() => missing.finish(), /without a terminal record/);

  const duplicate = createProviderStreamNormalizer("codex");
  duplicate.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  completeCodex(duplicate);
  assert.throws(
    () => duplicate.push(JSON.stringify({ type: "turn.started" })),
    /after its terminal record/,
  );

  const failed = createProviderStreamNormalizer("codex");
  failed.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  failed.push(JSON.stringify({ type: "turn.started" }));
  failed.push(
    JSON.stringify({
      type: "turn.failed",
      error: { message: "provider failed" },
    }),
  );
  assert.equal(failed.terminalStatus, "failure");
  assert.throws(() => failed.finish(), /declared.*failed/);

  const malformed = createProviderStreamNormalizer("codex");
  malformed.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  malformed.push(JSON.stringify({ type: "turn.started" }));
  assert.throws(
    () => malformed.push(JSON.stringify({ type: "turn.completed", usage: {} })),
    /usage input_tokens/,
  );
});

test("Claude requires one exact terminal result and rejects re-entry", () => {
  const missing = createProviderStreamNormalizer("claude");
  missing.push(
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  );
  assert.throws(() => missing.finish(), /without a terminal record/);

  const duplicate = createProviderStreamNormalizer("claude");
  duplicate.push(
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  );
  completeClaude(duplicate, "s");
  assert.throws(
    () => completeClaude(duplicate, "s"),
    /after its terminal record/,
  );

  const failed = createProviderStreamNormalizer("claude");
  failed.push(
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  );
  failed.push(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "provider failed",
      session_id: "s",
    }),
  );
  assert.equal(failed.terminalStatus, "failure");
  assert.throws(() => failed.finish(), /declared.*failed/);
});

test("live provider streams fail closed on unallowlisted mutation surfaces", () => {
  const codexStream = createProviderStreamNormalizer("codex");
  codexStream.push(
    JSON.stringify({ type: "thread.started", thread_id: "strict-codex" }),
  );
  codexStream.push(JSON.stringify({ type: "turn.started" }));
  assert.throws(
    () =>
      codexStream.push(
        JSON.stringify({
          type: "item.completed",
          item: { id: "unknown", type: "shell_command", command: "touch x" },
        }),
      ),
    (error) =>
      error instanceof AdapterError &&
      error.code === "UNSUPPORTED_RECORD" &&
      error.details.workspaceState === "unknown",
  );

  const claudeStream = createProviderStreamNormalizer("claude");
  claudeStream.push(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "strict-claude",
    }),
  );
  assert.throws(
    () =>
      claudeStream.push(
        JSON.stringify({
          type: "assistant",
          session_id: "strict-claude",
          uuid: "computer-record",
          message: {
            role: "assistant",
            id: "computer-message",
            content: [{ type: "computer_use", id: "computer", input: {} }],
          },
        }),
      ),
    (error) =>
      error instanceof AdapterError &&
      error.code === "UNSUPPORTED_RECORD" &&
      error.details.workspaceState === "unknown",
  );
});

test("Codex completion-only commands synthesize one exact call/result batch", () => {
  const stream = createProviderStreamNormalizer("codex");
  stream.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  stream.push(JSON.stringify({ type: "turn.started" }));
  const events = stream.push(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "completion-only",
        type: "command_execution",
        command: "echo ok",
        aggregated_output: "ok\n",
        exit_code: 0,
      },
    }),
  );
  assert.deepEqual(
    events.map((event) => event.kind),
    ["tool_call", "tool_result"],
  );
  assert.deepEqual(events[1].payload, {
    callId: "completion-only",
    output: "ok\n",
    exitCode: 0,
  });
  finishStartedCodex(stream);
  stream.finish();
});

test("Codex command completion requires exact string output and integer exit code", () => {
  for (const [field, value] of [
    ["aggregated_output", { text: "no" }],
    ["exit_code", "0"],
    ["exit_code", 0.5],
    ["exit_code", null],
  ]) {
    const stream = createProviderStreamNormalizer("codex");
    stream.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
    const item = {
      id: "bad",
      type: "command_execution",
      command: "echo no",
      aggregated_output: "",
      exit_code: 0,
      [field]: value,
    };
    assert.throws(
      () => stream.push(JSON.stringify({ type: "item.completed", item })),
      (error) =>
        error instanceof AdapterError && error.code === "INVALID_RECORD",
    );
  }
});

test("stream normalization rejects reinitialization and reused call ids", () => {
  const codexStream = createProviderStreamNormalizer("codex");
  const init = JSON.stringify({ type: "thread.started", thread_id: "t" });
  codexStream.push(init);
  assert.throws(
    () => codexStream.push(init),
    (error) =>
      error instanceof AdapterError && error.code === "DUPLICATE_SESSION",
  );
  codexStream.push(JSON.stringify({ type: "turn.started" }));

  const duplicateCompletion = createProviderStreamNormalizer("codex");
  duplicateCompletion.push(init);
  duplicateCompletion.push(JSON.stringify({ type: "turn.started" }));
  const completed = JSON.stringify({
    type: "item.completed",
    item: {
      id: "call",
      type: "command_execution",
      command: "x",
      aggregated_output: "ok",
      exit_code: 0,
    },
  });
  duplicateCompletion.push(completed);
  assert.throws(
    () => duplicateCompletion.push(completed),
    (error) => error instanceof AdapterError && error.code === "DUPLICATE_ID",
  );

  const duplicateMessage = createProviderStreamNormalizer("codex");
  duplicateMessage.push(init);
  duplicateMessage.push(JSON.stringify({ type: "turn.started" }));
  const message = JSON.stringify({
    type: "item.completed",
    item: { id: "message", type: "agent_message", text: "done" },
  });
  assert.equal(duplicateMessage.push(message)[0].kind, "assistant_message");
  assert.throws(
    () => duplicateMessage.push(message),
    (error) => error instanceof AdapterError && error.code === "DUPLICATE_ID",
  );

  const claudeStream = createProviderStreamNormalizer("claude");
  const claudeInit = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s",
  });
  claudeStream.push(claudeInit);
  assert.throws(
    () => claudeStream.push(claudeInit),
    (error) =>
      error instanceof AdapterError && error.code === "DUPLICATE_SESSION",
  );

  const duplicateCall = createProviderStreamNormalizer("claude");
  duplicateCall.push(claudeInit);
  const use = JSON.stringify({
    type: "assistant",
    session_id: "s",
    uuid: "assistant-record",
    message: {
      role: "assistant",
      id: "assistant-message",
      content: [{ type: "tool_use", id: "same", name: "Write", input: {} }],
    },
  });
  duplicateCall.push(use);
  assert.throws(
    () => duplicateCall.push(use),
    (error) => error instanceof AdapterError && error.code === "DUPLICATE_ID",
  );

  const wrongSession = createProviderStreamNormalizer("claude");
  wrongSession.push(claudeInit);
  assert.throws(
    () =>
      wrongSession.push(
        JSON.stringify({
          type: "assistant",
          session_id: "other",
          uuid: "other-record",
          message: { role: "assistant", id: "other-message", content: [] },
        }),
      ),
    (error) => error instanceof AdapterError && error.code === "INVALID_RECORD",
  );

  const claudeDuplicateMessage = createProviderStreamNormalizer("claude");
  claudeDuplicateMessage.push(claudeInit);
  claudeDuplicateMessage.push(
    JSON.stringify({
      type: "assistant",
      session_id: "s",
      uuid: "record-one",
      message: { role: "assistant", id: "same-message", content: [] },
    }),
  );
  assert.throws(
    () =>
      claudeDuplicateMessage.push(
        JSON.stringify({
          type: "assistant",
          session_id: "s",
          uuid: "record-two",
          message: { role: "assistant", id: "same-message", content: [] },
        }),
      ),
    (error) => error instanceof AdapterError && error.code === "DUPLICATE_ID",
  );

  const duplicateUuid = createProviderStreamNormalizer("claude");
  duplicateUuid.push(claudeInit);
  duplicateUuid.push(
    JSON.stringify({
      type: "assistant",
      session_id: "s",
      uuid: "same-record",
      message: { role: "assistant", id: "message-one", content: [] },
    }),
  );
  assert.throws(
    () =>
      duplicateUuid.push(
        JSON.stringify({
          type: "user",
          session_id: "s",
          uuid: "same-record",
          message: { role: "user", content: [] },
        }),
      ),
    (error) => error instanceof AdapterError && error.code === "DUPLICATE_ID",
  );
});

test("Claude stream envelopes are exact and rejected records do not mutate state", () => {
  const stream = createProviderStreamNormalizer("claude");
  stream.push(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s",
    }),
  );
  stream.push(
    JSON.stringify({
      type: "assistant",
      session_id: "s",
      uuid: "call-record",
      message: {
        role: "assistant",
        id: "call-message",
        content: [{ type: "tool_use", id: "tool", name: "Write", input: {} }],
      },
    }),
  );
  assert.throws(
    () =>
      stream.push(
        JSON.stringify({
          type: "user",
          session_id: "s",
          uuid: "bad-result-record",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool",
                content: "ok",
                is_error: false,
              },
              {
                type: "tool_result",
                tool_use_id: "missing",
                content: "bad",
                is_error: false,
              },
            ],
          },
        }),
      ),
    (error) => error instanceof AdapterError && error.code === "INVALID_RECORD",
  );
  assert.equal(stream.hasPendingToolCalls, true);
  assert.equal(
    stream.push(
      JSON.stringify({
        type: "user",
        session_id: "s",
        uuid: "bad-result-record",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool",
              content: "ok",
              is_error: false,
            },
          ],
        },
      }),
    )[0].kind,
    "tool_result",
  );
  completeClaude(stream, "s");
  stream.finish();

  for (const item of [
    {
      type: "assistant",
      session_id: "s",
      message: { role: "assistant", id: "m", content: [] },
    },
    {
      type: "assistant",
      session_id: "s",
      uuid: "u",
      message: { role: "user", id: "m", content: [] },
    },
    {
      type: "user",
      session_id: "s",
      uuid: "u",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: "x",
            is_error: "false",
          },
        ],
      },
    },
  ]) {
    const exact = createProviderStreamNormalizer("claude");
    exact.push(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    );
    assert.throws(() => exact.push(JSON.stringify(item)), AdapterError);
  }

  const errorFlag = createProviderStreamNormalizer("claude");
  errorFlag.push(
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  );
  errorFlag.push(
    JSON.stringify({
      type: "assistant",
      session_id: "s",
      uuid: "error-call-record",
      message: {
        role: "assistant",
        id: "error-call-message",
        content: [
          { type: "tool_use", id: "error-tool", name: "Write", input: {} },
        ],
      },
    }),
  );
  assert.throws(
    () =>
      errorFlag.push(
        JSON.stringify({
          type: "user",
          session_id: "s",
          uuid: "error-result-record",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "error-tool",
                content: "bad",
                is_error: "false",
              },
            ],
          },
        }),
      ),
    /is_error must be boolean/,
  );
});

test("Codex validates started/completed metadata and normalizes file changes", () => {
  const changed = createProviderStreamNormalizer("codex");
  changed.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  changed.push(JSON.stringify({ type: "turn.started" }));
  assert.equal(
    changed.push(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "f",
          type: "file_change",
          changes: [{ path: "a.txt", kind: "add" }],
          status: "in_progress",
        },
      }),
    )[0].kind,
    "tool_call",
  );
  const result = changed.push(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "f",
        type: "file_change",
        changes: [{ path: "a.txt", kind: "add" }],
        status: "completed",
      },
    }),
  );
  assert.deepEqual(
    result.map((event) => event.kind),
    ["tool_result"],
  );
  finishStartedCodex(changed);
  changed.finish();

  for (const item of [
    { id: "f", type: "file_change", changes: [], status: "completed" },
    {
      id: "f",
      type: "file_change",
      changes: [{ path: "b", kind: "add" }],
      status: "completed",
    },
  ]) {
    const stream = createProviderStreamNormalizer("codex");
    stream.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
    stream.push(JSON.stringify({ type: "turn.started" }));
    stream.push(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "f",
          type: "file_change",
          changes: [],
          status: "in_progress",
        },
      }),
    );
    if (item.changes.length === 0) item.status = "failed";
    assert.throws(
      () => stream.push(JSON.stringify({ type: "item.completed", item })),
      AdapterError,
    );
    assert.equal(stream.hasPendingToolCalls, true);
  }

  const command = createProviderStreamNormalizer("codex");
  command.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  command.push(JSON.stringify({ type: "turn.started" }));
  command.push(
    JSON.stringify({
      type: "item.started",
      item: { id: "c", type: "command_execution", command: "one" },
    }),
  );
  assert.throws(
    () =>
      command.push(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "c",
            type: "command_execution",
            command: "two",
            aggregated_output: "",
            exit_code: 0,
          },
        }),
      ),
    AdapterError,
  );
  assert.equal(command.hasPendingToolCalls, true);

  const mcp = createProviderStreamNormalizer("codex");
  mcp.push(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  mcp.push(JSON.stringify({ type: "turn.started" }));
  mcp.push(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "m",
        type: "mcp_tool_call",
        server: "files",
        tool: "read",
        arguments: { path: "a", options: { encoding: "utf8", lines: 1 } },
      },
    }),
  );
  assert.throws(
    () =>
      mcp.push(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "m",
            type: "mcp_tool_call",
            server: "files",
            tool: "read-other",
            arguments: { options: { lines: 1, encoding: "utf8" }, path: "a" },
            result: "done",
          },
        }),
      ),
    /completion metadata changed/,
  );
  assert.equal(mcp.hasPendingToolCalls, true);
});

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
