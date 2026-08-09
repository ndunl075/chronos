import {
  isRfc3339Timestamp,
  type EventKind,
  type JsonValue,
} from "@chronos/protocol";

import { fail } from "./errors.js";
import {
  json,
  record,
  requiredString,
  summary,
  type ProviderEvent,
} from "./provider-common.js";

export type ProviderAgent = "codex" | "claude";

export type StreamEvent = Omit<ProviderEvent, "line">;

export interface ProviderStreamNormalizer {
  readonly sessionId: string | undefined;
  readonly hasPendingToolCalls: boolean;
  readonly terminalStatus: "success" | "failure" | undefined;
  push(line: string): readonly StreamEvent[];
  finish(): void;
}

interface NormalizerSnapshot {
  readonly sessionId: string | undefined;
  readonly initialized: boolean;
  readonly pendingCalls: readonly string[];
  readonly seenCalls: readonly string[];
  readonly completedCalls: readonly string[];
  readonly pendingCallDetails: readonly (readonly [string, string])[];
  readonly seenVisibleItems: readonly string[];
  readonly seenRecordIds: readonly string[];
  readonly turnStarted: boolean;
  readonly terminalStatus: "success" | "failure" | undefined;
}

const MAX_LINE_LENGTH = 1_048_576;
const MAX_STREAM_LENGTH = 67_108_864;
const MAX_RECORDS = 200_000;

/** Stateful, bounded normalization for the exact v0.1 noninteractive streams. */
export function createProviderStreamNormalizer(
  agent: ProviderAgent,
): ProviderStreamNormalizer {
  return new StreamNormalizer(agent);
}

class StreamNormalizer implements ProviderStreamNormalizer {
  readonly #agent: ProviderAgent;
  #sessionId: string | undefined;
  #bytes = 0;
  #records = 0;
  #initialized = false;
  readonly #pendingCalls = new Set<string>();
  readonly #seenCalls = new Set<string>();
  readonly #completedCalls = new Set<string>();
  readonly #pendingCallDetails = new Map<string, string>();
  readonly #seenVisibleItems = new Set<string>();
  readonly #seenRecordIds = new Set<string>();
  #turnStarted = false;
  #terminalStatus: "success" | "failure" | undefined;

  constructor(agent: ProviderAgent) {
    this.#agent = agent;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get hasPendingToolCalls(): boolean {
    return this.#pendingCalls.size !== 0;
  }

  get terminalStatus(): "success" | "failure" | undefined {
    return this.#terminalStatus;
  }

