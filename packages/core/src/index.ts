import {
  EVENT_KINDS,
  PROTOCOL_SCHEMA_VERSION,
  isCanonicalEnvelope,
  isLogicalSequence,
  isRfc3339Timestamp,
  type Branch,
  type BranchabilityUnavailableReason,
  type Checkpoint,
  type ChildBranch,
  type Event,
  type EventCapabilities,
  type JsonValue,
  type LogicalSequence,
  type Reconstruction,
  type ReplayItem,
  type Session,
} from "@chronos/protocol";

export type CoreErrorCode =
  | "INVALID_SESSION"
  | "INVALID_BRANCH"
  | "DUPLICATE_BRANCH"
  | "MULTIPLE_ROOTS"
  | "MISSING_ROOT"
  | "MISSING_PARENT"
  | "BRANCH_CYCLE"
  | "INVALID_FORK"
  | "INVALID_EVENT"
  | "DUPLICATE_EVENT"
  | "NON_MONOTONIC_EVENT"
  | "NON_CONTIGUOUS_EVENT"
  | "INVALID_CHECKPOINT"
  | "DUPLICATE_CHECKPOINT"
  | "UNKNOWN_BRANCH"
  | "UNKNOWN_EVENT"
  | "INVALID_TARGET"
  | "DUPLICATE_NEW_BRANCH"
  | "INVALID_INSTRUCTION"
  | "INVALID_EVIDENCE"
  | "NOT_BRANCHABLE";

export class CoreDomainError extends Error {
  readonly code: CoreErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: CoreErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "CoreDomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface SessionGraphInput {
  readonly session: Session;
  readonly branches: readonly Branch[];
  /** Import/append order is significant and must already be monotonic per owner. */
  readonly events: readonly Event[];
  readonly checkpoints?: readonly Checkpoint[];
}

interface IndexedBranch {
  readonly branch: Branch;
  readonly ownedEvents: readonly Event[];
  readonly maxVisibleSequence: number;
}

const sessionIndexToken = Symbol("SessionIndex");

/** Opaque validated snapshot. Its input records are cloned and deeply frozen. */
export class SessionIndex {
  readonly session: Session;
  readonly rootBranchId: string;
  #branches: ReadonlyMap<string, IndexedBranch>;
  #eventsById: ReadonlyMap<string, Event>;
  #checkpoints: readonly Checkpoint[];

  /** @internal Construct through indexSession. */
  constructor(
    token: typeof sessionIndexToken,
    session: Session,
    rootBranchId: string,
    branches: ReadonlyMap<string, IndexedBranch>,
    eventsById: ReadonlyMap<string, Event>,
    checkpoints: readonly Checkpoint[],
  ) {
    if (token !== sessionIndexToken) {
      fail("INVALID_SESSION", "SessionIndex must be created by indexSession");
    }
    this.session = session;
    this.rootBranchId = rootBranchId;
    this.#branches = branches;
    this.#eventsById = eventsById;
    this.#checkpoints = checkpoints;
    Object.freeze(this);
  }

  /** @internal */
  _branch(id: string): IndexedBranch | undefined {
    return this.#branches.get(id);
  }

  /** @internal */
  _event(id: string): Event | undefined {
    return this.#eventsById.get(id);
  }

  /** @internal */
  _checkpoints(): readonly Checkpoint[] {
    return this.#checkpoints;
  }
}

