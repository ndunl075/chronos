import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { DEFAULT_REDACTION_POLICY, redactText } from "@chronos/adapters";
import {
  CoreDomainError,
  indexSession,
  prepareBranchPlan,
  resolveVisibleEvents,
} from "@chronos/core";
import {
  PROTOCOL_SCHEMA_VERSION,
  isLogicalSequence,
  type Branch,
  type Checkpoint,
  type Delta,
  type Event,
  type LaunchPlan,
  type LogicalSequence,
  type Reconstruction,
} from "@chronos/protocol";
import {
  SnapshotError,
  applyManifestDiffChain,
  parseManifest,
  parseManifestDiff,
  restoreSnapshot,
  type ContentStore,
  type SnapshotManifest,
} from "@chronos/snapshots";
import { StorageError, type ChronosRepository } from "@chronos/storage";

export type BranchErrorCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_SESSION"
  | "UNKNOWN_TARGET"
  | "NOT_BRANCHABLE"
  | "UNSUPPORTED_RECONSTRUCTION"
  | "MISSING_CHECKPOINT"
  | "MISSING_DELTA"
  | "RESTORE_FAILED"
  | "STORAGE_FAILED";

export class BranchError extends Error {
  readonly code: BranchErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: BranchErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "BranchError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface CreateBranchOptions {
  readonly repository: ChronosRepository;
  readonly store: ContentStore;
  /** Reconstructed workspaces are created as children of this directory. */
  readonly workspacesRoot: string;
  readonly sessionId: string;
  readonly parentBranchId: string;
  readonly forkSeq: LogicalSequence;
  readonly instruction: string;
  /** Defaults to a generated identifier. */
  readonly branchId?: string;
}

export interface BranchCreation {
  readonly branch: Branch;
  readonly launchPlan: LaunchPlan;
  /** The instruction event the new branch now owns. */
  readonly instructionEvent: Event;
}

export interface MaterializeReconstructionOptions {
  readonly store: ContentStore;
  readonly checkpoints: readonly Checkpoint[];
  readonly deltas: readonly Delta[];
  readonly reconstruction: Reconstruction;
  /**
   * Visible owner branch id at each delta sequence. Required when applying a
   * nonempty delta chain so a hidden same-seq record on another branch cannot
   * be mistaken for the one the reconstruction ordered.
   */
  readonly deltaOwners?: ReadonlyMap<LogicalSequence, string>;
}

/**
 * Resolve the final workspace manifest a reconstruction produces: the
 * checkpoint alone for exact restores, or that checkpoint with each ordered
 * delta applied for `checkpoint_plus_deltas`.
 */
export function materializeReconstructionManifest(
  options: MaterializeReconstructionOptions,
): SnapshotManifest {
  const checkpoint = options.checkpoints.find(
    (item) => item.id === options.reconstruction.checkpointId,
  );
  if (checkpoint === undefined) {
    throw new BranchError(
      "MISSING_CHECKPOINT",
      "The checkpoint that event reconstructs from is missing",
      { checkpointId: options.reconstruction.checkpointId },
    );
  }
  const base = parseManifest(
    new TextDecoder().decode(options.store.get(checkpoint.manifestRef)),
  );
  if (options.reconstruction.kind === "exact") {
    return base;
  }
  const diffs = options.reconstruction.deltaEventSeqs.map((eventSeq) => {
    const ownerId = options.deltaOwners?.get(eventSeq);
    const resolved =
      ownerId === undefined
        ? options.deltas.find((item) => item.eventSeq === eventSeq)
        : options.deltas.find(
            (item) =>
              item.branchId === ownerId && item.eventSeq === eventSeq,
          );
    if (resolved === undefined) {
      throw new BranchError(
        "MISSING_DELTA",
        "A recorded delta required for reconstruction is missing",
        { eventSeq },
      );
    }
    return parseManifestDiff(
      new TextDecoder().decode(options.store.get(resolved.diffRef)),
    );
  });
  return applyManifestDiffChain(base, diffs);
}

/**
 * Fork a session at a recorded coordinate.
 *
 * This is the one implementation of the branch workflow; the API and the CLI
 * both call it, because a flow whose safety lives in its ordering must not
 * exist twice.
 *
 * That ordering: plan against the domain core, insert lineage as `preparing`
 * before anything touches a filesystem, reconstruct the workspace into a new
 * directory and verify it against its manifest, then settle `ready` and
 * append the new instruction in one transaction. A failure after lineage
 * exists settles the branch `failed`, so an attempt leaves a record instead
 * of a branch claiming a workspace it never built.
 *
 * Nothing recorded is executed. The launch plan is display context plus a
 * path; acting on it is a separate, explicit decision.
 */
