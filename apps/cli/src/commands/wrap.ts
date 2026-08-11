import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { redactJson, redactText } from "@chronos/adapters";
import {
  materializeReconstructionManifest,
} from "@chronos/branching";
import {
  computeEventCapabilities,
  indexSession,
  resolveVisibleEvents,
} from "@chronos/core";
import {
  PROTOCOL_SCHEMA_VERSION,
  logicalSequence,
  type Event,
  type JsonValue,
  type LogicalSequence,
} from "@chronos/protocol";
import {
  ContentStore,
  SnapshotError,
  captureWorkspace,
  diffManifests,
  parseManifest,
  serializeManifest,
  serializeManifestDiff,
  type CaptureResult,
  type SnapshotManifest,
} from "@chronos/snapshots";
import { ChronosRepository, openStorage } from "@chronos/storage";

import {
  stringFlag,
  type CommandSpec,
  type ParsedArgs,
} from "../args.js";
import { CliError, failure, usageError } from "../errors.js";
import { ensureHome } from "../home.js";
import { ensureChronosDir } from "../workspace-dir.js";
import type { CommandContext } from "./import.js";

const WRAP_POINTER = "wrap-session.json";

export const wrapSpec: CommandSpec = {
  name: "wrap",
  summary:
    "Run any command with git-independent workspace snapshots before the first turn and after every turn, so you can roll back later.",
  positionals: [],
  rest: true,
  flags: {
    home: { type: "string", description: "Chronos home directory" },
    workspace: { type: "string", description: "Workspace directory" },
    session: {
      type: "string",
      description: "Continue this wrap session (default: resume pointer or create)",
    },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
};

export type WrapExecutor = (
  command: Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
  }>,
  signal: AbortSignal | undefined,
) => Promise<number>;

/**
 * Snapshot a workspace around one arbitrary command invocation ("turn").
 *
 * Unlike `record`, this does not parse a provider event stream. Each wrap
 * invocation is one turn: baseline (new session) or tip-as-before (continue),
 * then the child process, then a post-turn delta.
 */
export async function runWrap(
  args: ParsedArgs,
  context: CommandContext,
): Promise<void> {
  const workspace = workspaceDirectory(
    context.cwd,
    stringFlag(args, "workspace"),
  );
  const argv = args.positionals;
  if (argv.length === 0) {
    usageError(
      "wrap needs a command after --",
      'Example: chronos wrap --workspace . -- node script.js',
    );
  }
  const executable = argv[0]!;
  const commandArgs = argv.slice(1);
  const executor = context.wrapExecutor ?? executeWrappedCommand;
  const home = ensureHome(context.home);
  const store = new ContentStore({ root: home.storeRoot });
  const storage = openStorage({ path: home.databasePath });
  const repository = new ChronosRepository(storage);

  let sessionId: string | undefined;
  let branchId: string | undefined;
  let sequence = 0;
  let previousManifest: SnapshotManifest | undefined;
  let checkpoints = 0;
  let deltas = 0;
  let created = false;

  try {
    const requested = stringFlag(args, "session") ?? readPointer(workspace)?.sessionId;
    if (requested !== undefined) {
      const resumed = resumeSession(repository, store, requested, workspace);
      sessionId = resumed.sessionId;
      branchId = resumed.branchId;
      sequence = resumed.sequence;
      previousManifest = resumed.manifest;
    } else {
      const started = startSession(repository, store, workspace);
      sessionId = started.sessionId;
      branchId = started.branchId;
      sequence = started.sequence;
      previousManifest = started.manifest;
      checkpoints = 1;
      created = true;
    }

    writePointer(workspace, {
      sessionId,
      branchId,
      workspace,
    });

    const exitCode = await executor(
      { executable, args: commandArgs, cwd: workspace },
      context.signal,
    );

    const after = captureTurn(
      repository,
      store,
      workspace,
      sessionId,
      branchId,
      sequence,
      previousManifest,
      executable,
      commandArgs,
      exitCode,
    );
    sequence = after.sequence;
    deltas += 1;

    context.reporter.line(
      created
        ? `Started wrap session ${sessionId}`
        : `Continued wrap session ${sessionId}`,
    );
    context.reporter.line(`  workspace    ${workspace}`);
    context.reporter.line(`  turn seq     ${String(after.turnSeq)}`);
    context.reporter.line(`  events       ${String(sequence)}`);
    context.reporter.line(`  checkpoints  ${String(checkpoints)}`);
    context.reporter.line(`  deltas       ${String(deltas)}`);
    context.reporter.line(`  exit code    ${String(exitCode)}`);
    context.reporter.warn(
      "Capture excludes reported paths and cannot detect concurrent or external writers",
    );
    context.reporter.line(
      'Roll back with: chronos rollback --workspace <dir> --steps 1',
    );
    context.reporter.result({
      sessionId,
      branchId,
      workspace,
      turnSeq: after.turnSeq,
      events: sequence,
      checkpoints,
      deltas,
      exitCode,
      databasePath: home.databasePath,
    });

    if (exitCode !== 0) {
      throw new CliError(
        `Wrapped command exited with code ${String(exitCode)}`,
        exitCode,
      );
    }
  } finally {
    storage.close();
  }
}