export function indexSession(input: SessionGraphInput): SessionIndex {
  const inputRecord = exactRecord(
    input,
    ["session", "branches", "events", "checkpoints"],
    "INVALID_SESSION",
    "Session graph",
  );
  const session = projectSession(inputRecord.session);
  const branchValues = safeArray(
    inputRecord.branches,
    "INVALID_SESSION",
    "Session branches",
  );
  const eventValues = safeArray(
    inputRecord.events,
    "INVALID_SESSION",
    "Session events",
  );
  const checkpointValues = Object.hasOwn(inputRecord, "checkpoints")
    ? safeArray(
        inputRecord.checkpoints,
        "INVALID_SESSION",
        "Session checkpoints",
      )
    : [];
  const branches = new Map<string, Branch>();

  for (const value of branchValues) {
    const candidate = projectBranch(value);
    if (branches.has(candidate.id)) {
      fail("DUPLICATE_BRANCH", `Duplicate branch id: ${candidate.id}`, {
        branchId: candidate.id,
      });
    }
    branches.set(candidate.id, candidate);
  }

  const roots = [...branches.values()].filter((branch) => !isChild(branch));
  if (roots.length === 0)
    fail("MISSING_ROOT", "A session requires one root branch");
  if (roots.length !== 1) {
    fail("MULTIPLE_ROOTS", "A session must have exactly one root branch", {
      count: roots.length,
    });
  }

  for (const branch of branches.values()) {
    if (branch.sessionId !== session.id) {
      fail("INVALID_BRANCH", "Branch belongs to a different indexed session", {
        branchId: branch.id,
      });
    }
    if (isChild(branch)) {
      const parent = branches.get(branch.parentId);
      if (parent === undefined) {
        fail("MISSING_PARENT", `Missing parent branch: ${branch.parentId}`, {
          branchId: branch.id,
        });
      }
      if (parent.state !== "ready") {
        fail("INVALID_BRANCH", "Only a ready branch may be a parent", {
          branchId: branch.id,
          parentId: parent.id,
        });
      }
    }
  }
  assertAcyclic(branches);

  const owned = indexOwnedEvents(eventValues, branches);
  const ownedSequences = new Map<string, ReadonlySet<LogicalSequence>>();
  for (const [branchId, events] of owned) {
    ownedSequences.set(branchId, new Set(events.map((event) => event.seq)));
  }
  const resolved = new Map<string, IndexedBranch>();
  for (const startId of branches.keys()) {
    if (resolved.has(startId)) continue;
    const pending: Branch[] = [];
    let cursor = branches.get(startId)!;
    while (!resolved.has(cursor.id)) {
      pending.push(cursor);
      if (!isChild(cursor)) break;
      cursor = branches.get(cursor.parentId)!;
    }
    while (pending.length > 0) {
      const branch = pending.pop()!;
      const local = owned.get(branch.id) ?? [];
      let maxVisibleSequence: number;
      if (isChild(branch)) {
        const parent = resolved.get(branch.parentId)!;
        if (branch.forkSeq > parent.maxVisibleSequence) {
          fail("INVALID_FORK", "Fork must identify a visible parent event", {
            branchId: branch.id,
            forkSeq: branch.forkSeq,
          });
        }
        assertContiguous(local, branch.forkSeq + 1, branch.id);
        maxVisibleSequence = local.at(-1)?.seq ?? branch.forkSeq;
      } else {
        assertContiguous(local, 1, branch.id);
        maxVisibleSequence = local.at(-1)?.seq ?? 0;
      }
      resolved.set(
        branch.id,
        Object.freeze({
          branch,
          ownedEvents: local,
          maxVisibleSequence,
        }),
      );
    }
  }

  const eventsById = new Map<string, Event>();
  for (const events of owned.values()) {
    for (const event of events) eventsById.set(event.id, event);
  }
  const checkpoints = indexCheckpoints(
    checkpointValues,
    resolved,
    ownedSequences,
  );
  return new SessionIndex(
    sessionIndexToken,
    session,
    roots[0]!.id,
    resolved,
    eventsById,
    checkpoints,
  );
}