export function createBranch(options: CreateBranchOptions): BranchCreation {
  const repository = options.repository;
  const instruction = validateInstruction(options.instruction);
  if (!isLogicalSequence(options.forkSeq)) {
    throw new BranchError(
      "INVALID_REQUEST",
      "forkSeq must be a 1-based integer",
    );
  }
  const branchId = validateId(options.branchId) ?? randomUUID();

  const graph = attempt("STORAGE_FAILED", () =>
    repository.loadSessionGraph(options.sessionId),
  );
  const index = attempt("STORAGE_FAILED", () => indexSession(graph));

  let plan;
  try {
    plan = prepareBranchPlan(index, {
      id: branchId,
      parentBranchId: options.parentBranchId,
      forkSeq: options.forkSeq,
      instruction,
    });
  } catch (error) {
    throw fromCore(error);
  }

  const reconstruction = plan.reconstruction;
  const deltaOwners = new Map(
    resolveVisibleEvents(
      index,
      options.parentBranchId,
      options.forkSeq,
    ).map((event) => [event.seq, event.branchId] as const),
  );
  attempt("STORAGE_FAILED", () => repository.insertBranch(plan.branch));
  let workspacePath: string;
  try {
    const manifest = materializeReconstructionManifest({
      store: options.store,
      checkpoints: graph.checkpoints,
      deltas: graph.deltas,
      reconstruction,
      deltaOwners,
    });
    workspacePath = restoreSnapshot({
      manifest,
      store: options.store,
      targetPath: join(options.workspacesRoot, branchId),
    }).workspacePath;
  } catch (error) {
    settleFailed(repository, branchId);
    if (error instanceof BranchError) throw error;
    if (error instanceof SnapshotError) {
      throw new BranchError(
        "RESTORE_FAILED",
        `The workspace could not be reconstructed: ${error.message}`,
        { branchId, code: error.code },
      );
    }
    throw error;
  }

  const instructionEvent = newInstruction(
    branchId,
    options.forkSeq,
    instruction,
  );
  const branch = attempt("STORAGE_FAILED", () =>
    repository.transaction(() => {
      const settled = repository.settleBranch(branchId, "ready");
      repository.appendEvents([instructionEvent]);
      return settled;
    }),
  );

  return Object.freeze({
    branch,
    instructionEvent,
    launchPlan: {
      workspacePath,
      context: plan.context,
      instruction,
    },
  });
}

/**
 * Settling a failed attempt must not mask the failure that caused it, so a
 * problem here is swallowed: the reconstruction error is the useful one.
 */
function settleFailed(repository: ChronosRepository, branchId: string): void {
  try {
    repository.settleBranch(branchId, "failed");
  } catch {
    // The branch stays `preparing`; it is still visibly not ready.
  }
}

function newInstruction(
  branchId: string,
  forkSeq: LogicalSequence,
  instruction: string,
): Event {
  const seq = forkSeq + 1;
  if (!isLogicalSequence(seq)) {
    throw new BranchError(
      "INVALID_REQUEST",
      "That fork point has no room for a next event",
    );
  }
  return Object.freeze({
    id: randomUUID(),
    branchId,
    seq,
    kind: "instruction" as const,
    occurredAt: new Date().toISOString(),
    summary: instruction.slice(0, 200),
    payload: {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      data: { text: instruction },
    },
  });
}

/** A person types the instruction, so it is redacted like any other record. */
function validateInstruction(instruction: unknown): string {
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    throw new BranchError("INVALID_REQUEST", "An instruction is required");
  }
  return redactText(instruction, DEFAULT_REDACTION_POLICY).value;
}

function validateId(branchId: string | undefined): string | undefined {
  if (branchId === undefined) return undefined;
  if (typeof branchId !== "string" || branchId.trim().length === 0) {
    throw new BranchError("INVALID_REQUEST", "A branch id cannot be empty");
  }
  return branchId;
}

function fromCore(error: unknown): BranchError {
  if (!(error instanceof CoreDomainError)) {
    if (error instanceof BranchError) return error;
    throw error;
  }
  switch (error.code) {
    case "UNKNOWN_BRANCH":
    case "UNKNOWN_EVENT":
      return new BranchError("UNKNOWN_TARGET", error.message);
    case "NOT_BRANCHABLE":
      return new BranchError("NOT_BRANCHABLE", error.message);
    case "DUPLICATE_NEW_BRANCH":
    case "INVALID_INSTRUCTION":
    case "INVALID_FORK":
    case "INVALID_TARGET":
      return new BranchError("INVALID_REQUEST", error.message);
    default:
      return new BranchError("STORAGE_FAILED", error.message);
  }
}

function attempt<T>(code: BranchErrorCode, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof BranchError) throw error;
    if (error instanceof StorageError) {
      if (error.code === "UNKNOWN_RECORD") {
        throw new BranchError("UNKNOWN_SESSION", error.message);
      }
      throw new BranchError(code, error.message, { storage: error.code });
    }
    if (error instanceof CoreDomainError) throw fromCore(error);
    throw error;
  }
}
