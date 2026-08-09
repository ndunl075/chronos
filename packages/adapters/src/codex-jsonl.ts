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

export const CODEX_SAVED_SESSION_VERSION = "0.146.0-alpha.3";
export const CODEX_ADAPTER_ID = "codex";

export function parseCodexJsonl(
  input: string,
  options: ImportOptions = {},
): ImportedSession {
  const lines = sourceLines(input, options);
  const metadataRecords = lines.filter(
    ({ record: item }) => item["type"] === "session_meta",
  );
  if (metadataRecords.length > 1)
    fail(
      "DUPLICATE_SESSION",
      "Codex JSONL must contain exactly one session_meta record",
      metadataRecords[1]!.line,
    );
  const metadata = metadataRecords[0];
  if (metadata === undefined || !record(metadata.record["payload"]))
    fail("MISSING_SESSION", "Codex JSONL requires a session_meta record");
  const meta = metadata.record["payload"];
  const version = requiredString(
    meta["cli_version"],
    "session_meta.payload.cli_version",
    metadata.line,
  );
  if (version !== CODEX_SAVED_SESSION_VERSION)
    fail(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Expected Codex CLI version ${CODEX_SAVED_SESSION_VERSION}`,
      metadata.line,
    );
  const sessionId = requiredString(
    meta["id"],
    "session_meta.payload.id",
    metadata.line,
  );
  const createdAt = requiredString(
    meta["timestamp"],
    "session_meta.payload.timestamp",
    metadata.line,
  );
  const events: ProviderEvent[] = [];
  const diagnostics: ImportDiagnostic[] = [];

  for (const { record: outer, line } of lines) {
    const timestamp = requiredString(outer["timestamp"], "timestamp", line);
    const payload = outer["payload"];
    if (!record(payload)) {
      diagnostics.push(unsupported(line, String(outer["type"] ?? "unknown")));
      continue;
    }
    if (outer["type"] === "event_msg") {
      const type = payload["type"];
      if (type === "user_message") {
        const text = requiredString(payload["message"], "user message", line);
        events.push({
          kind: "instruction",
          occurredAt: timestamp,
          summary: summary(text),
          payload: { text },
          line,
        });
      } else if (type === "error" || type === "system") {
        const text = requiredString(
          payload["message"],
          `${String(type)} message`,
          line,
        );
        events.push({
          kind: type === "error" ? "error" : "system",
          occurredAt: timestamp,
          summary: summary(text),
          payload: { text },
          line,
        });
      } else diagnostics.push(unsupported(line, `event_msg.${String(type)}`));
      continue;
    }
    if (outer["type"] !== "response_item") {
      if (outer["type"] !== "session_meta")
        diagnostics.push(unsupported(line, String(outer["type"] ?? "unknown")));
      continue;
    }
    const type = payload["type"];
    if (
      type === "message" &&
      payload["role"] === "assistant" &&
      Array.isArray(payload["content"])
    ) {
      for (const [block, content] of payload["content"].entries()) {
        if (!record(content) || content["type"] !== "output_text") {
          diagnostics.push(
            unsupported(
              line,
              `response_item.message.${String(record(content) ? content["type"] : "invalid")}`,
            ),
          );
          continue;
        }
        const text = requiredString(content["text"], "assistant text", line);
        events.push({
          kind: "assistant_message",
          occurredAt: timestamp,
          summary: summary(text),
          payload: { text, block },
          line,
        });
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      const callId = requiredString(payload["call_id"], "tool call id", line);
      const name = requiredString(payload["name"], "tool name", line);
      const input =
        type === "function_call"
          ? parseArguments(payload["arguments"], line)
          : json(payload["input"], line, "tool input");
      events.push({
        kind: "tool_call",
        occurredAt: timestamp,
        summary: `${name} call`,
        payload: { callId, name, input },
        line,
      });
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      const callId = requiredString(
        payload["call_id"],
        "tool result call id",
        line,
      );
      events.push({
        kind: "tool_result",
        occurredAt: timestamp,
        summary: `result for ${callId}`,
        payload: {
          callId,
          output: json(payload["output"], line, "tool output"),
        },
        line,
      });
    } else diagnostics.push(unsupported(line, `response_item.${String(type)}`));
  }
  return canonicalImport(
    CODEX_ADAPTER_ID,
    sessionId,
    createdAt,
    events,
    diagnostics,
    options,
  );
}

function parseArguments(value: unknown, line: number) {
  const text = requiredString(value, "function arguments", line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("INVALID_RECORD", "function arguments must be valid JSON", line);
  }
  return json(parsed, line, "function arguments");
}
function unsupported(line: number, type: string): ImportDiagnostic {
  return Object.freeze({
    code: "unsupported_record",
    message: `Unsupported Codex record ${type} was omitted`,
    line,
  });
}

export const codexJsonlAdapter: SessionAdapter = Object.freeze({
  id: CODEX_ADAPTER_ID,
  displayName: "Codex saved session",
  formatVersion: 1,
  documentation: "docs/formats/provider-jsonl.md",
  parse: parseCodexJsonl,
});