/** Resolve the effective, ordered transcript for a branch through a target. */
export function resolveVisibleEvents(
  index: SessionIndex,
  branchId: string,
  through?: LogicalSequence,
): readonly Event[] {
  const branch = requireBranch(index, branchId);
  const target = through ?? branch.maxVisibleSequence;
  if (through !== undefined) requireTarget(index, branch, through);
  if (target === 0) return Object.freeze([]);
  const segments: (readonly Event[])[] = [];
  let cursor = branch;
  let cutoff = target;
  while (true) {
    segments.push(cursor.ownedEvents.filter((event) => event.seq <= cutoff));
    if (!isChild(cursor.branch)) break;
    cutoff = Math.min(cutoff, cursor.branch.forkSeq);
    cursor = requireBranch(index, cursor.branch.parentId);
  }
  let visibleLength = 0;
  for (const segment of segments) visibleLength += segment.length;
  const visible = new Array<Event>(visibleLength);
  let writeIndex = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    for (const event of segments[index]!) {
      visible[writeIndex] = event;
      writeIndex += 1;
    }
  }
  return Object.freeze(visible);
}

/** Produce portable replay context without executing any recorded action. */
export function computeReplayContext(
  index: SessionIndex,
  branchId: string,
  through: LogicalSequence,
): readonly ReplayItem[] {
  return Object.freeze(
    resolveVisibleEvents(index, branchId, through).map((event) =>
      cloneFreeze({
        eventId: event.id,
        sourceBranchId: event.branchId,
        seq: event.seq,
        kind: event.kind,
        occurredAt: event.occurredAt,
        summary: event.summary,
        payload: event.payload,
      }),
    ),
  );
}

export interface CapabilityEvidence {
  /** Filesystem-change events with captured deltas, addressed by stable id. */
  readonly availableDeltaEventIds?: readonly string[];
  /** Canonical payloads known to contain required redactions at replay time. */
  readonly redactedEventIds?: readonly string[];
  /** A storage/snapshot layer may mark checkpoints unusable. */
  readonly unusableCheckpoints?: readonly Readonly<{
    checkpointId: string;
    reason: Extract<
      BranchabilityUnavailableReason,
      "invalid_manifest" | "excluded_path" | "unsupported_snapshot"
    >;
  }>[];
}

export function computeEventCapabilities(
  index: SessionIndex,
  branchId: string,
  target: LogicalSequence,
  evidence: CapabilityEvidence = {},
): EventCapabilities {
  const branch = requireBranch(index, branchId);
  const event = requireTarget(index, branch, target);
  const checkedEvidence = validateEvidence(index, evidence);
  const replayability = checkedEvidence.redactedEventIds.has(event.id)
    ? ({ status: "unavailable", reason: "required_data_redacted" } as const)
    : ({ status: "replayable" } as const);

  if (branch.branch.state !== "ready") {
    return cloneFreeze({
      eventId: event.id,
      replayability,
      branchability: { status: "unavailable", reason: "branch_not_ready" },
    });
  }

  const visible = resolveVisibleEvents(index, branchId, target);
  const visibleOwnerAtSeq = new Map(
    visible.map((item) => [item.seq, item.branchId] as const),
  );
  const checkpoints = index
    ._checkpoints()
    .filter(
      (item) =>
        item.eventSeq <= target &&
        visibleOwnerAtSeq.get(item.eventSeq) === item.branchId,
    )
    .sort(
      (left, right) =>
        right.eventSeq - left.eventSeq || left.id.localeCompare(right.id),
    );

  if (checkpoints.length === 0) {
    return unavailableCapabilities(event.id, replayability, "no_checkpoint");
  }
  let firstFailure: BranchabilityUnavailableReason | undefined;
  for (const checkpoint of checkpoints) {
    const unusableReason = checkedEvidence.unusableCheckpoints.get(
      checkpoint.id,
    );
    if (unusableReason !== undefined) {
      firstFailure ??= unusableReason;
      continue;
    }
    let reconstruction: Reconstruction;
    if (checkpoint.eventSeq === target) {
      reconstruction = {
        kind: "exact",
        checkpointId: checkpoint.id,
        checkpointEventSeq: checkpoint.eventSeq,
        effectiveRestoreSeq: target,
      };
    } else {
      const requiredDeltas = visible.filter(
        (item) =>
          item.seq > checkpoint.eventSeq && item.kind === "filesystem_change",
      );
      if (
        requiredDeltas.some(
          (item) => !checkedEvidence.availableDeltaEventIds.has(item.id),
        )
      ) {
        firstFailure ??= "missing_delta";
        continue;
      }
      reconstruction = {
        kind: "checkpoint_plus_deltas",
        checkpointId: checkpoint.id,
        checkpointEventSeq: checkpoint.eventSeq,
        deltaEventSeqs: requiredDeltas.map((item) => item.seq),
        effectiveRestoreSeq: target,
      };
    }
    return cloneFreeze({
      eventId: event.id,
      replayability,
      branchability: { status: "branchable", reconstruction },
    });
  }
  return unavailableCapabilities(
    event.id,
    replayability,
    firstFailure ?? "no_checkpoint",
  );
}

