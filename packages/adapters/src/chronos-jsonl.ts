import {
  EVENT_KINDS,
  PROTOCOL_SCHEMA_VERSION,
  canonicalEnvelope,
  isJsonValue,
  isLogicalSequence,
  isRfc3339Timestamp,
  type Branch,
  type Checkpoint,
  type Event,
  type EventKind,
  type LogicalSequence,
  type Session,
} from "@chronos/protocol";

import type {
  ImportDiagnostic,
  ImportOptions,
  ImportedSession,
  SessionAdapter,
} from "./adapter.js";
import { fail } from "./errors.js";

export const CHRONOS_JSONL_ADAPTER_ID = "chronos-jsonl";

/** The Chronos JSONL schema version this build reads and writes. */
export const CHRONOS_JSONL_SCHEMA_VERSION = 1;

const DEFAULT_MAX_LINE_LENGTH = 1_048_576;
const DEFAULT_MAX_RECORDS = 200_000;

const SESSION_KEYS = ["type", "schemaVersion", "id", "source", "createdAt"];
const BRANCH_KEYS = ["type", "schemaVersion", "id", "parentId", "forkSeq"];
const EVENT_KEYS = [
  "type",
  "schemaVersion",
  "id",
  "branchId",
  "seq",
  "kind",
  "occurredAt",
  "summary",
  "payload",
  "raw",
];
const CHECKPOINT_KEYS = [
  "type",
  "schemaVersion",
  "id",
  "branchId",
  "eventSeq",
  "manifestRef",
];
const RAW_KEYS = ["ref", "mediaType", "sourceSchemaVersion"];

type JsonRecord = Readonly<Record<string, unknown>>;

interface BranchDraft {
  readonly branch: Branch;
  readonly line: number;
  nextSeq: number;
  maxVisibleSeq: number;
}

/**
 * Parse a Chronos JSONL file into canonical records. The whole file is
 * validated before anything is returned: a malformed record fails the import
 * instead of producing a transcript that only looks complete.
 *
 * See `docs/formats/chronos-jsonl.md`.
 */