function startSession(
  repository: ChronosRepository,
  store: ContentStore,
  workspace: string,
): {
  readonly sessionId: string;
  readonly branchId: string;
  readonly sequence: number;
  readonly manifest: SnapshotManifest;
} {
  const baseline = durableCapture(workspace, store);
  const sessionId = `wrap:${randomUUID()}`;
  const branchId = `${sessionId}:root`;
  const baselineEvent = makeEvent(
    branchId,
    1,
    "system",
    "Wrap workspace baseline captured",
    {
      workspace,
      excluded: safeExclusions(baseline.capture),
    },
  );
  repository.transaction(() => {
    repository.insertSession({
      id: sessionId,
      source: "wrap",
      createdAt: baselineEvent.occurredAt,
    });
    repository.insertBranch({ id: branchId, sessionId, state: "ready" });
    repository.appendEvents([baselineEvent]);
    repository.insertCheckpoint({
      id: `${sessionId}:checkpoint:baseline`,
      branchId,
      eventSeq: baselineEvent.seq,
      manifestRef: baseline.manifestRef,
    });
  });
  return Object.freeze({
    sessionId,
    branchId,
    sequence: 1,
    manifest: baseline.capture.manifest,
  });
}

function resumeSession(
  repository: ChronosRepository,
  store: ContentStore,
  sessionId: string,
  workspace: string,
): {
  readonly sessionId: string;
  readonly branchId: string;
  readonly sequence: number;
  readonly manifest: SnapshotManifest;
} {
  const session = repository.getSession(sessionId);
  if (session === undefined) {
    failure(
      `Unknown wrap session: ${sessionId}`,
      "Pass a session id printed by a previous chronos wrap, or omit --session to start fresh",
    );
  }
  if (session.source !== "wrap") {
    failure(`Session ${sessionId} is not a wrap session (source: ${session.source})`);
  }
  const branches = repository.listBranches(sessionId);
  const root = branches.find((branch) => branch.id.endsWith(":root"));
  if (root === undefined) failure(`Wrap session ${sessionId} has no root branch`);
  const recordedWorkspace = readRecordedWorkspace(repository, root.id);
  if (recordedWorkspace !== undefined && resolve(recordedWorkspace) !== resolve(workspace)) {
    failure(
      "Workspace does not match the wrap session",
      `Session was recorded for ${recordedWorkspace}`,
    );
  }
  const tip = resolveTipManifest(repository, store, sessionId, root.id);
  return Object.freeze({
    sessionId,
    branchId: root.id,
    sequence: tip.sequence,
    manifest: tip.manifest,
  });
}

function captureTurn(
  repository: ChronosRepository,
  store: ContentStore,
  workspace: string,
  sessionId: string,
  branchId: string,
  sequence: number,
  previousManifest: SnapshotManifest,
  executable: string,
  commandArgs: readonly string[],
  exitCode: number,
): { readonly sequence: number; readonly turnSeq: LogicalSequence } {
  const turnStarted = makeEvent(
    branchId,
    sequence + 1,
    "system",
    `Wrap turn: ${executable}`,
    {
      workspace,
      executable,
      args: commandArgs,
      exitCode,
    },
  );
  try {
    const capture = captureWorkspace({ workspaceRoot: workspace, store });
    const diffRef = store.put(
      new Uint8Array(
        Buffer.from(
          serializeManifestDiff(
            diffManifests(previousManifest, capture.manifest),
          ),
          "utf8",
        ),
      ),
    );
    const changed = makeEvent(
      branchId,
      sequence + 2,
      "filesystem_change",
      "Workspace captured after wrap turn",
      {
        diffRef,
        workspace,
        excluded: safeExclusions(capture),
      },
    );
    repository.transaction(() => {
      repository.appendEvents([turnStarted, changed]);
      repository.insertDelta({
        id: `${sessionId}:delta:${String(changed.seq)}`,
        branchId,
        eventSeq: changed.seq,
        diffRef,
      });
    });
    return Object.freeze({
      sequence: sequence + 2,
      turnSeq: changed.seq,
    });
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error;
    const failed = makeEvent(
      branchId,
      sequence + 2,
      "error",
      "Workspace capture failed after wrap turn",
      { code: "snapshot_capture_failed", workspace },
    );
    repository.transaction(() =>
      repository.appendEvents([turnStarted, failed]),
    );
    failure(`Workspace capture failed after the wrapped command: ${error.message}`);
  }
}

