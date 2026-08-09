import type {
  ImportDiagnostic,
  ImportOptions,
  ImportedSession,
  SessionAdapter,
} from "./adapter.js";
import { fail } from "./errors.js";
import {
  canonicalImport,
  json,
  record,
  requiredString,
  sourceLines,
  summary,
  type ProviderEvent,
} from "./provider-common.js";

export const CLAUDE_SAVED_SESSION_VERSION = "2.1.225";
export const CLAUDE_ADAPTER_ID = "claude";

export function parseClaudeJsonl(
  input: string,
  options: ImportOptions = {},
): ImportedSession {
  const lines = sourceLines(input, options);
  if (lines.length === 0)
    fail("MISSING_SESSION", "Claude JSONL requires at least one record");
  const first = lines[0]!;
  const sessionId = requiredString(
    first.record["sessionId"],
    "sessionId",
    first.line,
  );
  const createdAt = requiredString(
    first.record["timestamp"],
    "timestamp",
    first.line,
  );
  const events: ProviderEvent[] = [];
  const diagnostics: ImportDiagnostic[] = [];
  const seen = new Set<string>();
  let previousUuid: string | undefined;

  for (const { record: item, line } of lines) {
    const version = requiredString(item["version"], "version", line);
    if (version !== CLAUDE_SAVED_SESSION_VERSION)
      fail(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Expected Claude Code version ${CLAUDE_SAVED_SESSION_VERSION}`,
        line,
      );
    if (requiredString(item["sessionId"], "sessionId", line) !== sessionId)
      fail(
        "INVALID_RECORD",
        "Claude JSONL contains more than one session",
        line,
      );
    if (item["isSidechain"] !== false)
      fail(
        "UNSUPPORTED_RECORD",
        "Claude root records require isSidechain: false",
        line,
      );
    const uuid = requiredString(item["uuid"], "uuid", line);
    if (seen.has(uuid))
      fail("DUPLICATE_ID", `Duplicate Claude uuid: ${uuid}`, line);
    const parent = item["parentUuid"];
    if (parent === uuid)
      fail(
        "UNSUPPORTED_RECORD",
        "Claude records cannot parent themselves",
        line,
      );
    if (previousUuid === undefined && parent !== null)
      fail(
        "UNSUPPORTED_RECORD",
        "The first Claude root record requires parentUuid: null",
        line,
      );
    if (
      previousUuid !== undefined &&
      (parent !== previousUuid || !seen.has(previousUuid))
    )
      fail(
        "UNSUPPORTED_RECORD",
        "Claude non-linear root history is not supported in v0.1",
        line,
      );
    seen.add(uuid);
    previousUuid = uuid;
    const timestamp = requiredString(item["timestamp"], "timestamp", line);
    const type = item["type"];
    if (
      type === "user" &&
      record(item["message"]) &&
      item["message"]["role"] === "user"
    ) {
      const content = item["message"]["content"];
      if (typeof content === "string")
        events.push({
          kind: "instruction",
          occurredAt: timestamp,
          summary: summary(content),
          payload: { text: content },
          line,
        });
      else if (Array.isArray(content)) {
        let unsupportedBlocks = false;
        for (const block of content) {
          if (record(block) && block["type"] === "tool_result") {
            const callId = requiredString(
              block["tool_use_id"],
              "tool result id",
              line,
            );
            events.push({
              kind: "tool_result",
              occurredAt: timestamp,
              summary: `result for ${callId}`,
              payload: {
                callId,
                output: json(block["content"], line, "tool result"),
                isError: block["is_error"] === true,
              },
              line,
            });
          } else unsupportedBlocks = true;
        }
        if (unsupportedBlocks)
          diagnostics.push(
            unsupported(
              line,
              "user content array containing non-tool_result blocks",
            ),
          );
      } else diagnostics.push(unsupported(line, "user message content"));
    } else if (
      type === "assistant" &&
      record(item["message"]) &&
      item["message"]["role"] === "assistant" &&
      Array.isArray(item["message"]["content"])
    ) {
      for (const block of item["message"]["content"]) {
        if (!record(block)) {
          diagnostics.push(unsupported(line, "assistant content block"));
          continue;
        }
        if (block["type"] === "text") {
          const text = requiredString(block["text"], "assistant text", line);
          events.push({
            kind: "assistant_message",
            occurredAt: timestamp,
            summary: summary(text),
            payload: { text },
            line,
          });
        } else if (block["type"] === "tool_use") {
          const callId = requiredString(block["id"], "tool use id", line);
          const name = requiredString(block["name"], "tool name", line);
          events.push({
            kind: "tool_call",
            occurredAt: timestamp,
            summary: `${name} call`,
            payload: {
              callId,
              name,
              input: json(block["input"], line, "tool input"),
            },
            line,
          });
        } else if (block["type"] !== "thinking")
          diagnostics.push(
            unsupported(line, `assistant.${String(block["type"])}`),
          );
      }
    } else if (type === "system") {
      const textValue = item["message"] ?? item["content"];
      const subtype = item["subtype"];
      const level = item["level"];
      if (
        typeof textValue !== "string" ||
        !allowed(subtype, SYSTEM_SUBTYPES) ||
        !allowed(level, SYSTEM_LEVELS)
      ) {
        diagnostics.push(unsupported(line, "system metadata"));
        continue;
      }
      const text = textValue;
      const kind =
        level === "error" || subtype === "error" ? "error" : "system";
      events.push({
        kind,
        occurredAt: timestamp,
        summary: summary(text),
        payload: { text, subtype, level },
        line,
      });
    } else if (
      !["file-history-snapshot", "summary", "queue-operation"].includes(
        String(type),
      )
    )
      diagnostics.push(unsupported(line, String(type)));
  }
  return canonicalImport(
    CLAUDE_ADAPTER_ID,
    sessionId,
    createdAt,
    events,
    diagnostics,
    options,
  );
}

const SYSTEM_SUBTYPES = ["error", "warning", "info", "status"] as const;
const SYSTEM_LEVELS = ["error", "warning", "info"] as const;

function allowed(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}

function unsupported(line: number, type: string): ImportDiagnostic {
  return Object.freeze({
    code: "unsupported_record",
    message: `Unsupported Claude record ${type} was omitted`,
    line,
  });
}

export const claudeJsonlAdapter: SessionAdapter = Object.freeze({
  id: CLAUDE_ADAPTER_ID,
  displayName: "Claude Code saved session",
  formatVersion: 1,
  documentation: "docs/formats/provider-jsonl.md",
  parse: parseClaudeJsonl,
});
