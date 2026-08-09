/** The schema version emitted by this release of the public protocol. */
export const PROTOCOL_SCHEMA_VERSION = 1 as const;

export type ProtocolSchemaVersion = typeof PROTOCOL_SCHEMA_VERSION;

declare const logicalSequenceBrand: unique symbol;

/** A finite, safe, integer 1-based logical session coordinate. */
export type LogicalSequence = number & {
  readonly [logicalSequenceBrand]: "LogicalSequence";
};

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * A portable payload whose data has been normalized and redacted before it
 * crosses the protocol boundary. Raw provider data is referenced separately.
 */
export interface SchemaVersionedEnvelope<
  Data extends JsonValue = JsonValue,
  Version extends number = ProtocolSchemaVersion,
> {
  readonly schemaVersion: Version;
  readonly data: Data;
}

export type CanonicalEnvelope<Data extends JsonValue = JsonValue> =
  SchemaVersionedEnvelope<Data, ProtocolSchemaVersion>;

/*
 * These exported records are transport contracts, not complete record parsers.
 * Importers and API handlers must validate every record field (including IDs,
 * timestamps, discriminants, and lineage) before constructing these types.
 */

/**
 * Metadata for optional raw data held outside canonical storage. The referenced
 * contents are not part of the public protocol and must remain encrypted.
 */
export interface RawEnvelopeReference {
  readonly schemaVersion: ProtocolSchemaVersion;
  readonly ref: string;
  readonly retention: "opt_in";
  readonly protection: "encrypted_restricted_store";
  readonly mediaType?: string;
  /** Schema/version reported by the source, when one exists. */
  readonly sourceSchemaVersion?: string;
}

export type BranchState = "preparing" | "ready" | "failed";

export interface Session {
  readonly id: string;
  /** Adapter-defined source label; it is not a provider resume identifier. */
  readonly source: string;
  readonly createdAt: string;
}

interface BranchRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly state: BranchState;
}

export interface RootBranch extends BranchRecord {
  readonly parentId?: never;
  readonly forkSeq?: never;
}

export interface ChildBranch extends BranchRecord {
  readonly parentId: string;
  /** 1-based logical session coordinate in the parent history. */
  readonly forkSeq: LogicalSequence;
}

/** Root lineage has neither fork field; child lineage always has both. */
export type Branch = RootBranch | ChildBranch;

