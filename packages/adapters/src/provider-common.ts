import type { EventKind, JsonValue } from "@chronos/protocol";

import type {
  ImportDiagnostic,
  ImportOptions,
  ImportedSession,
} from "./adapter.js";
import { parseChronosJsonl } from "./chronos-jsonl.js";
import { fail } from "./errors.js";

export type JsonRecord = Readonly<Record<string, unknown>>;

export interface ProviderEvent {
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly line: number;
}

export const DEFAULT_PROVIDER_MAX_INPUT_LENGTH = 67_108_864;

export function sourceLines(
  input: string,
  options: ImportOptions,
): readonly { record: JsonRecord; line: number }[] {
  if (typeof input !== "string")
    fail("INVALID_INPUT", "Provider JSONL input must be a string");
  if (options.retainRaw === true) {
    fail(
      "INVALID_OPTIONS",
      "Raw retention is unavailable in Chronos v0.1; an encrypted raw store is not implemented",
    );
  }
  const maxInputLength = limit(
    options.limits?.maxInputLength,
    DEFAULT_PROVIDER_MAX_INPUT_LENGTH,
    "maxInputLength",
  );
  if (input.length > maxInputLength)
    fail("LIMIT_EXCEEDED", "Input exceeds the configured limit", undefined, {
      maxInputLength,
    });
  const maxLineLength = limit(
    options.limits?.maxLineLength,
    1_048_576,
    "maxLineLength",
  );
  const maxRecords = limit(options.limits?.maxRecords, 200_000, "maxRecords");
  const result: { record: JsonRecord; line: number }[] = [];
  for (const [index, text] of input.split(/\r?\n/).entries()) {
    if (text.trim().length === 0) continue;
    const line = index + 1;
    if (text.length > maxLineLength)
      fail("LIMIT_EXCEEDED", "Line exceeds the configured limit", line, {
        maxLineLength,
      });
    if (result.length >= maxRecords)
      fail("LIMIT_EXCEEDED", "Too many records", line, { maxRecords });
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      fail("MALFORMED_LINE", "Line is not valid JSON", line);
    }
    if (!record(value))
      fail("MALFORMED_LINE", "Each line must be a JSON object", line);
    result.push({ record: value, line });
  }
  return result;
}

export function canonicalImport(
  source: string,
  sessionId: string,
  createdAt: string,
  events: readonly ProviderEvent[],
  diagnostics: readonly ImportDiagnostic[],
  options: ImportOptions,
): ImportedSession {
  const branchId = `${source}:${sessionId}:root`;
  const lines = [
    JSON.stringify({
      type: "session",
      schemaVersion: 1,
      id: sessionId,
      source,
      createdAt,
    }),
    JSON.stringify({ type: "branch", schemaVersion: 1, id: branchId }),
    ...events.map((event, index) =>
      JSON.stringify({
        type: "event",
        schemaVersion: 1,
        id: `${source}:${sessionId}:${String(event.line)}:${String(index + 1)}`,
        branchId,
        seq: index + 1,
        kind: event.kind,
        occurredAt: event.occurredAt,
        summary: event.summary,
        payload: event.payload,
      }),
    ),
  ];
  const imported = parseChronosJsonl(lines.join("\n"), {
    ...options,
    retainRaw: false,
  });
  return Object.freeze({
    ...imported,
    diagnostics: Object.freeze([...diagnostics, ...imported.diagnostics]),
  });
}

export function requiredString(
  value: unknown,
  name: string,
  line: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail("INVALID_RECORD", `${name} must be a non-empty string`, line);
  return value;
}

export function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function json(value: unknown, line: number, name: string): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    fail("INVALID_RECORD", `${name} must be JSON`, line);
  }
}

export function summary(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
}

function limit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    fail("INVALID_OPTIONS", `${name} must be a positive integer`);
  return value;
}
