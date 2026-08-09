import {
  EVENT_KINDS,
  PROTOCOL_SCHEMA_VERSION,
  isCanonicalEnvelope,
  isLogicalSequence,
  type Branch,
  type Checkpoint,
  type Event,
  type EventKind,
  type JsonValue,
  type LogicalSequence,
  type Session,
} from "@chronos/protocol";
import type { SQLOutputValue } from "node:sqlite";

import { fail, type StorageErrorCode } from "./errors.js";

export type Row = Record<string, SQLOutputValue>;

/**
 * A transport projection for paging a timeline. It carries everything the UI
 * needs to draw a row and nothing that could be large: payloads and raw
 * envelopes are fetched only when a user opens an event.
 */
export interface EventSummary {
  readonly id: string;
  readonly branchId: string;
  readonly seq: LogicalSequence;
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly summary: string;
  readonly hasRawEnvelope: boolean;
}

/*
 * Storage validates the shape it is asked to persist and the shape it reads
 * back; `@chronos/core` owns the domain rules that span records. A write
 * rejection is INVALID_RECORD (the caller passed something unusable); a read
 * rejection is CORRUPT_RECORD (the database no longer matches the contract).
 */

export function branchColumns(
  branch: Branch,
  code: StorageErrorCode = "INVALID_RECORD",
): Readonly<{
  id: string;
  sessionId: string;
  parentId: string | null;
  forkSeq: number | null;
  state: string;
}> {
  const id = text(branch.id, "branch id", code);
  const sessionId = text(branch.sessionId, "branch sessionId", code);
  const state = branch.state;
  if (state !== "preparing" && state !== "ready" && state !== "failed") {
    fail(code, "Branch state is invalid");
  }
  const isChild = Object.hasOwn(branch, "parentId");
  if (isChild !== Object.hasOwn(branch, "forkSeq")) {
    fail(code, "A child branch needs both parentId and forkSeq");
  }
  if (!isChild) {
    return Object.freeze({
      id,
      sessionId,
      parentId: null,
      forkSeq: null,
      state,
    });
  }
  const child = branch as Extract<Branch, { parentId: string }>;
  const forkSeq = child.forkSeq;
  if (!isLogicalSequence(forkSeq)) fail(code, "Branch forkSeq is invalid");
  return Object.freeze({
    id,
    sessionId,
    parentId: text(child.parentId, "branch parentId", code),
    forkSeq,
    state,
  });
}

export function eventColumns(
  event: Event,
  code: StorageErrorCode = "INVALID_RECORD",
): Readonly<{
  id: string;
  branchId: string;
  seq: number;
  kind: string;
  occurredAt: string;
  summary: string;
  payloadSchemaVersion: number;
  payloadJson: string;
  rawSchemaVersion: number | null;
  rawRef: string | null;
  rawMediaType: string | null;
  rawSourceSchemaVersion: string | null;
}> {
  const id = text(event.id, "event id", code);
  const branchId = text(event.branchId, "event branchId", code);
  const seq = event.seq;
  if (!isLogicalSequence(seq)) fail(code, "Event seq is invalid");
  const kind = EVENT_KINDS.find((candidate) => candidate === event.kind);
  if (kind === undefined) fail(code, "Event kind is invalid");
  if (typeof event.summary !== "string") {
    fail(code, "Event summary must be a string");
  }
  if (!isCanonicalEnvelope(event.payload)) {
    fail(code, "Event payload must be a canonical envelope");
  }
  const raw = event.rawEnvelope;
  if (raw !== undefined && raw.schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
    fail(code, "Raw envelope schema version is unsupported");
  }
  return Object.freeze({
    id,
    branchId,
    seq,
    kind,
    occurredAt: text(event.occurredAt, "event occurredAt", code),
    summary: event.summary,
    payloadSchemaVersion: event.payload.schemaVersion,
    payloadJson: JSON.stringify(event.payload.data),
    rawSchemaVersion: raw === undefined ? null : raw.schemaVersion,
    rawRef: raw === undefined ? null : text(raw.ref, "raw envelope ref", code),
    rawMediaType: raw?.mediaType ?? null,
    rawSourceSchemaVersion: raw?.sourceSchemaVersion ?? null,
  });
}

export function toSession(row: Row): Session {
  return Object.freeze({
    id: readText(row, "id"),
    source: readText(row, "source"),
    createdAt: readText(row, "created_at"),
  });
}