export const EVENT_KINDS = [
  "instruction",
  "assistant_message",
  "tool_call",
  "tool_result",
  "filesystem_change",
  "checkpoint",
  "system",
  "error",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface Event<Payload extends JsonValue = JsonValue> {
  readonly id: string;
  readonly branchId: string;
  /** 1-based logical session coordinate, unique with branchId. */
  readonly seq: LogicalSequence;
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly summary: string;
  /** Normalized canonical data. Callers must redact it before persistence. */
  readonly payload: CanonicalEnvelope<Payload>;
  /** Present only when the user opted into separate encrypted raw retention. */
  readonly rawEnvelope?: RawEnvelopeReference;
}

export interface Checkpoint {
  readonly id: string;
  readonly branchId: string;
  /** The event whose post-event filesystem state this checkpoint captures. */
  readonly eventSeq: LogicalSequence;
  readonly manifestRef: string;
}

export interface ReplayItem<Payload extends JsonValue = JsonValue> {
  readonly eventId: string;
  /** Branch that owns the event; inherited context can span many branches. */
  readonly sourceBranchId: string;
  readonly seq: LogicalSequence;
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly summary: string;
  readonly payload: CanonicalEnvelope<Payload>;
}

export interface LaunchPlan {
  /** New isolated directory containing the verified reconstructed workspace. */
  readonly workspacePath: string;
  /** Canonical display/context records only; tool calls are never executed. */
  readonly context: readonly ReplayItem[];
  readonly instruction: string;
}

export type ReplayabilityUnavailableReason =
  "missing_canonical_data" | "required_data_redacted";

export type ReplayabilityStatus =
  | { readonly status: "replayable" }
  | {
      readonly status: "unavailable";
      readonly reason: ReplayabilityUnavailableReason;
      readonly detail?: string;
    };

export type BranchabilityUnavailableReason =
  | "no_checkpoint"
  | "missing_delta"
  | "invalid_manifest"
  | "excluded_path"
  | "unsupported_snapshot"
  | "branch_not_ready";

export interface ExactReconstruction {
  readonly kind: "exact";
  readonly checkpointId: string;
  readonly checkpointEventSeq: LogicalSequence;
  readonly effectiveRestoreSeq: LogicalSequence;
}

export interface DeltaReconstruction {
  readonly kind: "checkpoint_plus_deltas";
  readonly checkpointId: string;
  readonly checkpointEventSeq: LogicalSequence;
  /** Ordered 1-based event coordinates whose deltas reach the target. */
  readonly deltaEventSeqs: readonly LogicalSequence[];
  readonly effectiveRestoreSeq: LogicalSequence;
}

export type Reconstruction = ExactReconstruction | DeltaReconstruction;

export type BranchabilityStatus =
  | {
      readonly status: "branchable";
      readonly reconstruction: Reconstruction;
    }
  | {
      readonly status: "unavailable";
      readonly reason: BranchabilityUnavailableReason;
      readonly detail?: string;
    };

export interface EventCapabilities {
  readonly eventId: string;
  readonly replayability: ReplayabilityStatus;
  readonly branchability: BranchabilityStatus;
}

/*
 * The API contract. These shapes cross a network boundary, so they are part
 * of the versioned protocol rather than an implementation detail of the
 * server: the CLI and the UI decode exactly what the server encodes.
 */

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "conflict"
  | "internal";

/** The single error shape every failing request returns. */
export interface ApiErrorBody {
  readonly schemaVersion: ProtocolSchemaVersion;
  readonly error: {
    readonly code: ApiErrorCode;
    /** Safe to show a user; it never contains a token or a filesystem path. */
    readonly message: string;
  };
}

/** Everything a client needs to know it is talking to a server it supports. */
export interface ServerInfo {
  readonly schemaVersion: ProtocolSchemaVersion;
  readonly name: "chronos";
  readonly protocolVersion: ProtocolSchemaVersion;
  /** Loopback only, unless a future build adds explicit TLS configuration. */
  readonly bind: string;
}

/** True only for finite, integer, 1-based logical sequence coordinates. */
export function isLogicalSequence(value: unknown): value is LogicalSequence {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Validate and brand a logical coordinate at an import/API boundary. */
export function logicalSequence(value: unknown): LogicalSequence {
  if (!isLogicalSequence(value)) {
    throw new RangeError(
      "Logical sequence must be a safe integer starting at 1",
    );
  }

  return value;
}

/**
 * True for an RFC 3339 timestamp with `Z` or a numeric UTC offset. Every
 * record timestamp that crosses the protocol boundary is validated with this.
 */
export function isRfc3339Timestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > new Date(Date.UTC(y, m, 0)).getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** JSON-compatible data excludes class instances, sparse arrays, and cycles. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return isJsonValueInternal(value, new Set<object>());
  } catch {
    return false;
  }
}

function isJsonValueInternal(
  value: unknown,
  ancestors: Set<object>,
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      ancestors.delete(value);
      return false;
    }

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !isJsonValueInternal(descriptor.value, ancestors)
      ) {
        ancestors.delete(value);
        return false;
      }
    }

    ancestors.delete(value);
    return true;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      ancestors.delete(value);
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !isJsonValueInternal(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }

  ancestors.delete(value);
  return true;
}

export function isCanonicalEnvelope(
  value: unknown,
): value is CanonicalEnvelope {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes("schemaVersion") ||
      !keys.includes("data")
    ) {
      return false;
    }

    const version = Object.getOwnPropertyDescriptor(value, "schemaVersion");
    const data = Object.getOwnPropertyDescriptor(value, "data");
    return (
      version !== undefined &&
      "value" in version &&
      version.enumerable === true &&
      version.value === PROTOCOL_SCHEMA_VERSION &&
      data !== undefined &&
      "value" in data &&
      data.enumerable === true &&
      isJsonValue(data.value)
    );
  } catch {
    return false;
  }
}

export function canonicalEnvelope<Data extends JsonValue>(
  data: Data,
): CanonicalEnvelope<Data> {
  if (!isJsonValue(data)) {
    throw new TypeError("Canonical envelope data must be a JSON value");
  }

  return { schemaVersion: PROTOCOL_SCHEMA_VERSION, data };
}