function resolveTipManifest(
  repository: ChronosRepository,
  store: ContentStore,
  sessionId: string,
  branchId: string,
): { readonly sequence: number; readonly manifest: SnapshotManifest } {
  const index = indexSession(repository.loadSessionGraph(sessionId));
  const visible = resolveVisibleEvents(index, branchId);
  if (visible.length === 0) {
    failure(`Wrap session ${sessionId} has no events`);
  }
  const tip = visible[visible.length - 1]!;
  const capabilities = computeEventCapabilities(index, branchId, tip.seq);
  if (capabilities.branchability.status !== "branchable") {
    // Fall back to baseline checkpoint alone when the tip is not branchable.
    const checkpoints = repository.listCheckpoints(branchId);
    const baseline = checkpoints[0];
    if (baseline === undefined) {
      failure(`Wrap session ${sessionId} has no reconstructable tip`);
    }
    return Object.freeze({
      sequence: tip.seq,
      manifest: parseManifest(
        new TextDecoder().decode(store.get(baseline.manifestRef)),
      ),
    });
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
    checkpoints: repository.listCheckpoints(branchId),
    deltas: repository.listDeltas(branchId),
    reconstruction,
    deltaOwners,
  });
  return Object.freeze({ sequence: tip.seq, manifest });
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

function durableCapture(
  workspace: string,
  store: ContentStore,
): {
  readonly capture: CaptureResult;
  readonly manifestRef: string;
} {
  const capture = captureWorkspace({ workspaceRoot: workspace, store });
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(capture.manifest), "utf8")),
  );
  return Object.freeze({ capture, manifestRef });
}

function makeEvent(
  branchId: string,
  number: number,
  kind: Event["kind"],
  rawSummary: string,
  rawPayload: JsonValue,
  occurredAt = new Date().toISOString(),
): Event {
  const eventSummary = redactText(rawSummary).value;
  const payload = redactJson(rawPayload).value;
  return Object.freeze({
    id: `${branchId}:event:${String(number)}`,
    branchId,
    seq: logicalSequence(number),
    kind,
    occurredAt,
    summary:
      eventSummary.length <= 160
        ? eventSummary
        : `${eventSummary.slice(0, 157)}...`,
    payload: { schemaVersion: PROTOCOL_SCHEMA_VERSION, data: payload },
  });
}

function safeExclusions(capture: CaptureResult): JsonValue {
  return capture.excluded.map(({ path, reason, pattern }) => ({
    path,
    reason,
    ...(pattern === undefined ? {} : { pattern }),
  }));
}

function workspaceDirectory(cwd: string, value: string | undefined): string {
  if (value === undefined) usageError("--workspace is required");
  const path = resolve(cwd, value);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    failure(`Workspace is not a directory: ${path}`);
  }
  return path;
}

interface WrapPointer {
  readonly sessionId: string;
  readonly branchId: string;
  readonly workspace: string;
}

function pointerPath(workspace: string): string {
  return join(ensureChronosDir(workspace), WRAP_POINTER);
}

function readPointer(workspace: string): WrapPointer | undefined {
  const path = join(workspace, ".chronos", WRAP_POINTER);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WrapPointer>;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.branchId !== "string" ||
      typeof parsed.workspace !== "string"
    ) {
      return undefined;
    }
    return Object.freeze({
      sessionId: parsed.sessionId,
      branchId: parsed.branchId,
      workspace: parsed.workspace,
    });
  } catch {
    return undefined;
  }
}

function writePointer(workspace: string, pointer: WrapPointer): void {
  writeFileSync(pointerPath(workspace), `${JSON.stringify(pointer, null, 2)}\n`);
}

export async function executeWrappedCommand(
  command: Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
  }>,
  signal: AbortSignal | undefined,
): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
      signal,
    });
    child.on("error", (error) => {
      reject(
        new CliError(
          `Could not start wrapped command: ${command.executable}`,
          1,
          error.message,
        ),
      );
    });
    child.on("close", (code, deathSignal) => {
      if (deathSignal !== null) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}
