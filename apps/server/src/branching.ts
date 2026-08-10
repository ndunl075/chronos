import { BranchError, createBranch } from "@chronos/branching";
import {
  isLogicalSequence,
  type Branch,
  type LaunchPlan,
  type LogicalSequence,
} from "@chronos/protocol";
import type { ContentStore } from "@chronos/snapshots";
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
 * The workflow itself lives in `@chronos/branching`, which the CLI calls too;
 * this route validates the request, translates failures into status codes,
 * and tells subscribers that the new branch owns an event.
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
        // The session must exist before the workflow reports anything else.
        if (guard(() => repository.getSession(sessionId)) === undefined) {
          apiError("not_found", "No such session");
        }

        let created;
        try {
          created = createBranch({
            repository,
            store: options.store,
            workspacesRoot: options.workspacesRoot,
            sessionId,
            parentBranchId: input.parentBranchId,
            forkSeq: input.forkSeq,
            instruction: input.instruction,
            ...(input.id === undefined ? {} : { branchId: input.id }),
          });
        } catch (error) {
          throw toApiFailure(error);
        }

        broadcaster.publish(
          appendedNotice(sessionId, created.branch.id, [
            created.instructionEvent.id,
          ]),
        );
        const body: BranchCreated = {
          branch: created.branch,
          launchPlan: created.launchPlan,
        };
        return { status: 201, body: resource(body) };
      },
    },
  ]);
}

function toApiFailure(error: unknown): unknown {
  if (!(error instanceof BranchError)) return error;
  switch (error.code) {
    case "INVALID_REQUEST":
      return apiFailure("bad_request", error.message);
    case "UNKNOWN_SESSION":
    case "UNKNOWN_TARGET":
      return apiFailure("not_found", "No such record");
    case "NOT_BRANCHABLE":
    case "UNSUPPORTED_RECONSTRUCTION":
    case "MISSING_CHECKPOINT":
    case "MISSING_DELTA":
    case "RESTORE_FAILED":
      return apiFailure("conflict", error.message);
    default:
      return error;
  }
}

/** Build the failure rather than throwing it, so callers keep the stack. */
function apiFailure(
  code: "bad_request" | "not_found" | "conflict",
  message: string,
): unknown {
  try {
    apiError(code, message);
  } catch (error) {
    return error;
  }
  return undefined;
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
  const instruction = record["instruction"];
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
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    apiError("bad_request", "instruction is required");
  }
  if (id !== undefined && (typeof id !== "string" || id.trim().length === 0)) {
    apiError("bad_request", "id must be a non-empty string when supplied");
  }
  return {
    ...(id === undefined ? {} : { id }),
    parentBranchId,
    forkSeq,
    instruction,
  };
}