export interface BranchPlanIntent {
  readonly branch: ChildBranch;
  readonly parentBranchId: string;
  readonly targetEventId: string;
  readonly reconstruction: Reconstruction;
  readonly context: readonly ReplayItem[];
  readonly instruction: string;
  readonly completionTransition: Readonly<{
    from: "preparing";
    success: "ready";
    failure: "failed";
  }>;
}

/** Prepare a persistence/restore intent; callers execute it in their own layer. */
export function prepareBranchPlan(
  index: SessionIndex,
  input: Readonly<{
    id: string;
    parentBranchId: string;
    forkSeq: LogicalSequence;
    instruction: string;
    evidence?: CapabilityEvidence;
  }>,
): BranchPlanIntent {
  const record = exactRecord(
    input,
    ["id", "parentBranchId", "forkSeq", "instruction", "evidence"],
    "INVALID_BRANCH",
    "Branch plan",
  );
  const id = requiredString(record, "id", "INVALID_BRANCH");
  const parentBranchId = requiredString(
    record,
    "parentBranchId",
    "INVALID_BRANCH",
  );
  const forkSeq = ownValue(record, "forkSeq", "INVALID_FORK");
  const instruction = ownValue(record, "instruction", "INVALID_INSTRUCTION");
  if (!isLogicalSequence(forkSeq)) {
    fail("INVALID_FORK", "Branch plan fork sequence is invalid");
  }
  if (index._branch(id) !== undefined) {
    fail("DUPLICATE_NEW_BRANCH", `Branch already exists: ${id}`);
  }
  if (!nonEmpty(instruction)) {
    fail("INVALID_INSTRUCTION", "A new instruction is required");
  }
  const parent = requireBranch(index, parentBranchId);
  const target = requireTarget(index, parent, forkSeq);
  const capabilities = computeEventCapabilities(
    index,
    parentBranchId,
    forkSeq,
    Object.hasOwn(record, "evidence")
      ? (ownValue(record, "evidence", "INVALID_EVIDENCE") as CapabilityEvidence)
      : undefined,
  );
  if (capabilities.branchability.status !== "branchable") {
    fail(
      "NOT_BRANCHABLE",
      "The selected event cannot reconstruct workspace state",
      {
        branchId: parentBranchId,
        forkSeq,
      },
    );
  }
  return cloneFreeze({
    branch: {
      id,
      sessionId: index.session.id,
      parentId: parentBranchId,
      forkSeq,
      state: "preparing",
    },
    parentBranchId,
    targetEventId: target.id,
    reconstruction: capabilities.branchability.reconstruction,
    context: computeReplayContext(index, parentBranchId, forkSeq),
    instruction,
    completionTransition: {
      from: "preparing",
      success: "ready",
      failure: "failed",
    },
  });
}

