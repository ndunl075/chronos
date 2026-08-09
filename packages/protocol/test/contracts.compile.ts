import type {
  Branch,
  BranchabilityStatus,
  CanonicalEnvelope,
  Event,
  LaunchPlan,
  LogicalSequence,
  ReplayabilityStatus,
} from "../src/index.js";
import { logicalSequence } from "../src/index.js";

const first = logicalSequence(1);

const payload = {
  schemaVersion: 1,
  data: { command: "display-only" },
} as const satisfies CanonicalEnvelope;

const event = {
  id: "event-1",
  branchId: "branch-1",
  seq: first,
  kind: "tool_call",
  occurredAt: "2026-08-09T00:00:00.000Z",
  summary: "Proposed a command",
  payload,
  rawEnvelope: {
    schemaVersion: 1,
    ref: "raw-envelope-1",
    retention: "opt_in",
    protection: "encrypted_restricted_store",
    mediaType: "application/json",
  },
} satisfies Event;

const root = {
  id: "branch-1",
  sessionId: "session-1",
  state: "ready",
} satisfies Branch;

const child = {
  id: "branch-2",
  sessionId: "session-1",
  parentId: root.id,
  forkSeq: event.seq,
  state: "preparing",
} satisfies Branch;

const replayability = {
  status: "replayable",
} satisfies ReplayabilityStatus;

const branchability = {
  status: "branchable",
  reconstruction: {
    kind: "exact",
    checkpointId: "checkpoint-1",
    checkpointEventSeq: first,
    effectiveRestoreSeq: first,
  },
} satisfies BranchabilityStatus;

const launchPlan = {
  workspacePath: "C:/tmp/chronos-branch-2",
  context: [
    {
      eventId: event.id,
      sourceBranchId: child.parentId,
      seq: event.seq,
      kind: event.kind,
      occurredAt: event.occurredAt,
      summary: event.summary,
      payload: event.payload,
    },
  ],
  instruction: "Try a different implementation",
} satisfies LaunchPlan;

void replayability;
void branchability;
void launchPlan;

const coordinate: LogicalSequence = first;
void coordinate;

// @ts-expect-error Child branches require a 1-based fork coordinate.
const childWithoutFork: Branch = { ...child, forkSeq: undefined };
void childWithoutFork;

// @ts-expect-error Event kinds are canonical and provider-neutral.
const providerSpecificKind: Event["kind"] = "claude_tool_use";
void providerSpecificKind;

// @ts-expect-error Persisted coordinates must pass runtime validation first.
const unvalidatedCoordinate: LogicalSequence = 1;
void unvalidatedCoordinate;
