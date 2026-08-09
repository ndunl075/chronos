import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { DEFAULT_REDACTION_POLICY, redactText } from "@chronos/adapters";
import { indexSession, prepareBranchPlan } from "@chronos/core";
import {
  PROTOCOL_SCHEMA_VERSION,
  isLogicalSequence,
  type Branch,
  type Event,
  type LaunchPlan,
  type LogicalSequence,
} from "@chronos/protocol";
import {
  SnapshotError,
  parseManifest,
  restoreSnapshot,
  type ContentStore,
} from "@chronos/snapshots";
import type { ChronosRepository } from "@chronos/storage";

import { apiError } from "./errors.js";
import { guard, requiredParam, resource } from "./routes.js";
import type { RequestContext, Route } from "./router.js";
import { appendedNotice, type EventBroadcaster } from "./stream.js";

export interface BranchingOptions {
  /** Holds snapshot blobs and the serialized manifests they belong to. */
  readonly store: ContentStore;
  /** Parent directory that reconstructed workspaces are created under. */
  readonly workspacesRoot: string;
}

export interface BranchCreated {
  readonly branch: Branch;
  readonly launchPlan: LaunchPlan;
}

/**
 * Create a child branch from a recorded coordinate.
 *
 * The order is the whole safety story. Lineage is inserted as `preparing`
 * before anything touches a filesystem, the workspace is reconstructed into a
 * new directory and verified against its manifest, and only then does the
 * branch settle as `ready` with its new instruction appended in one
 * transaction. A failure settles the branch as `failed`, leaving a record of
 * the attempt rather than a branch claiming a workspace it never built.
 *
 * Creating a branch runs nothing. The response carries a launch plan whose
 * context is display data; launching it is a separate, explicit act.
 */
export function branchRoutes(
  repository: ChronosRepository,
  broadcaster: EventBroadcaster,
  options: BranchingOptions,
): readonly Route[] {
  return Object.freeze([
    {
      method: "POST" as const,
      path: "/sessions/:sessionId/branches",
      handler: (context: RequestContext) => {
        const sessionId = requiredParam(context, "sessionId");
        const input = branchRequest(context);
        const graph = guard(() => repository.loadSessionGraph(sessionId));
        const index = guard(() => indexSession(graph));
        const branchId = input.id ?? randomUUID();
        const plan = guard(() =>
          prepareBranchPlan(index, {
            id: branchId,
            parentBranchId: input.parentBranchId,
            forkSeq: input.forkSeq,
            instruction: input.instruction,
          }),
        );

        const reconstruction = plan.reconstruction;
        if (
          reconstruction.kind === "checkpoint_plus_deltas" &&
          reconstruction.deltaEventSeqs.length > 0
        ) {
          apiError(
            "conflict",
            "Reconstructing from recorded deltas is not implemented yet",
          );
        }
        const checkpoint = graph.checkpoints.find(
          (item) => item.id === reconstruction.checkpointId,
        );
        if (checkpoint === undefined) {
          apiError("conflict", "The checkpoint for that event is missing");
        }

        guard(() => repository.insertBranch(plan.branch));
        let workspacePath: string;
        try {
          const manifest = parseManifest(
            new TextDecoder().decode(options.store.get(checkpoint.manifestRef)),
          );
          workspacePath = restoreSnapshot({
            manifest,
            store: options.store,
            targetPath: join(options.workspacesRoot, branchId),
          }).workspacePath;
        } catch (error) {
          // The branch keeps its failure rather than vanishing; a retry uses a
          // new branch id and therefore a fresh workspace directory.
          guard(() => repository.settleBranch(branchId, "failed"));
          if (error instanceof SnapshotError) {
            apiError("conflict", "The workspace could not be reconstructed");
          }
          throw error;
        }

        const event = instructionEvent(
          branchId,
          input.forkSeq,
          plan.instruction,
        );
        const branch = guard(() =>
          repository.transaction(() => {
            const settled = repository.settleBranch(branchId, "ready");
            repository.appendEvents([event]);
            return settled;
          }),
        );
        broadcaster.publish(appendedNotice(sessionId, branchId, [event.id]));

        const created: BranchCreated = {
          branch,
          launchPlan: {
            workspacePath,
            context: plan.context,
            instruction: plan.instruction,
          },
        };
        return { status: 201, body: resource(created) };
      },
    },
  ]);
}

function instructionEvent(
  branchId: string,
  forkSeq: LogicalSequence,
  instruction: string,
): Event {
  const seq = forkSeq + 1;
  if (!isLogicalSequence(seq)) {
    apiError("bad_request", "That fork point has no room for a next event");
  }
  return {
    id: randomUUID(),
    branchId,
    seq,
    kind: "instruction",
    occurredAt: new Date().toISOString(),
    summary: instruction.slice(0, 200),
    payload: {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      data: { text: instruction },
    },
  };
}

function branchRequest(context: RequestContext): {
  id?: string;
  parentBranchId: string;
  forkSeq: LogicalSequence;
  instruction: string;
} {
  const body = context.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    apiError("bad_request", "The request body must be an object");
  }
  const record = body as Record<string, unknown>;
  const parentBranchId = record["parentBranchId"];
  const forkSeq = record["forkSeq"];
  const rawInstruction = record["instruction"];
  const id = record["id"];
  if (
    typeof parentBranchId !== "string" ||
    parentBranchId.trim().length === 0
  ) {
    apiError("bad_request", "parentBranchId is required");
  }
  if (!isLogicalSequence(forkSeq)) {
    apiError("bad_request", "forkSeq must be a 1-based integer");
  }
  if (
    typeof rawInstruction !== "string" ||
    rawInstruction.trim().length === 0
  ) {
    apiError("bad_request", "instruction is required");
  }
  if (id !== undefined && (typeof id !== "string" || id.trim().length === 0)) {
    apiError("bad_request", "id must be a non-empty string when supplied");
  }
  // A person types this, so it is redacted like any other stored record.
  const instruction = redactText(
    rawInstruction,
    DEFAULT_REDACTION_POLICY,
  ).value;
  return {
    ...(id === undefined ? {} : { id }),
    parentBranchId,
    forkSeq,
    instruction,
  };
}