function indexOwnedEvents(
  candidates: readonly unknown[],
  branches: ReadonlyMap<string, Branch>,
): Map<string, readonly Event[]> {
  const staging = new Map<string, Event[]>();
  const ids = new Set<string>();
  for (const value of candidates) {
    const candidate = projectEvent(value);
    if (!branches.has(candidate.branchId)) {
      fail("UNKNOWN_BRANCH", "Event owner does not exist", {
        eventId: candidate.id,
        branchId: candidate.branchId,
      });
    }
    if (branches.get(candidate.branchId)!.state !== "ready") {
      fail("INVALID_EVENT", "Only ready branches may own events", {
        eventId: candidate.id,
        branchId: candidate.branchId,
      });
    }
    if (ids.has(candidate.id)) {
      fail("DUPLICATE_EVENT", `Duplicate event id: ${candidate.id}`);
    }
    ids.add(candidate.id);
    const list = staging.get(candidate.branchId) ?? [];
    const previous = list.at(-1);
    if (previous !== undefined && candidate.seq <= previous.seq) {
      fail(
        "NON_MONOTONIC_EVENT",
        "Owned events must be appended in sequence order",
        {
          branchId: candidate.branchId,
          seq: candidate.seq,
        },
      );
    }
    list.push(candidate);
    staging.set(candidate.branchId, list);
  }
  const result = new Map<string, readonly Event[]>();
  for (const [id, list] of staging) result.set(id, Object.freeze(list));
  return result;
}

function indexCheckpoints(
  candidates: readonly unknown[],
  branches: ReadonlyMap<string, IndexedBranch>,
  ownedSequences: ReadonlyMap<string, ReadonlySet<LogicalSequence>>,
): readonly Checkpoint[] {
  const ids = new Set<string>();
  return Object.freeze(
    candidates.map((value) => {
      const candidate = projectCheckpoint(value);
      if (ids.has(candidate.id)) {
        fail(
          "DUPLICATE_CHECKPOINT",
          `Duplicate checkpoint id: ${candidate.id}`,
        );
      }
      ids.add(candidate.id);
      const owner = branches.get(candidate.branchId);
      if (
        owner === undefined ||
        owner.branch.state !== "ready" ||
        !ownedSequences.get(candidate.branchId)?.has(candidate.eventSeq)
      ) {
        fail("INVALID_CHECKPOINT", "Checkpoint must reference an owned event", {
          checkpointId: candidate.id,
        });
      }
      return candidate;
    }),
  );
}

function assertAcyclic(branches: ReadonlyMap<string, Branch>): void {
  const complete = new Set<string>();
  for (const startId of branches.keys()) {
    if (complete.has(startId)) continue;
    const path: string[] = [];
    const active = new Set<string>();
    let cursor = startId;
    while (!complete.has(cursor)) {
      if (active.has(cursor)) {
        fail("BRANCH_CYCLE", "Branch lineage contains a cycle", {
          branchId: cursor,
        });
      }
      active.add(cursor);
      path.push(cursor);
      const branch = branches.get(cursor)!;
      if (!isChild(branch)) break;
      cursor = branch.parentId;
    }
    for (const id of path) complete.add(id);
  }
}

function assertContiguous(
  events: readonly Event[],
  first: number,
  branchId: string,
): void {
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.seq !== first + index) {
      fail("NON_CONTIGUOUS_EVENT", "A branch must own a contiguous suffix", {
        branchId,
        expectedSeq: first + index,
        actualSeq: events[index]!.seq,
      });
    }
  }
}

function projectSession(value: unknown): Session {
  const record = exactRecord(
    value,
    ["id", "source", "createdAt"],
    "INVALID_SESSION",
    "Session",
  );
  const id = requiredString(record, "id", "INVALID_SESSION");
  const source = requiredString(record, "source", "INVALID_SESSION");
  const createdAt = requiredTimestamp(record, "createdAt", "INVALID_SESSION");
  return Object.freeze({ id, source, createdAt });
}

