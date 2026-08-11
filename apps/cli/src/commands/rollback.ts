import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { materializeReconstructionManifest } from "@chronos/branching";
import {
  computeEventCapabilities,
  indexSession,
  resolveVisibleEvents,
} from "@chronos/core";
import {
  isLogicalSequence,
  type Event,
  type EventCapabilities,
  type LogicalSequence,
} from "@chronos/protocol";
import {
  ContentStore,
  restoreSnapshotInPlace,
} from "@chronos/snapshots";
import { ChronosRepository, openStorage } from "@chronos/storage";

import {
  booleanFlag,
  stringFlag,
  type CommandSpec,
  type ParsedArgs,
} from "../args.js";
import { failure, usageError } from "../errors.js";
import { ensureHome } from "../home.js";
import type { CommandContext } from "./import.js";

const WRAP_POINTER = "wrap-session.json";

export const rollbackSpec: CommandSpec = {
  name: "rollback",
  summary:
    "Restore a wrap session's workspace in place to an earlier turn (git-independent).",
  positionals: [],
  flags: {
    home: { type: "string", description: "Chronos home directory" },
    workspace: {
      type: "string",
      description: "Workspace directory (reads .chronos/wrap-session.json)",
    },
    session: { type: "string", description: "Wrap session to roll back" },
    steps: {
      type: "string",
      description: "How many wrap turns to undo (default 1)",
    },
    at: {
      type: "string",
      description: "Restore exactly this event sequence instead of --steps",
    },
    confirm: {
      type: "boolean",
      description: "Actually rewrite the workspace (without this, only plan)",
    },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
};

/**
 * Roll a wrap-managed workspace back to an earlier reconstructable turn.
 *
 * Default mode prints the plan. `--confirm` rewrites policy-included files
 * in place and leaves excluded paths (`.git/`, `.env`, `.chronos/`, …) alone.
 */
export function runRollback(args: ParsedArgs, context: CommandContext): void {
  const home = ensureHome(context.home);
  if (!existsSync(home.databasePath)) {
    failure(
      `No Chronos database at ${home.databasePath}`,
      'Run "chronos wrap --workspace <dir> -- <command>" first',
    );
  }

  const workspaceFlag = stringFlag(args, "workspace");
  const workspace =
    workspaceFlag === undefined
      ? undefined
      : workspaceDirectory(context.cwd, workspaceFlag);
  const sessionId =
    stringFlag(args, "session") ??
    (workspace === undefined ? undefined : readPointerSession(workspace));
  if (sessionId === undefined) {
    usageError(
      "rollback needs --session or --workspace with a wrap pointer",
      'Example: chronos rollback --workspace . --steps 1',
    );
  }

  const atFlag = stringFlag(args, "at");
  const stepsFlag = stringFlag(args, "steps");
  if (atFlag !== undefined && stepsFlag !== undefined) {
    usageError("--at and --steps cannot be combined");
  }

  const storage = openStorage({ path: home.databasePath });
  try {
    const repository = new ChronosRepository(storage);
    const session = repository.getSession(sessionId);
    if (session === undefined) failure(`Unknown session: ${sessionId}`);
    if (session.source !== "wrap") {
      failure(
        `Session ${sessionId} is not a wrap session`,
        "rollback only rewrites workspaces recorded by chronos wrap",
      );
    }
    const branches = repository.listBranches(sessionId);
    const root = branches.find((branch) => branch.id.endsWith(":root"));
    if (root === undefined) failure(`Wrap session ${sessionId} has no root branch`);

    const recordedWorkspace = readRecordedWorkspace(repository, root.id);
    const targetWorkspace =
      workspace ??
      (recordedWorkspace === undefined
        ? undefined
        : resolve(recordedWorkspace));
    if (targetWorkspace === undefined) {
      usageError(
        "--workspace is required when the session did not record a path",
      );
    }
    if (
      recordedWorkspace !== undefined &&
      resolve(recordedWorkspace) !== resolve(targetWorkspace)
    ) {
      failure(
        "Workspace does not match the wrap session",
        `Session was recorded for ${recordedWorkspace}`,
      );
    }

    const store = new ContentStore({ root: home.storeRoot });
    const index = indexSession(repository.loadSessionGraph(sessionId));
    const visible = resolveVisibleEvents(index, root.id);
    const turnBoundaries = listTurnBoundaries(index, root.id, visible);
    if (turnBoundaries.length === 0) {
      failure(`Wrap session ${sessionId} has no reconstructable turns`);
    }

    const target = resolveTarget(turnBoundaries, atFlag, stepsFlag);
    const capabilities = target.capabilities;
    if (capabilities.branchability.status !== "branchable") {
      failure(`Sequence ${String(target.seq)} is not reconstructable`);
    }

    const reconstruction = capabilities.branchability.reconstruction;
    const deltaOwners = new Map<LogicalSequence, string>();
    for (const event of visible) {
      if (event.kind === "filesystem_change") {
        deltaOwners.set(event.seq, event.branchId);
      }
    }
    const manifest = materializeReconstructionManifest({
      store,
      checkpoints: repository.listCheckpoints(root.id),
      deltas: repository.listDeltas(root.id),
      reconstruction,
      deltaOwners,
    });

    context.reporter.line(`Rollback plan for ${sessionId}`);
    context.reporter.line(`  workspace    ${targetWorkspace}`);
    context.reporter.line(`  target seq   ${String(target.seq)}`);
    context.reporter.line(`  summary      ${target.event.summary}`);
    context.reporter.line(
      `  restore via  ${reconstruction.kind} @ checkpoint ${reconstruction.checkpointId}`,
    );
    context.reporter.line(
      `  files        ${String(manifest.files.length)} tracked paths`,
    );

    if (!booleanFlag(args, "confirm")) {
      context.reporter.line();
      context.reporter.line(
        "Re-run with --confirm to rewrite the workspace in place.",
      );
      context.reporter.line(
        "Excluded paths (.git/, .env, .chronos/, …) are left untouched.",
      );
      context.reporter.result({
        sessionId,
        branchId: root.id,
        workspace: targetWorkspace,
        targetSeq: target.seq,
        confirmed: false,
        reconstruction,
        files: manifest.files.length,
      });
      return;
    }

    const restored = restoreSnapshotInPlace({
      manifest,
      store,
      workspaceRoot: targetWorkspace,
    });
    context.reporter.line();
    context.reporter.line(
      `Restored ${String(restored.filesWritten)} files, removed ${String(restored.filesRemoved)}`,
    );
    context.reporter.warn(
      "In-place rollback is best-effort; excluded paths were not modified",
    );
    context.reporter.result({
      sessionId,
      branchId: root.id,
      workspace: targetWorkspace,
      targetSeq: target.seq,
      confirmed: true,
      reconstruction,
      filesWritten: restored.filesWritten,
      filesRemoved: restored.filesRemoved,
      bytesWritten: restored.bytesWritten,
    });
  } finally {
    storage.close();
  }
}

interface TurnBoundary {
  readonly event: Event;
  readonly seq: LogicalSequence;
  readonly capabilities: EventCapabilities;
}

function listTurnBoundaries(
  index: ReturnType<typeof indexSession>,
  branchId: string,
  visible: readonly Event[],
): readonly TurnBoundary[] {
  const boundaries: TurnBoundary[] = [];
  for (const event of visible) {
    const capabilities = computeEventCapabilities(index, branchId, event.seq);
    if (capabilities.branchability.status !== "branchable") continue;
    const reconstruction = capabilities.branchability.reconstruction;
    const isBaseline =
      event.kind === "system" &&
      event.summary.includes("baseline") &&
      reconstruction.kind === "exact" &&
      reconstruction.checkpointEventSeq === event.seq;
    const isPostTurn = event.kind === "filesystem_change";
    if (!isBaseline && !isPostTurn) continue;
    boundaries.push(
      Object.freeze({
        event,
        seq: event.seq,
        capabilities,
      }),
    );
  }
  return Object.freeze(boundaries);
}

function resolveTarget(
  boundaries: readonly TurnBoundary[],
  atFlag: string | undefined,
  stepsFlag: string | undefined,
): TurnBoundary {
  if (atFlag !== undefined) {
    if (!isLogicalSequence(Number(atFlag))) {
      usageError(`--at must be a positive integer sequence, got ${atFlag}`);
    }
    const seq = Number(atFlag) as LogicalSequence;
    const found = boundaries.find((item) => item.seq === seq);
    if (found === undefined) {
      failure(
        `No reconstructable wrap turn at sequence ${atFlag}`,
        `Known turns: ${boundaries.map((item) => String(item.seq)).join(", ")}`,
      );
    }
    return found;
  }

  const steps = stepsFlag === undefined ? 1 : Number(stepsFlag);
  if (!Number.isInteger(steps) || steps < 1) {
    usageError("--steps must be a positive integer");
  }
  // steps=1 → previous turn boundary (not the tip, unless tip is baseline only)
  const tipIndex = boundaries.length - 1;
  const targetIndex = tipIndex - steps;
  if (targetIndex < 0) {
    failure(
      `Cannot roll back ${String(steps)} turn(s); only ${String(tipIndex)} prior turn(s) exist`,
      `Known turns: ${boundaries.map((item) => String(item.seq)).join(", ")}`,
    );
  }
  return boundaries[targetIndex]!;
}

function readRecordedWorkspace(
  repository: ChronosRepository,
  branchId: string,
): string | undefined {
  const events = repository.listEvents(branchId);
  for (const event of events) {
    const data = event.payload.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      continue;
    }
    const record = data as { readonly [key: string]: unknown };
    const workspace = record["workspace"];
    if (typeof workspace === "string") return workspace;
  }
  return undefined;
}

function readPointerSession(workspace: string): string | undefined {
  const path = join(workspace, ".chronos", WRAP_POINTER);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      sessionId?: unknown;
    };
    return typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
  } catch {
    return undefined;
  }
}

function workspaceDirectory(cwd: string, value: string): string {
  const path = resolve(cwd, value);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    failure(`Workspace is not a directory: ${path}`);
  }
  return path;
}