export function parseChronosJsonl(
  input: string,
  options: ImportOptions = {},
): ImportedSession {
  if (typeof input !== "string") {
    fail("INVALID_INPUT", "Chronos JSONL input must be a string");
  }
  const retainRaw = options.retainRaw ?? false;
  const maxLineLength = positiveLimit(
    options.limits?.maxLineLength,
    DEFAULT_MAX_LINE_LENGTH,
    "maxLineLength",
  );
  const maxRecords = positiveLimit(
    options.limits?.maxRecords,
    DEFAULT_MAX_RECORDS,
    "maxRecords",
  );

  const diagnostics: ImportDiagnostic[] = [];
  const branches = new Map<string, BranchDraft>();
  const events: Event[] = [];
  const eventIds = new Set<string>();
  const ownedSequences = new Set<string>();
  const checkpoints: Checkpoint[] = [];
  const checkpointIds = new Set<string>();
  let session: Session | undefined;
  let rootBranchId: string | undefined;
  let records = 0;

  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    if (line.trim().length === 0) continue;
    if (line.length > maxLineLength) {
      fail("LIMIT_EXCEEDED", "Line exceeds the configured limit", lineNumber, {
        maxLineLength,
      });
    }
    records += 1;
    if (records > maxRecords) {
      fail("LIMIT_EXCEEDED", "Too many records", lineNumber, { maxRecords });
    }

    const record = parseRecord(line, lineNumber);
    const type = requiredString(record, "type", lineNumber);
    if (record["schemaVersion"] !== CHRONOS_JSONL_SCHEMA_VERSION) {
      fail(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Expected schemaVersion ${String(CHRONOS_JSONL_SCHEMA_VERSION)}`,
        lineNumber,
      );
    }
    if (type === "session") {
      if (session !== undefined) {
        fail("DUPLICATE_SESSION", "A file declares one session", lineNumber);
      }
      assertKeys(record, SESSION_KEYS, lineNumber, "Session");
      session = Object.freeze({
        id: requiredString(record, "id", lineNumber),
        source: requiredString(record, "source", lineNumber),
        createdAt: requiredTimestamp(record, "createdAt", lineNumber),
      });
      continue;
    }
    if (session === undefined) {
      fail(
        "MISSING_SESSION",
        "A Chronos JSONL file starts with its session record",
        lineNumber,
      );
    }

    switch (type) {
      case "branch": {
        assertKeys(record, BRANCH_KEYS, lineNumber, "Branch");
        const id = requiredString(record, "id", lineNumber);
        if (branches.has(id)) {
          fail("DUPLICATE_ID", `Duplicate branch id: ${id}`, lineNumber);
        }
        const hasParent = record["parentId"] !== undefined;
        if (hasParent !== (record["forkSeq"] !== undefined)) {
          fail(
            "INVALID_RECORD",
            "A child branch declares both parentId and forkSeq",
            lineNumber,
          );
        }
        if (!hasParent) {
          if (rootBranchId !== undefined) {
            fail(
              "MULTIPLE_ROOTS",
              "A file declares one root branch",
              lineNumber,
            );
          }
          rootBranchId = id;
          branches.set(id, {
            branch: Object.freeze({
              id,
              sessionId: session.id,
              state: "ready",
            }),
            line: lineNumber,
            nextSeq: 1,
            maxVisibleSeq: 0,
          });
          break;
        }
        const parentId = requiredString(record, "parentId", lineNumber);
        const parent = branches.get(parentId);
        if (parent === undefined) {
          fail(
            "UNKNOWN_BRANCH",
            `A branch forks from an undeclared parent: ${parentId}`,
            lineNumber,
          );
        }
        const forkSeq = requiredSequence(record, "forkSeq", lineNumber);
        branches.set(id, {
          branch: Object.freeze({
            id,
            sessionId: session.id,
            parentId,
            forkSeq,
            state: "ready",
          }),
          line: lineNumber,
          nextSeq: forkSeq + 1,
          maxVisibleSeq: forkSeq,
        });
        break;
      }
      case "event": {
        assertKeys(record, EVENT_KEYS, lineNumber, "Event");
        const id = requiredString(record, "id", lineNumber);
        if (eventIds.has(id)) {
          fail("DUPLICATE_ID", `Duplicate event id: ${id}`, lineNumber);
        }
        const branchId = requiredString(record, "branchId", lineNumber);
        const draft = branches.get(branchId);
        if (draft === undefined) {
          fail(
            "UNKNOWN_BRANCH",
            `An event names an undeclared branch: ${branchId}`,
            lineNumber,
          );
        }
        const seq = requiredSequence(record, "seq", lineNumber);
        if (seq !== draft.nextSeq) {
          fail(
            "NON_CONTIGUOUS_EVENT",
            `Expected seq ${String(draft.nextSeq)} on branch ${branchId}`,
            lineNumber,
            { expected: draft.nextSeq, found: seq },
          );
        }
        const summary = record["summary"];
        if (typeof summary !== "string") {
          fail("INVALID_RECORD", "Event summary must be a string", lineNumber);
        }
        if (summary.trim().length === 0) {
          diagnostics.push(
            Object.freeze({
              code: "empty_summary",
              message: `Event ${id} has no summary to display`,
              line: lineNumber,
            }),
          );
        }
        const payload = record["payload"];
        if (!isJsonValue(payload)) {
          fail(
            "INVALID_RECORD",
            "Event payload must be a JSON value",
            lineNumber,
          );
        }
        const base = {
          id,
          branchId,
          seq,
          kind: requiredKind(record, lineNumber),
          occurredAt: requiredTimestamp(record, "occurredAt", lineNumber),
          summary,
          payload: canonicalEnvelope(payload),
        };
        const raw = record["raw"];
        if (raw === undefined) {
          events.push(Object.freeze(base));
        } else if (retainRaw) {
          events.push(
            Object.freeze({
              ...base,
              rawEnvelope: rawEnvelope(raw, lineNumber),
            }),
          );
        } else {
          // Validate before dropping so an opt-in import cannot fail later.
          rawEnvelope(raw, lineNumber);
          events.push(Object.freeze(base));
          diagnostics.push(
            Object.freeze({
              code: "raw_envelope_dropped",
              message: `Raw data for event ${id} was dropped; raw retention is opt-in`,
              line: lineNumber,
            }),
          );
        }
        eventIds.add(id);
        ownedSequences.add(`${branchId}:${String(seq)}`);
        draft.nextSeq = seq + 1;
        draft.maxVisibleSeq = seq;
        break;
      }
      case "checkpoint": {
        assertKeys(record, CHECKPOINT_KEYS, lineNumber, "Checkpoint");
        const id = requiredString(record, "id", lineNumber);
        if (checkpointIds.has(id)) {
          fail("DUPLICATE_ID", `Duplicate checkpoint id: ${id}`, lineNumber);
        }
        const branchId = requiredString(record, "branchId", lineNumber);
        const eventSeq = requiredSequence(record, "eventSeq", lineNumber);
        if (!ownedSequences.has(`${branchId}:${String(eventSeq)}`)) {
          fail(
            "UNKNOWN_EVENT",
            "A checkpoint is declared after the event it captures",
            lineNumber,
          );
        }
        checkpointIds.add(id);
        checkpoints.push(
          Object.freeze({
            id,
            branchId,
            eventSeq,
            manifestRef: requiredString(record, "manifestRef", lineNumber),
          }),
        );
        break;
      }
      default:
        fail("UNKNOWN_RECORD_TYPE", `Unknown record type: ${type}`, lineNumber);
    }
  }

  if (session === undefined) {
    fail("MISSING_SESSION", "The file declares no session");
  }
  if (rootBranchId === undefined) {
    fail("MISSING_ROOT", "The file declares no root branch");
  }
  assertForkPoints(branches);
  if (checkpoints.length === 0) {
    diagnostics.push(
      Object.freeze({
        code: "no_checkpoints",
        message:
          "No checkpoints were imported, so no event can reconstruct a workspace",
      }),
    );
  }

  return Object.freeze({
    session,
    branches: Object.freeze([...branches.values()].map((it) => it.branch)),
    events: Object.freeze(events),
    checkpoints: Object.freeze(checkpoints),
    diagnostics: Object.freeze(diagnostics),
  });
}

export const chronosJsonlAdapter: SessionAdapter = Object.freeze({
  id: CHRONOS_JSONL_ADAPTER_ID,
  displayName: "Chronos JSONL",
  formatVersion: CHRONOS_JSONL_SCHEMA_VERSION,
  documentation: "docs/formats/chronos-jsonl.md",
  parse: parseChronosJsonl,
});

/**
 * A fork must land on a coordinate the parent can actually show. Parents are
 * declared before their children, so one pass in declaration order settles it.
 */
function assertForkPoints(branches: ReadonlyMap<string, BranchDraft>): void {
  for (const draft of branches.values()) {
    const branch = draft.branch;
    if (!Object.hasOwn(branch, "parentId")) continue;
    const child = branch as Extract<Branch, { parentId: string }>;
    const parent = branches.get(child.parentId)!;
    if (child.forkSeq > parent.maxVisibleSeq) {
      fail(
        "INVALID_FORK",
        `Branch ${branch.id} forks from a sequence its parent never reached`,
        draft.line,
        { forkSeq: child.forkSeq, parentMaxSeq: parent.maxVisibleSeq },
      );
    }
  }
}

function parseRecord(line: string, lineNumber: number): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    fail("MALFORMED_LINE", "Line is not valid JSON", lineNumber);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("MALFORMED_LINE", "Each line must be a JSON object", lineNumber);
  }
  return parsed as JsonRecord;
}

function assertKeys(
  record: JsonRecord,
  allowed: readonly string[],
  line: number,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail("INVALID_RECORD", `${label} has an unknown field: ${key}`, line);
    }
  }
}

function rawEnvelope(
  value: unknown,
  line: number,
): NonNullable<Event["rawEnvelope"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RECORD", "raw must be an object", line);
  }
  const record = value as JsonRecord;
  assertKeys(record, RAW_KEYS, line, "Raw reference");
  const mediaType = record["mediaType"];
  const sourceSchemaVersion = record["sourceSchemaVersion"];
  if (mediaType !== undefined && typeof mediaType !== "string") {
    fail("INVALID_RECORD", "raw.mediaType must be a string", line);
  }
  if (
    sourceSchemaVersion !== undefined &&
    typeof sourceSchemaVersion !== "string"
  ) {
    fail("INVALID_RECORD", "raw.sourceSchemaVersion must be a string", line);
  }
  return Object.freeze({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    ref: requiredString(record, "ref", line),
    retention: "opt_in" as const,
    protection: "encrypted_restricted_store" as const,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sourceSchemaVersion === undefined ? {} : { sourceSchemaVersion }),
  });
}

function requiredString(record: JsonRecord, key: string, line: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_RECORD", `${key} must be a non-empty string`, line);
  }
  return value;
}

function requiredTimestamp(
  record: JsonRecord,
  key: string,
  line: number,
): string {
  const value = requiredString(record, key, line);
  if (!isRfc3339Timestamp(value)) {
    fail("INVALID_RECORD", `${key} must be an RFC 3339 timestamp`, line);
  }
  return value;
}

function requiredSequence(
  record: JsonRecord,
  key: string,
  line: number,
): LogicalSequence {
  const value = record[key];
  if (!isLogicalSequence(value)) {
    fail("INVALID_RECORD", `${key} must be a 1-based integer`, line);
  }
  return value;
}

function requiredKind(record: JsonRecord, line: number): EventKind {
  const value = record["kind"];
  const kind = EVENT_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    fail("INVALID_RECORD", `Unknown event kind: ${String(value)}`, line);
  }
  return kind;
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_OPTIONS", `${label} must be a positive integer`);
  }
  return value;
}