function projectBranch(value: unknown): Branch {
  const record = plainRecord(value, "INVALID_BRANCH", "Branch");
  const keys = ownKeys(record, "INVALID_BRANCH", "Branch");
  const child = keys.includes("parentId") || keys.includes("forkSeq");
  assertExactKeys(
    keys,
    child
      ? ["id", "sessionId", "state", "parentId", "forkSeq"]
      : ["id", "sessionId", "state"],
    "INVALID_BRANCH",
    "Branch",
  );
  const id = requiredString(record, "id", "INVALID_BRANCH");
  const sessionId = requiredString(record, "sessionId", "INVALID_BRANCH");
  const state = ownValue(record, "state", "INVALID_BRANCH");
  if (state !== "preparing" && state !== "ready" && state !== "failed") {
    fail("INVALID_BRANCH", "Branch state is invalid");
  }
  if (!child) return Object.freeze({ id, sessionId, state });
  const parentId = requiredString(record, "parentId", "INVALID_BRANCH");
  const forkSeq = ownValue(record, "forkSeq", "INVALID_FORK");
  if (!isLogicalSequence(forkSeq)) {
    fail("INVALID_FORK", "Child fork sequence is invalid");
  }
  return Object.freeze({ id, sessionId, state, parentId, forkSeq });
}

function projectEvent(value: unknown): Event {
  const record = plainRecord(value, "INVALID_EVENT", "Event");
  const keys = ownKeys(record, "INVALID_EVENT", "Event");
  const hasRaw = keys.includes("rawEnvelope");
  assertExactKeys(
    keys,
    [
      "id",
      "branchId",
      "seq",
      "kind",
      "occurredAt",
      "summary",
      "payload",
      ...(hasRaw ? ["rawEnvelope"] : []),
    ],
    "INVALID_EVENT",
    "Event",
  );
  const id = requiredString(record, "id", "INVALID_EVENT");
  const branchId = requiredString(record, "branchId", "INVALID_EVENT");
  const seq = ownValue(record, "seq", "INVALID_EVENT");
  const kind = ownValue(record, "kind", "INVALID_EVENT");
  const occurredAt = requiredTimestamp(record, "occurredAt", "INVALID_EVENT");
  const summary = ownValue(record, "summary", "INVALID_EVENT");
  const payload = ownValue(record, "payload", "INVALID_EVENT");
  const eventKind =
    typeof kind === "string"
      ? EVENT_KINDS.find((candidate) => candidate === kind)
      : undefined;
  if (
    !isLogicalSequence(seq) ||
    eventKind === undefined ||
    typeof summary !== "string" ||
    !isCanonicalEnvelope(payload)
  ) {
    fail("INVALID_EVENT", "Event fields are invalid");
  }
  const base = {
    id,
    branchId,
    seq,
    kind: eventKind,
    occurredAt,
    summary,
    payload: cloneFreeze(payload),
  };
  if (!hasRaw) return Object.freeze(base);
  return Object.freeze({
    ...base,
    rawEnvelope: projectRawEnvelope(
      ownValue(record, "rawEnvelope", "INVALID_EVENT"),
    ),
  });
}

function projectRawEnvelope(value: unknown): NonNullable<Event["rawEnvelope"]> {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "ref",
      "retention",
      "protection",
      "mediaType",
      "sourceSchemaVersion",
    ],
    "INVALID_EVENT",
    "Raw envelope",
  );
  const schemaVersion = ownValue(record, "schemaVersion", "INVALID_EVENT");
  const ref = requiredString(record, "ref", "INVALID_EVENT");
  const retention = ownValue(record, "retention", "INVALID_EVENT");
  const protection = ownValue(record, "protection", "INVALID_EVENT");
  if (
    schemaVersion !== PROTOCOL_SCHEMA_VERSION ||
    retention !== "opt_in" ||
    protection !== "encrypted_restricted_store"
  ) {
    fail("INVALID_EVENT", "Raw envelope metadata is invalid");
  }
  const mediaType = Object.hasOwn(record, "mediaType")
    ? requiredString(record, "mediaType", "INVALID_EVENT")
    : undefined;
  const sourceSchemaVersion = Object.hasOwn(record, "sourceSchemaVersion")
    ? requiredString(record, "sourceSchemaVersion", "INVALID_EVENT")
    : undefined;
  return Object.freeze({
    schemaVersion,
    ref,
    retention,
    protection,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sourceSchemaVersion === undefined ? {} : { sourceSchemaVersion }),
  });
}