export function toBranch(row: Row): Branch {
  const id = readText(row, "id");
  const sessionId = readText(row, "session_id");
  const state = readText(row, "state");
  if (state !== "preparing" && state !== "ready" && state !== "failed") {
    fail("CORRUPT_RECORD", "Stored branch state is invalid", { branchId: id });
  }
  const parentId = row["parent_id"];
  const forkSeq = row["fork_seq"];
  if (parentId === null && forkSeq === null) {
    return Object.freeze({ id, sessionId, state });
  }
  if (typeof parentId !== "string" || !isLogicalSequence(forkSeq)) {
    fail("CORRUPT_RECORD", "Stored branch lineage is invalid", {
      branchId: id,
    });
  }
  return Object.freeze({ id, sessionId, state, parentId, forkSeq });
}

export function toEvent(row: Row): Event {
  const summary = toEventSummary(row);
  const payload = {
    schemaVersion: readInteger(row, "payload_schema_version"),
    data: parseJson(readText(row, "payload_json"), summary.id),
  };
  if (!isCanonicalEnvelope(payload)) {
    fail("CORRUPT_RECORD", "Stored payload is not a canonical envelope", {
      eventId: summary.id,
    });
  }
  const base = {
    id: summary.id,
    branchId: summary.branchId,
    seq: summary.seq,
    kind: summary.kind,
    occurredAt: summary.occurredAt,
    summary: summary.summary,
    payload,
  };
  if (!summary.hasRawEnvelope) return Object.freeze(base);
  const mediaType = row["raw_media_type"];
  const sourceSchemaVersion = row["raw_source_schema_version"];
  const rawSchemaVersion = readInteger(row, "raw_schema_version");
  if (rawSchemaVersion !== PROTOCOL_SCHEMA_VERSION) {
    fail("CORRUPT_RECORD", "Stored raw envelope version is unsupported", {
      eventId: summary.id,
    });
  }
  return Object.freeze({
    ...base,
    rawEnvelope: Object.freeze({
      schemaVersion: rawSchemaVersion,
      ref: readText(row, "raw_ref"),
      retention: "opt_in" as const,
      protection: "encrypted_restricted_store" as const,
      ...(typeof mediaType === "string" ? { mediaType } : {}),
      ...(typeof sourceSchemaVersion === "string"
        ? { sourceSchemaVersion }
        : {}),
    }),
  });
}

export function toEventSummary(row: Row): EventSummary {
  const id = readText(row, "id");
  const seq = row["seq"];
  if (!isLogicalSequence(seq)) {
    fail("CORRUPT_RECORD", "Stored event sequence is invalid", { eventId: id });
  }
  const kindValue = readText(row, "kind");
  const kind = EVENT_KINDS.find((candidate) => candidate === kindValue);
  if (kind === undefined) {
    fail("CORRUPT_RECORD", "Stored event kind is unknown", { eventId: id });
  }
  return Object.freeze({
    id,
    branchId: readText(row, "branch_id"),
    seq,
    kind,
    occurredAt: readText(row, "occurred_at"),
    summary: readText(row, "summary"),
    hasRawEnvelope: row["raw_ref"] !== null && row["raw_ref"] !== undefined,
  });
}

export function toCheckpoint(row: Row): Checkpoint {
  const id = readText(row, "id");
  const eventSeq = row["event_seq"];
  if (!isLogicalSequence(eventSeq)) {
    fail("CORRUPT_RECORD", "Stored checkpoint sequence is invalid", {
      checkpointId: id,
    });
  }
  return Object.freeze({
    id,
    branchId: readText(row, "branch_id"),
    eventSeq,
    manifestRef: readText(row, "manifest_ref"),
  });
}

export function text(
  value: unknown,
  label: string,
  code: StorageErrorCode,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `${label} must be a non-empty string`);
  }
  return value;
}

function readText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    fail("CORRUPT_RECORD", `Stored column is not text: ${column}`);
  }
  return value;
}

function readInteger(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("CORRUPT_RECORD", `Stored column is not an integer: ${column}`);
  }
  return value;
}

function parseJson(value: string, eventId: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    fail(
      "CORRUPT_RECORD",
      "Stored payload is not valid JSON",
      { eventId },
      { cause: error },
    );
  }
}
