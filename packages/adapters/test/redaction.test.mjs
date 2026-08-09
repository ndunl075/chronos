import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterError,
  DEFAULT_REDACTION_POLICY,
  DEFAULT_REDACTION_RULES,
  parseChronosJsonl,
  redactJson,
  redactText,
  redactionPolicy,
} from "../dist/index.js";

const SESSION_LINE = `{"type":"session","schemaVersion":1,"id":"s1","source":"chronos-jsonl","createdAt":"2026-08-09T00:00:00Z"}`;
const ROOT_LINE = `{"type":"branch","schemaVersion":1,"id":"b1"}`;

function file(event) {
  return [SESSION_LINE, ROOT_LINE, JSON.stringify(event)].join("\n");
}

function eventRecord(overrides = {}) {
  return {
    type: "event",
    schemaVersion: 1,
    id: "e1",
    branchId: "b1",
    seq: 1,
    kind: "tool_result",
    occurredAt: "2026-08-09T00:00:00Z",
    summary: "read the config",
    payload: { text: "ok" },
    ...overrides,
  };
}

test("the default rules catch well-known secret shapes", () => {
  const cases = [
    ["aws_access_key_id", "id=AKIAIOSFODNN7EXAMPLE done"],
    ["github_token", `ghp_${"a".repeat(36)}`],
    ["slack_token", "xoxb-1234567890-abcdefghij"],
    [
      "json_web_token",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u",
    ],
    ["bearer_token", "Authorization: Bearer abcdefghijklmnop1234"],
    ["url_credentials", "https://admin:hunter2@example.test/db"],
    ["assigned_secret", 'api_key = "s3cr3t-value-here"'],
    [
      "pem_private_key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
    ],
  ];

  for (const [ruleId, input] of cases) {
    const result = redactText(input);
    assert.deepEqual(result.matchedRuleIds, [ruleId], `rule ${ruleId}`);
    assert.match(result.value, /\[redacted:/, `rule ${ruleId}`);
  }
});

test("ordinary transcript text is left alone", () => {
  for (const input of [
    "Fix the flaky upload test",
    "tokenizer.encode(text) returned 42 tokens",
    "see https://example.test/docs/auth for the flow",
    "git commit -m 'add retry'",
  ]) {
    assert.deepEqual(redactText(input), { value: input, matchedRuleIds: [] });
  }
});

test("values under a sensitive field name are removed whatever they hold", () => {
  const result = redactJson({
    tool: "http_request",
    headers: { Authorization: "abc", "X-Trace": "keep-me" },
    "api-key": 12345,
    credentials: { user: "nico", password: "hunter2" },
    nested: [{ SECRET: ["a", "b"] }],
  });

  assert.deepEqual(result.value, {
    tool: "http_request",
    headers: { Authorization: "[redacted:field]", "X-Trace": "keep-me" },
    "api-key": "[redacted:field]",
    credentials: "[redacted:field]",
    nested: [{ SECRET: "[redacted:field]" }],
  });
  assert.deepEqual(result.matchedRuleIds, ["sensitive_field"]);
});

test("redaction reports every rule that fired and preserves structure", () => {
  const result = redactJson({
    lines: [`export GITHUB_TOKEN=ghp_${"b".repeat(36)}`, "all good"],
    aws: "AKIAIOSFODNN7EXAMPLE",
    count: 3,
    flag: true,
    empty: null,
  });

  assert.deepEqual(result.matchedRuleIds, [
    "aws_access_key_id",
    "github_token",
  ]);
  assert.equal(result.value.lines[1], "all good");
  assert.equal(result.value.count, 3);
  assert.equal(result.value.flag, true);
  assert.equal(result.value.empty, null);
});

test("an earlier rule's marker is not redacted again", () => {
  const result = redactText(`api_key = ghp_${"c".repeat(36)}`);

  assert.equal(result.value, "api_key = [redacted:github token]");
  assert.deepEqual(result.matchedRuleIds, ["github_token"]);
});

test("a stateful custom pattern cannot skip matches", () => {
  const policy = redactionPolicy({
    rules: [
      { id: "digits", label: "digits", pattern: /\d{4}/g },
      { id: "unflagged", label: "word", pattern: /needle/ },
    ],
    sensitiveKeys: [],
  });
  policy.rules[0].pattern.lastIndex = 20;

  const result = redactText("1234 and 5678 and needle needle", policy);
  assert.equal(
    result.value,
    "[redacted:digits] and [redacted:digits] and [redacted:word] [redacted:word]",
  );
  assert.deepEqual(result.matchedRuleIds, ["digits", "unflagged"]);
});

test("a malformed policy is rejected", () => {
  assert.throws(
    () => redactionPolicy({ rules: [{ id: "x", label: "x", pattern: "no" }] }),
    (error) =>
      error instanceof AdapterError && error.code === "INVALID_OPTIONS",
  );
  assert.throws(
    () =>
      redactionPolicy({
        rules: [
          { id: "dup", label: "a", pattern: /a/ },
          { id: "dup", label: "b", pattern: /b/ },
        ],
      }),
    (error) => error.code === "INVALID_OPTIONS",
  );
  assert.throws(
    () => redactionPolicy({ sensitiveKeys: [" "] }),
    (error) => error.code === "INVALID_OPTIONS",
  );
  assert.equal(DEFAULT_REDACTION_POLICY.rules, DEFAULT_REDACTION_RULES);
});

test("imports redact canonical data by default", () => {
  const imported = parseChronosJsonl(
    file(
      eventRecord({
        summary: "curl -H 'Authorization: Bearer abcdefghijklmnop1234'",
        payload: { stdout: "AKIAIOSFODNN7EXAMPLE", token: "raw-value" },
      }),
    ),
  );

  const event = imported.events[0];
  assert.equal(
    event.summary,
    "curl -H 'Authorization: [redacted:bearer token]'",
  );
  assert.deepEqual(event.payload.data, {
    stdout: "[redacted:aws key]",
    token: "[redacted:field]",
  });
  assert.deepEqual(
    imported.diagnostics.filter((item) => item.code === "redacted"),
    [
      {
        code: "redacted",
        message:
          "Event e1 matched aws_access_key_id, bearer_token, sensitive_field",
        line: 3,
      },
    ],
  );
});

test("disabling redaction is possible but never silent", () => {
  const source = file(
    eventRecord({ payload: { stdout: "AKIAIOSFODNN7EXAMPLE" } }),
  );

  const imported = parseChronosJsonl(source, { redaction: null });
  assert.deepEqual(imported.events[0].payload.data, {
    stdout: "AKIAIOSFODNN7EXAMPLE",
  });
  assert.equal(
    imported.diagnostics.some((item) => item.code === "redaction_disabled"),
    true,
  );
  assert.equal(
    imported.diagnostics.some((item) => item.code === "redacted"),
    false,
  );

  const custom = parseChronosJsonl(source, {
    redaction: { rules: [], sensitiveKeys: ["stdout"] },
  });
  assert.deepEqual(custom.events[0].payload.data, {
    stdout: "[redacted:field]",
  });
});