function projectCheckpoint(value: unknown): Checkpoint {
  const record = exactRecord(
    value,
    ["id", "branchId", "eventSeq", "manifestRef"],
    "INVALID_CHECKPOINT",
    "Checkpoint",
  );
  const id = requiredString(record, "id", "INVALID_CHECKPOINT");
  const branchId = requiredString(record, "branchId", "INVALID_CHECKPOINT");
  const eventSeq = ownValue(record, "eventSeq", "INVALID_CHECKPOINT");
  const manifestRef = requiredString(
    record,
    "manifestRef",
    "INVALID_CHECKPOINT",
  );
  if (!isLogicalSequence(eventSeq)) {
    fail("INVALID_CHECKPOINT", "Checkpoint sequence is invalid");
  }
  return Object.freeze({ id, branchId, eventSeq, manifestRef });
}

interface ValidatedEvidence {
  readonly availableDeltaEventIds: ReadonlySet<string>;
  readonly redactedEventIds: ReadonlySet<string>;
  readonly unusableCheckpoints: ReadonlyMap<
    string,
    "invalid_manifest" | "excluded_path" | "unsupported_snapshot"
  >;
}

function validateEvidence(
  index: SessionIndex,
  value: CapabilityEvidence,
): ValidatedEvidence {
  const record = exactRecord(
    value,
    ["availableDeltaEventIds", "redactedEventIds", "unusableCheckpoints"],
    "INVALID_EVIDENCE",
    "Capability evidence",
  );
  const availableDeltaEventIds = evidenceEventIds(
    index,
    record,
    "availableDeltaEventIds",
  );
  const redactedEventIds = evidenceEventIds(index, record, "redactedEventIds");
  const unusableCheckpoints = new Map<
    string,
    "invalid_manifest" | "excluded_path" | "unsupported_snapshot"
  >();
  if (Object.hasOwn(record, "unusableCheckpoints")) {
    const entries = safeArray(
      ownValue(record, "unusableCheckpoints", "INVALID_EVIDENCE"),
      "INVALID_EVIDENCE",
      "Unusable checkpoints",
    );
    const known = new Set(index._checkpoints().map((item) => item.id));
    for (const value of entries) {
      const entry = exactRecord(
        value,
        ["checkpointId", "reason"],
        "INVALID_EVIDENCE",
        "Unusable checkpoint",
      );
      const checkpointId = requiredString(
        entry,
        "checkpointId",
        "INVALID_EVIDENCE",
      );
      const reason = ownValue(entry, "reason", "INVALID_EVIDENCE");
      if (
        !known.has(checkpointId) ||
        unusableCheckpoints.has(checkpointId) ||
        (reason !== "invalid_manifest" &&
          reason !== "excluded_path" &&
          reason !== "unsupported_snapshot")
      ) {
        fail("INVALID_EVIDENCE", "Unusable checkpoint evidence is invalid");
      }
      unusableCheckpoints.set(checkpointId, reason);
    }
  }
  return Object.freeze({
    availableDeltaEventIds,
    redactedEventIds,
    unusableCheckpoints,
  });
}

function evidenceEventIds(
  index: SessionIndex,
  record: Readonly<Record<string, unknown>>,
  key: "availableDeltaEventIds" | "redactedEventIds",
): ReadonlySet<string> {
  if (!Object.hasOwn(record, key)) return new Set();
  const values = safeArray(
    ownValue(record, key, "INVALID_EVIDENCE"),
    "INVALID_EVIDENCE",
    key,
  );
  const result = new Set<string>();
  for (const value of values) {
    if (
      !nonEmpty(value) ||
      result.has(value) ||
      index._event(value) === undefined
    ) {
      fail("INVALID_EVIDENCE", `${key} contains an invalid event id`);
    }
    result.add(value);
  }
  return result;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: CoreErrorCode,
  label: string,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(value, code, label);
  assertExactKeys(ownKeys(record, code, label), allowedKeys, code, label, true);
  return record;
}