  push(line: string): readonly StreamEvent[] {
    if (this.#terminalStatus !== undefined)
      fail(
        "INVALID_RECORD",
        "Provider stream contains a record after its terminal record",
      );
    if (typeof line !== "string")
      fail("INVALID_INPUT", "Provider stream line must be text");
    this.#bytes += new TextEncoder().encode(line).byteLength + 1;
    this.#records += 1;
    if (line.length > MAX_LINE_LENGTH)
      fail(
        "LIMIT_EXCEEDED",
        "Provider stream line exceeds the configured limit",
      );
    if (this.#bytes > MAX_STREAM_LENGTH)
      fail("LIMIT_EXCEEDED", "Provider stream exceeds the configured limit");
    if (this.#records > MAX_RECORDS)
      fail("LIMIT_EXCEEDED", "Provider stream has too many records");
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      fail(
        "MALFORMED_LINE",
        "Provider stream line is not valid JSON",
        this.#records,
      );
    }
    if (!record(value))
      fail(
        "MALFORMED_LINE",
        "Provider stream line must be a JSON object",
        this.#records,
      );
    const before = this.#snapshot();
    try {
      return Object.freeze(
        this.#agent === "codex" ? this.#codex(value) : this.#claude(value),
      );
    } catch (error) {
      this.#restore(before);
      throw error;
    }
  }

  finish(): void {
    if (!this.#initialized)
      fail(
        "MISSING_SESSION",
        "Provider stream did not contain an initialization record",
      );
    if (this.#pendingCalls.size !== 0)
      fail(
        "INVALID_RECORD",
        "Provider stream ended with an incomplete tool call",
      );
    if (this.#terminalStatus === undefined)
      fail("INVALID_RECORD", "Provider stream ended without a terminal record");
    if (this.#terminalStatus === "failure")
      fail(
        "INVALID_RECORD",
        "Provider declared that the recorded turn failed",
        undefined,
        {
          providerTerminalFailure: 1,
          workspaceState: "unknown",
        },
      );
  }

  #codex(item: Readonly<Record<string, unknown>>): StreamEvent[] {
    const type = item["type"];
    if (!this.#initialized) {
      if (type !== "thread.started")
        fail("MISSING_SESSION", "Codex stream must begin with thread.started");
      this.#sessionId = requiredString(
        item["thread_id"],
        "thread_id",
        this.#records,
      );
      this.#initialized = true;
      return [];
    }
    if (type === "thread.started")
      fail(
        "DUPLICATE_SESSION",
        "Codex stream cannot initialize more than one thread",
        this.#records,
      );
    if (type === "turn.started") {
      if (this.#turnStarted)
        fail(
          "INVALID_RECORD",
          "Codex stream cannot start more than one turn",
          this.#records,
        );
      this.#turnStarted = true;
      return [];
    }
    if (type === "turn.completed" || type === "turn.failed") {
      if (!this.#turnStarted)
        fail(
          "INVALID_RECORD",
          "Codex terminal record requires one preceding turn.started",
          this.#records,
        );
      if (this.#pendingCalls.size !== 0)
        fail(
          "INVALID_RECORD",
          "Codex turn terminated with an incomplete tool call",
          this.#records,
        );
      if (type === "turn.completed") {
        const usage = item["usage"];
        if (!record(usage))
          fail(
            "INVALID_RECORD",
            "Codex completed turn requires usage",
            this.#records,
          );
        for (const field of [
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
        ])
          requiredNonnegativeInteger(
            usage[field],
            `Codex usage ${field}`,
            this.#records,
          );
        this.#terminalStatus = "success";
      } else {
        const error = item["error"];
        if (!record(error))
          fail(
            "INVALID_RECORD",
            "Codex failed turn requires an error object",
            this.#records,
          );
        requiredString(
          error["message"],
          "Codex turn failure message",
          this.#records,
        );
        this.#terminalStatus = "failure";
      }
      return [];
    }
    if (!this.#turnStarted)
      fail(
        "INVALID_RECORD",
        "Codex item records require one preceding turn.started",
        this.#records,
      );
    if (type !== "item.started" && type !== "item.completed") {
      unsafeUnsupported(
        `Unsupported Codex stream record type: ${String(type)}`,
        this.#records,
      );
    }
    const detail = item["item"];
    if (!record(detail))
      fail("INVALID_RECORD", "Codex item must be an object", this.#records);
    const itemType = detail["type"];
    const occurredAt = timestamp(item);
    if (itemType === "agent_message" && type === "item.completed") {
      const itemId = requiredString(
        detail["id"],
        "agent message id",
        this.#records,
      );
      if (this.#seenVisibleItems.has(itemId))
        fail(
          "DUPLICATE_ID",
          `Provider visible item id is not unique: ${itemId}`,
          this.#records,
        );
      this.#seenVisibleItems.add(itemId);
      const text = requiredString(
        detail["text"],
        "agent message text",
        this.#records,
      );
      return [event("assistant_message", occurredAt, summary(text), { text })];
    }
    // These exact-version surfaces are known to be non-mutating. Started
    // message frames and hidden reasoning frames carry no workspace effect.
    if (
      (itemType === "agent_message" && type === "item.started") ||
      itemType === "reasoning"
    ) {
      return [];
    }
    if (itemType === "command_execution") {
      const callId = requiredString(
        detail["id"],
        "command execution id",
        this.#records,
      );
      if (type === "item.started") {
        validateLifecycleStatus(detail, type, "command", this.#records);
        const command = requiredString(
          detail["command"],
          "command",
          this.#records,
        );
        this.#startCall(callId, stableDetail({ type: itemType, command }));
        return [
          event("tool_call", occurredAt, "command execution", {
            callId,
            name: "command_execution",
            input: { command },
          }),
        ];
      }
      const events: StreamEvent[] = [];
      validateLifecycleStatus(detail, type, "command", this.#records);
      const command = requiredString(
        detail["command"],
        "command",
        this.#records,
      );
      const callDetail = stableDetail({ type: itemType, command });
      if (!this.#completeCall(callId, callDetail)) {
        this.#rememberCompletionOnly(callId);
        events.push(
          event("tool_call", occurredAt, "command execution", {
            callId,
            name: "command_execution",
            input: { command },
          }),
        );
      }
      events.push(
        event("tool_result", occurredAt, `result for ${callId}`, {
          callId,
          output: requiredStringValue(
            detail["aggregated_output"],
            "command output",
            this.#records,
          ),
          exitCode: requiredInteger(
            detail["exit_code"],
            "command exit code",
            this.#records,
          ),
        }),
      );
      return events;
    }
    if (itemType === "mcp_tool_call") {
      const callId = requiredString(detail["id"], "MCP call id", this.#records);
      const name = requiredString(detail["tool"], "MCP tool", this.#records);
      const input = json(detail["arguments"], this.#records, "MCP arguments");
      const server =
        detail["server"] === undefined
          ? undefined
          : requiredString(detail["server"], "MCP server", this.#records);
      const callDetail = stableDetail({
        type: String(itemType),
        name,
        input,
        ...(server === undefined ? {} : { server }),
      });
      if (type === "item.started") {
        validateLifecycleStatus(detail, type, "MCP call", this.#records);
        this.#startCall(callId, callDetail);
        return [
          event("tool_call", occurredAt, `${name} call`, {
            callId,
            name,
            input,
          }),
        ];
      }
      const events: StreamEvent[] = [];
      validateLifecycleStatus(detail, type, "MCP call", this.#records);
      if (!this.#completeCall(callId, callDetail)) {
        this.#rememberCompletionOnly(callId);
        events.push(
          event("tool_call", occurredAt, `${name} call`, {
            callId,
            name,
            input,
          }),
        );
      }
      events.push(
        event("tool_result", occurredAt, `result for ${callId}`, {
          callId,
          output: json(
            detail["result"] ?? detail["error"],
            this.#records,
            "MCP result",
          ),
        }),
      );
      return events;
    }
    if (itemType === "file_change") {
      const callId = requiredString(
        detail["id"],
        "file change id",
        this.#records,
      );
      const changes = fileChanges(detail["changes"], this.#records);
      const status = requiredString(
        detail["status"],
        "file change status",
        this.#records,
      );
      const callDetail = stableDetail({ type: itemType, changes });
      if (type === "item.started") {
        if (status !== "in_progress")
          fail(
            "INVALID_RECORD",
            "started file change must be in_progress",
            this.#records,
          );
        this.#startCall(callId, callDetail);
        return [
          event("tool_call", occurredAt, "file change", {
            callId,
            name: "file_change",
            input: { changes },
          }),
        ];
      }
      if (status !== "completed")
        fail(
          "INVALID_RECORD",
          "completed file change must be completed",
          this.#records,
        );
      const events: StreamEvent[] = [];
      if (!this.#completeCall(callId, callDetail)) {
        this.#rememberCompletionOnly(callId);
        events.push(
          event("tool_call", occurredAt, "file change", {
            callId,
            name: "file_change",
            input: { changes },
          }),
        );
      }
      events.push(
        event("tool_result", occurredAt, `result for ${callId}`, {
          callId,
          output: { changes, status },
        }),
      );
      return events;
    }
    unsafeUnsupported(
      `Unsupported Codex ${type} item type: ${String(itemType)}`,
      this.#records,
    );
  }

  #claude(item: Readonly<Record<string, unknown>>): StreamEvent[] {
    const type = item["type"];
    if (!this.#initialized) {
      if (type !== "system" || item["subtype"] !== "init")
        fail("MISSING_SESSION", "Claude stream must begin with system.init");
      this.#sessionId = requiredString(
        item["session_id"],
        "session_id",
        this.#records,
      );
      this.#initialized = true;
      return [];
    }
    if (type === "system" && item["subtype"] === "init")
      fail(
        "DUPLICATE_SESSION",
        "Claude stream cannot initialize more than one session",
        this.#records,
      );
    const sessionId = requiredString(
      item["session_id"],
      "session_id",
      this.#records,
    );
    if (sessionId !== this.#sessionId)
      fail(
        "INVALID_RECORD",
        "Claude stream record belongs to a different session",
        this.#records,
      );
    if (type === "assistant" || type === "user") {
      const id = requiredString(item["uuid"], "uuid", this.#records);
      if (this.#seenRecordIds.has(id))
        fail(
          "DUPLICATE_ID",
          `Claude stream record uuid is not unique: ${id}`,
          this.#records,
        );
      this.#seenRecordIds.add(id);
    }
    if (type === "result") {
      const subtype = requiredString(
        item["subtype"],
        "Claude result subtype",
        this.#records,
      );
      if (typeof item["is_error"] !== "boolean")
        fail(
          "INVALID_RECORD",
          "Claude result is_error must be boolean",
          this.#records,
        );
      const isError = item["is_error"];
      if (subtype === "success") {
        if (isError)
          fail(
            "INVALID_RECORD",
            "Claude success result cannot be an error",
            this.#records,
          );
        requiredString(item["result"], "Claude result text", this.#records);
        this.#terminalStatus = "success";
      } else {
        const failures = new Set([
          "error_during_execution",
          "error_max_turns",
          "error_max_budget_usd",
          "error_max_structured_output_retries",
        ]);
        if (!failures.has(subtype) || !isError)
          fail(
            "INVALID_RECORD",
            "Unsupported Claude terminal result",
            this.#records,
          );
        requiredString(item["result"], "Claude failure result", this.#records);
        this.#terminalStatus = "failure";
      }
      return [];
    }
    if (type !== "assistant" && type !== "user") {
      unsafeUnsupported(
        `Unsupported Claude stream record type: ${String(type)}`,
        this.#records,
      );
    }
    if (!record(item["message"]))
      fail("INVALID_RECORD", "Claude message must be an object", this.#records);
    const message = item["message"];
    if (message["role"] !== type)
      fail(
        "INVALID_RECORD",
        `Claude ${type} message role must match its envelope`,
        this.#records,
      );
    if (type === "assistant") {
      const messageId = requiredString(
        message["id"],
        "assistant message id",
        this.#records,
      );
      if (this.#seenVisibleItems.has(messageId))
        fail(
          "DUPLICATE_ID",
          `Claude assistant message id is not unique: ${messageId}`,
          this.#records,
        );
      this.#seenVisibleItems.add(messageId);
    }
    const content = message["content"];
    if (!Array.isArray(content))
      fail(
        "INVALID_RECORD",
        "Claude message content must be an array",
        this.#records,
      );
    const occurredAt = timestamp(item);
    const events: StreamEvent[] = [];
    for (const block of content) {
      if (!record(block))
        fail(
          "INVALID_RECORD",
          "Claude content blocks must be objects",
          this.#records,
        );
      if (type === "assistant" && block["type"] === "text") {
        const text = requiredString(
          block["text"],
          "assistant text",
          this.#records,
        );
        events.push(
          event("assistant_message", occurredAt, summary(text), { text }),
        );
      } else if (type === "assistant" && block["type"] === "tool_use") {
        const callId = requiredString(
          block["id"],
          "tool use id",
          this.#records,
        );
        const name = requiredString(block["name"], "tool name", this.#records);
        this.#startCall(
          callId,
          stableDetail({
            type: "tool_use",
            name,
            input: json(block["input"], this.#records, "tool input"),
          }),
        );
        events.push(
          event("tool_call", occurredAt, `${name} call`, {
            callId,
            name,
            input: json(block["input"], this.#records, "tool input"),
          }),
        );
      } else if (type === "user" && block["type"] === "tool_result") {
        const callId = requiredString(
          block["tool_use_id"],
          "tool result id",
          this.#records,
        );
        if (
          block["is_error"] !== undefined &&
          typeof block["is_error"] !== "boolean"
        )
          fail(
            "INVALID_RECORD",
            "tool result is_error must be boolean",
            this.#records,
          );
        if (!this.#completeCall(callId))
          fail(
            "INVALID_RECORD",
            `Tool result has no matching call: ${callId}`,
            this.#records,
          );
        events.push(
          event("tool_result", occurredAt, `result for ${callId}`, {
            callId,
            output: json(block["content"], this.#records, "tool result"),
            isError: block["is_error"] === true,
          }),
        );
      } else if (
        (type === "assistant" &&
          (block["type"] === "thinking" ||
            block["type"] === "redacted_thinking")) ||
        (type === "user" && block["type"] === "text")
      ) {
        // Explicitly known inert/duplicate surfaces for Claude Code 2.1.225.
        continue;
      } else {
        unsafeUnsupported(
          `Unsupported Claude ${type} content block type: ${String(block["type"])}`,
          this.#records,
        );
      }
    }
    return events;
  }

  #startCall(callId: string, details?: string): void {
    if (this.#seenCalls.has(callId))
      fail(
        "DUPLICATE_ID",
        `Provider tool call id is not unique: ${callId}`,
        this.#records,
      );
    this.#seenCalls.add(callId);
    this.#pendingCalls.add(callId);
    if (details !== undefined) this.#pendingCallDetails.set(callId, details);
  }

  /** False means Codex emitted a completion-only item, which is supported once. */
  #completeCall(callId: string, details?: string): boolean {
    if (this.#completedCalls.has(callId))
      fail(
        "DUPLICATE_ID",
        `Provider tool call completed more than once: ${callId}`,
        this.#records,
      );
    const pending = this.#pendingCalls.has(callId);
    if (!pending && this.#seenCalls.has(callId))
      fail(
        "INVALID_RECORD",
        `Provider tool result has no pending call: ${callId}`,
        this.#records,
      );
    if (
      pending &&
      details !== undefined &&
      this.#pendingCallDetails.get(callId) !== details
    )
      fail(
        "INVALID_RECORD",
        `Provider tool completion metadata changed: ${callId}`,
        this.#records,
      );
    this.#pendingCalls.delete(callId);
    this.#pendingCallDetails.delete(callId);
    this.#completedCalls.add(callId);
    return pending;
  }

  #rememberCompletionOnly(callId: string): void {
    this.#seenCalls.add(callId);
    this.#completedCalls.add(callId);
  }

  #snapshot(): NormalizerSnapshot {
    return {
      sessionId: this.#sessionId,
      initialized: this.#initialized,
      pendingCalls: [...this.#pendingCalls],
      seenCalls: [...this.#seenCalls],
      completedCalls: [...this.#completedCalls],
      pendingCallDetails: [...this.#pendingCallDetails],
      seenVisibleItems: [...this.#seenVisibleItems],
      seenRecordIds: [...this.#seenRecordIds],
      turnStarted: this.#turnStarted,
      terminalStatus: this.#terminalStatus,
    };
  }

  #restore(snapshot: NormalizerSnapshot): void {
    this.#sessionId = snapshot.sessionId;
    this.#initialized = snapshot.initialized;
    replaceSet(this.#pendingCalls, snapshot.pendingCalls);
    replaceSet(this.#seenCalls, snapshot.seenCalls);
    replaceSet(this.#completedCalls, snapshot.completedCalls);
    this.#pendingCallDetails.clear();
    for (const [key, value] of snapshot.pendingCallDetails)
      this.#pendingCallDetails.set(key, value);
    replaceSet(this.#seenVisibleItems, snapshot.seenVisibleItems);
    replaceSet(this.#seenRecordIds, snapshot.seenRecordIds);
    this.#turnStarted = snapshot.turnStarted;
    this.#terminalStatus = snapshot.terminalStatus;
  }
}

function unsafeUnsupported(message: string, line: number): never {
  fail("UNSUPPORTED_RECORD", message, line, { workspaceState: "unknown" });
}

function requiredStringValue(
  value: unknown,
  name: string,
  line: number,
): string {
  if (typeof value !== "string")
    fail("INVALID_RECORD", `${name} must be a string`, line);
  return value;
}

function requiredInteger(value: unknown, name: string, line: number): number {
  if (!Number.isSafeInteger(value))
    fail("INVALID_RECORD", `${name} must be an integer`, line);
  return value as number;
}

function requiredNonnegativeInteger(
  value: unknown,
  name: string,
  line: number,
): number {
  const parsed = requiredInteger(value, name, line);
  if (parsed < 0) fail("INVALID_RECORD", `${name} must be non-negative`, line);
  return parsed;
}

function replaceSet(target: Set<string>, values: readonly string[]): void {
  target.clear();
  for (const value of values) target.add(value);
}

function stableDetail(value: JsonValue): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function validateLifecycleStatus(
  detail: Readonly<Record<string, unknown>>,
  recordType: "item.started" | "item.completed",
  label: string,
  line: number,
): void {
  if (detail["status"] === undefined) return;
  const status = requiredString(detail["status"], `${label} status`, line);
  if (
    (recordType === "item.started" && status !== "in_progress") ||
    (recordType === "item.completed" &&
      status !== "completed" &&
      status !== "failed")
  ) {
    fail(
      "INVALID_RECORD",
      `${label} status does not match its lifecycle`,
      line,
    );
  }
}

function fileChanges(value: unknown, line: number): JsonValue[] {
  if (!Array.isArray(value))
    fail("INVALID_RECORD", "file changes must be an array", line);
  return value.map((candidate) => {
    if (!record(candidate))
      fail("INVALID_RECORD", "file change details must be objects", line);
    const keys = Object.keys(candidate).sort();
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "path")
      fail(
        "INVALID_RECORD",
        "file change details require only kind and path",
        line,
      );
    const path = requiredString(candidate["path"], "file change path", line);
    const kind = requiredString(candidate["kind"], "file change kind", line);
    if (kind !== "add" && kind !== "update" && kind !== "delete")
      fail("INVALID_RECORD", "file change kind is unsupported", line);
    return { path, kind };
  });
}

function timestamp(item: Readonly<Record<string, unknown>>): string {
  const value = item["timestamp"];
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string" || !isRfc3339Timestamp(value))
    fail("INVALID_RECORD", "Provider timestamp must be RFC 3339");
  return value;
}

function event(
  kind: EventKind,
  occurredAt: string,
  eventSummary: string,
  payload: JsonValue,
): StreamEvent {
  return Object.freeze({ kind, occurredAt, summary: eventSummary, payload });
}
