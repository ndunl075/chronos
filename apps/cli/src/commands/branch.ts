import { existsSync } from "node:fs";

import { BranchError, createBranch } from "@chronos/branching";
import { isLogicalSequence, type LogicalSequence } from "@chronos/protocol";
import { ContentStore } from "@chronos/snapshots";
import { ChronosRepository, openStorage } from "@chronos/storage";

import {
  requiredPositional,
  stringFlag,
  type CommandSpec,
  type ParsedArgs,
} from "../args.js";
import { failure, usageError } from "../errors.js";
import { ensureHome } from "../home.js";
import type { CommandContext } from "./import.js";

export const branchSpec: CommandSpec = {
  name: "branch",
  summary:
    "Fork a session at a recorded event, reconstruct its workspace, and print the launch plan.",
  positionals: [
    { name: "session", required: true, description: "Session to fork" },
  ],
  flags: {
    from: {
      type: "string",
      description: "Branch to fork from (default: the session's root)",
    },
    at: { type: "string", description: "Sequence to fork at (required)" },
    instruction: {
      type: "string",
      description: "The new instruction for the branch (required)",
    },
    id: { type: "string", description: "Identifier for the new branch" },
    home: { type: "string", description: "Chronos home directory" },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
};

/**
 * Create a branch without a server.
 *
 * The workflow lives in `@chronos/branching`; this command resolves what the
 * user meant, reports the outcome, and stops there. It reconstructs a
 * workspace and writes an instruction, and it deliberately does not launch
 * anything: running the agent against the new workspace is the user's next,
 * separate decision.
 */
export function runBranch(args: ParsedArgs, context: CommandContext): void {
  const sessionId = requiredPositional(args, 0, "session");
  const forkSeq = requiredSequence(args, "at");
  const instruction = stringFlag(args, "instruction");
  if (instruction === undefined) {
    usageError(
      "--instruction is required",
      "A branch exists to try something different; say what that is",
    );
  }

  const home = ensureHome(context.home);
  if (!existsSync(home.databasePath)) {
    failure(
      `No Chronos database at ${home.databasePath}`,
      'Run "chronos import <file.jsonl>" first',
    );
  }
  const storage = openStorage({ path: home.databasePath });

  try {
    const repository = new ChronosRepository(storage);
    const parentBranchId = resolveParent(repository, sessionId, args);
    const created = createBranch({
      repository,
      store: new ContentStore({ root: home.storeRoot }),
      workspacesRoot: home.workspacesRoot,
      sessionId,
      parentBranchId,
      forkSeq,
      instruction,
      ...(stringFlag(args, "id") === undefined
        ? {}
        : { branchId: stringFlag(args, "id")! }),
    });

    context.reporter.line(
      `Created branch ${created.branch.id} from ${parentBranchId}@${String(forkSeq)}`,
    );
    context.reporter.line(`  workspace    ${created.launchPlan.workspacePath}`);
    context.reporter.line(
      `  context      ${String(created.launchPlan.context.length)} events`,
    );
    context.reporter.line(`  instruction  ${created.launchPlan.instruction}`);
    context.reporter.line();
    context.reporter.line(
      "The workspace is reconstructed and the instruction is recorded.",
    );
    context.reporter.line(
      "Chronos has run nothing: start your agent in that directory when you are ready.",
    );
    context.reporter.result({
      branch: created.branch,
      launchPlan: created.launchPlan,
      instructionEventId: created.instructionEvent.id,
    });
  } catch (error) {
    throw translate(error);
  } finally {
    storage.close();
  }
}

/** Default to the session's root branch, which is what "fork it" usually means. */
function resolveParent(
  repository: ChronosRepository,
  sessionId: string,
  args: ParsedArgs,
): string {
  const requested = stringFlag(args, "from");
  if (requested !== undefined) return requested;
  if (repository.getSession(sessionId) === undefined) {
    failure(
      `No such session: ${sessionId}`,
      'Run "chronos inspect" to list the sessions you have',
    );
  }
  const branches = repository.listBranches(sessionId);
  const root = branches.find((branch) => !Object.hasOwn(branch, "parentId"));
  if (root === undefined) {
    failure(`Session ${sessionId} has no root branch`);
  }
  return root.id;
}

function translate(error: unknown): unknown {
  if (!(error instanceof BranchError)) return error;
  switch (error.code) {
    case "NOT_BRANCHABLE":
      return failureOf(
        "That event cannot reconstruct a workspace",
        'Run "chronos inspect --branch <id>" and pick an event marked with *',
      );
    case "UNSUPPORTED_RECONSTRUCTION":
      return failureOf(
        error.message,
        "Branch from an event that has its own checkpoint instead",
      );
    case "MISSING_CHECKPOINT":
    case "RESTORE_FAILED":
      return failureOf(
        error.message,
        "The snapshot this branch needs is missing from the local store",
      );
    case "UNKNOWN_SESSION":
    case "UNKNOWN_TARGET":
      return failureOf(
        error.message,
        'Run "chronos inspect" to see what is available',
      );
    default:
      return failureOf(error.message);
  }
}

/** Build the CLI failure so the caller can throw it from where it happened. */
function failureOf(message: string, hint?: string): unknown {
  try {
    failure(message, hint);
  } catch (error) {
    return error;
  }
  return undefined;
}

function requiredSequence(args: ParsedArgs, name: string): LogicalSequence {
  const raw = stringFlag(args, name);
  if (raw === undefined) {
    usageError(
      `--${name} is required`,
      'Pick a sequence from "chronos inspect --branch <id>"',
    );
  }
  const value = Number(raw);
  if (!isLogicalSequence(value)) {
    usageError(`--${name} must be a 1-based integer`);
  }
  return value;
}