function plainRecord(
  value: unknown,
  code: CoreErrorCode,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(code, `${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      fail(code, `${label} must be a plain object`);
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof CoreDomainError) throw error;
    fail(code, `${label} cannot be inspected safely`);
  }
}

function ownKeys(
  record: Readonly<Record<string, unknown>>,
  code: CoreErrorCode,
  label: string,
): string[] {
  try {
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== "string")) {
      fail(code, `${label} contains unsupported property keys`);
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        fail(code, `${label} fields must be enumerable own data properties`);
      }
    }
    return keys as string[];
  } catch (error) {
    if (error instanceof CoreDomainError) throw error;
    fail(code, `${label} cannot be inspected safely`);
  }
}

function assertExactKeys(
  actual: readonly string[],
  expected: readonly string[],
  code: CoreErrorCode,
  label: string,
  allowMissing = false,
): void {
  const allowed = new Set(expected);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!allowMissing && expected.some((key) => !actual.includes(key)))
  ) {
    fail(code, `${label} fields do not match the contract`);
  }
}

function ownValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
  code: CoreErrorCode,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      fail(code, `Missing or unsafe field: ${key}`);
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof CoreDomainError) throw error;
    fail(code, `Field cannot be inspected safely: ${key}`);
  }
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  code: CoreErrorCode,
): string {
  const value = ownValue(record, key, code);
  if (!nonEmpty(value)) fail(code, `${key} must be a non-empty string`);
  return value;
}

function requiredTimestamp(
  record: Readonly<Record<string, unknown>>,
  key: string,
  code: CoreErrorCode,
): string {
  const value = requiredString(record, key, code);
  if (!isRfc3339Timestamp(value)) {
    fail(code, `${key} must be an RFC 3339 timestamp`);
  }
  return value;
}

function safeArray(
  value: unknown,
  code: CoreErrorCode,
  label: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value)) fail(code, `${label} must be an array`);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      !keys.includes("length") ||
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)),
      )
    ) {
      fail(code, `${label} must be a dense data-only array`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        fail(code, `${label} must be a dense data-only array`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof CoreDomainError) throw error;
    fail(code, `${label} cannot be inspected safely`);
  }
}

function isChild(branch: Branch): branch is ChildBranch {
  return Object.hasOwn(branch, "parentId");
}

function requireBranch(index: SessionIndex, id: string): IndexedBranch {
  if (!nonEmpty(id)) fail("UNKNOWN_BRANCH", "Branch id must be a string");
  const branch = index._branch(id);
  if (branch === undefined) fail("UNKNOWN_BRANCH", `Unknown branch: ${id}`);
  return branch;
}

function requireTarget(
  index: SessionIndex,
  branch: IndexedBranch,
  seq: LogicalSequence,
): Event {
  if (!isLogicalSequence(seq)) fail("INVALID_TARGET", "Target must be 1-based");
  if (seq > branch.maxVisibleSequence) {
    fail("UNKNOWN_EVENT", "Target is outside visible branch history", { seq });
  }
  let cursor = branch;
  while (isChild(cursor.branch) && seq <= cursor.branch.forkSeq) {
    cursor = requireBranch(index, cursor.branch.parentId);
  }
  const firstOwned = isChild(cursor.branch) ? cursor.branch.forkSeq + 1 : 1;
  const event = cursor.ownedEvents[seq - firstOwned];
  if (event === undefined || event.seq !== seq) {
    fail("UNKNOWN_EVENT", "Target is outside visible branch history", { seq });
  }
  return event;
}

function unavailableCapabilities(
  eventId: string,
  replayability: EventCapabilities["replayability"],
  reason: BranchabilityUnavailableReason,
): EventCapabilities {
  return cloneFreeze({
    eventId,
    replayability,
    branchability: { status: "unavailable", reason },
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const clone = (
    Array.isArray(value)
      ? value.map((item) => cloneFreeze(item))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, cloneFreeze(item)]),
        )
  ) as T;
  return Object.freeze(clone);
}

function fail(
  code: CoreErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number>>,
): never {
  throw new CoreDomainError(code, message, details);
}

export type { JsonValue };
