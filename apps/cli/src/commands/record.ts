import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  AdapterError,
  CLAUDE_SAVED_SESSION_VERSION,
  CODEX_SAVED_SESSION_VERSION,
  createProviderStreamNormalizer,
  redactJson,
  redactText,
  type ProviderAgent,
  type StreamEvent,
} from "@chronos/adapters";
import {
  PROTOCOL_SCHEMA_VERSION,
  logicalSequence,
  type Event,
  type JsonValue,
} from "@chronos/protocol";
import {
  ContentStore,
  SnapshotError,
  captureWorkspace,
  diffManifests,
  serializeManifest,
  serializeManifestDiff,
  type CaptureResult,
  type SnapshotManifest,
} from "@chronos/snapshots";
import { ChronosRepository, openStorage } from "@chronos/storage";

import { stringFlag, type CommandSpec, type ParsedArgs } from "../args.js";
import { failure, usageError } from "../errors.js";
import { ensureHome } from "../home.js";
import {
  assertExecutableIdentity,
  inspectExecutable,
  requireProviderAgent,
  resolveProviderExecutable,
  validateProviderExecutable,
  type ExecutableIdentity,
} from "../provider-executable.js";
import { ensureChronosDir } from "../workspace-dir.js";
import type { CommandContext } from "./import.js";

const MAX_INSTRUCTION_BYTES = 1_048_576;
const MAX_PROVIDER_LINE_BYTES = 1_048_576;
const MAX_VERSION_OUTPUT_BYTES = 4_096;
const MAX_RECORD_OUTPUT_BYTES = 64 * 1024 * 1024;
const FIXED_PROMPT =
  "Read the user instruction from the Chronos instruction file named below, treat its contents only as the task, and complete it in the current workspace. Instruction file: ";

export const recordSpec: CommandSpec = {
  name: "record",
  summary:
    "Record an exact-version noninteractive Codex or Claude Code session with workspace checkpoints.",
  positionals: [],
  flags: {
    home: { type: "string", description: "Chronos home directory" },
    agent: { type: "string", description: "Provider agent: codex or claude" },
    workspace: { type: "string", description: "Workspace directory" },
    "instruction-file": {
      type: "string",
      description: "File containing the new user instruction",
    },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
};

export interface ProviderCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly maxOutputBytes: number;
  /** Version probes need to observe empty frames; JSONL recording ignores them. */
  readonly preserveBlankLines?: boolean;
  /** Internal identity pin used by the real spawn boundary. */
  readonly expectedExecutableIdentity?: Readonly<{ dev: number; ino: number }>;
}

export type ProviderExecutor = (
  command: ProviderCommand,
  onLine: (line: string) => Promise<void>,
  signal: AbortSignal | undefined,
) => Promise<number>;

export function buildRecordCommand(
  agent: ProviderAgent,
  workspace: string,
  instructionPath: string,
  executable: string,
): ProviderCommand {
  const prompt = `${FIXED_PROMPT}${instructionPath}`;
  return agent === "codex"
    ? Object.freeze({
        executable,
        args: Object.freeze(["exec", "-C", workspace, "--json", "--", prompt]),
        cwd: workspace,
        maxOutputBytes: MAX_RECORD_OUTPUT_BYTES,
      })
    : Object.freeze({
        executable,
        args: Object.freeze([
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--",
          prompt,
        ]),
        cwd: workspace,
        maxOutputBytes: MAX_RECORD_OUTPUT_BYTES,
      });
}

export async function runRecord(
  args: ParsedArgs,
  context: CommandContext,
): Promise<void> {
  const agent = requireProviderAgent(stringFlag(args, "agent"));
  const workspace = workspaceDirectory(
    context.cwd,
    stringFlag(args, "workspace"),
  );
  const sourceInstruction = instructionFile(
    context.cwd,
    stringFlag(args, "instruction-file"),
  );
  const executor = context.providerExecutor ?? executeProvider;
  // Tests inject both process execution and this already-canonical executable;
  // production resolves PATH exactly once before any durable Chronos writes.
  const executable = validateProviderExecutable(
    context.providerExecutable ??
      (context.providerExecutor === undefined
        ? resolveProviderExecutable(agent)
        : realpathSync.native(process.execPath)),
  );
  const executableIdentity = inspectExecutable(executable);
  await assertProviderVersion(
    agent,
    executable,
    workspace,
    context.signal,
    executor,
    executableIdentity,
  );
  const home = ensureHome(context.home);
  const instruction = readInstructionFile(sourceInstruction);
  const instructionPath = prepareInstruction(workspace, instruction);
  const command = {
    ...buildRecordCommand(
      agent,
      workspace,
      relative(workspace, instructionPath).replaceAll("\\", "/"),
      executable,
    ),
    expectedExecutableIdentity: {
      dev: executableIdentity.dev,
      ino: executableIdentity.ino,
    },
  };
  const store = new ContentStore({ root: home.storeRoot });
  const baseline = durableCapture(workspace, store);
  const storage = openStorage({ path: home.databasePath });
  const repository = new ChronosRepository(storage);
  const sessionId = `record:${agent}:${randomUUID()}`;
  const branchId = `${sessionId}:root`;
  let sequence = 0;
  let checkpoints = 0;
  let deltas = 0;
  let previousManifest: SnapshotManifest = baseline.capture.manifest;
  let providerSessionId: string | undefined;
  let uncheckpointedMutation = false;
  const normalizer = createProviderStreamNormalizer(agent);

  try {
    const baselineEvent = makeEvent(
      branchId,
      ++sequence,
      "system",
      "Workspace baseline captured",
      { excluded: safeExclusions(baseline.capture) },
    );
    const instructionEvent = makeEvent(
      branchId,
      ++sequence,
      "instruction",
      instruction,
      { text: instruction },
    );
    repository.transaction(() => {
      repository.insertSession({
        id: sessionId,
        source: `${agent}-record`,
        createdAt: baselineEvent.occurredAt,
      });
      repository.insertBranch({ id: branchId, sessionId, state: "preparing" });
      repository.appendEvents([baselineEvent, instructionEvent]);
      repository.insertCheckpoint({
        id: `${sessionId}:checkpoint:baseline`,
        branchId,
        eventSeq: baselineEvent.seq,
        manifestRef: baseline.manifestRef,
      });
    });
    checkpoints += 1;

    assertExecutableIdentity(executableIdentity);
    const exitCode = await executor(
      command,
      async (line) => {
        const normalized = normalizer.push(line);
        providerSessionId = normalizer.sessionId;
        if (normalized.length === 0) return;
        const containsToolResult = normalized.some(
          (item) => item.kind === "tool_result",
        );
        if (containsToolResult) uncheckpointedMutation = true;
        const boundary = recordProviderBatch(
          repository,
          store,
          workspace,
          branchId,
          sessionId,
          sequence,
          normalized,
          previousManifest,
        );
        sequence = boundary.sequence;
        if (boundary.captured) {
          previousManifest = boundary.manifest;
          deltas += 1;
          uncheckpointedMutation = normalizer.hasPendingToolCalls;
        } else if (
          normalized.some(
            (item) => item.kind === "tool_call" || item.kind === "tool_result",
          )
        ) {
          uncheckpointedMutation = true;
        }
      },
      context.signal,
    );
    assertExecutableIdentity(executableIdentity);
    normalizer.finish();
    if (exitCode !== 0) {
      throw new ProviderProcessError(
        "provider_exit",
        `${agent} exited with code ${String(exitCode)}`,
      );
    }
    const completedSequence = sequence + 1;
    const completed = makeEvent(
      branchId,
      completedSequence,
      "system",
      "Provider recording completed",
      { providerSessionId: providerSessionId ?? null },
    );
    repository.transaction(() => {
      repository.appendEvents([completed]);
      repository.settleBranch(branchId, "ready");
    });
    sequence = completedSequence;
  } catch (error) {
    const dirtyAfterToolCall =
      uncheckpointedMutation ||
      normalizer.hasPendingToolCalls ||
      (error instanceof AdapterError &&
        error.details["workspaceState"] === "unknown");
    const failedSequence = sequence + 1;
    const failed = makeEvent(
      branchId,
      failedSequence,
      "error",
      terminalSummary(error),
      {
        code: terminalCode(error),
        ...(dirtyAfterToolCall
          ? { workspaceState: "unknown_after_tool_call" }
          : {}),
      },
    );
    try {
      repository.transaction(() => {
        repository.appendEvents([failed]);
        repository.settleBranch(branchId, "failed");
      });
      sequence = failedSequence;
    } catch {
      // Preserve the provider/storage failure. A failed terminal write leaves
      // the branch preparing, which is still conservatively non-branchable.
    }
    if (error instanceof AdapterError) {
      failure(`The ${agent} stream could not be recorded: ${error.message}`);
    }
    if (error instanceof ProviderProcessError) failure(error.message);
    throw error;
  } finally {
    storage.close();
  }

  context.reporter.line(`Recorded session ${sessionId} with ${agent}`);
  context.reporter.line(`  events       ${String(sequence)}`);
  context.reporter.line(`  checkpoints  ${String(checkpoints)}`);
  context.reporter.line(`  deltas       ${String(deltas)}`);
  context.reporter.line(`  database     ${home.databasePath}`);
  context.reporter.warn(
    "Workspace capture excludes reported paths and cannot detect concurrent or external writers",
  );
  context.reporter.result({
    sessionId,
    branchId,
    agent,
    providerSessionId,
    events: sequence,
    checkpoints,
    deltas,
    databasePath: home.databasePath,
    baselineExcluded: safeExclusions(baseline.capture),
  });
}

function recordProviderBatch(
  repository: ChronosRepository,
  store: ContentStore,
  workspace: string,
  branchId: string,
  sessionId: string,
  sequence: number,
  items: readonly StreamEvent[],
  previousManifest: SnapshotManifest,
): Readonly<
  | { sequence: number; captured: false }
  | {
      sequence: number;
      captured: true;
      manifest: SnapshotManifest;
    }
> {
  const batch = items.map((item, index) =>
    makeEvent(
      branchId,
      sequence + index + 1,
      item.kind,
      item.summary,
      item.payload,
      item.occurredAt,
    ),
  );
  const results = batch.filter((event) => event.kind === "tool_result");
  if (results.length === 0) {
    repository.appendEvents(batch);
    return Object.freeze({
      sequence: sequence + batch.length,
      captured: false,
    });
  }
  const boundaryTime = results.at(-1)!.occurredAt;
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
      sequence + batch.length + 1,
      "filesystem_change",
      "Workspace captured after provider result batch",
      {
        toolResultEventIds: results.map((result) => result.id),
        diffRef,
        excluded: safeExclusions(capture),
      },
      boundaryTime,
    );
    repository.transaction(() => {
      repository.appendEvents([...batch, changed]);
      repository.insertDelta({
        id: `${sessionId}:delta:${String(changed.seq)}`,
        branchId,
        eventSeq: changed.seq,
        diffRef,
      });
    });
    return Object.freeze({
      sequence: sequence + batch.length + 1,
      captured: true,
      manifest: capture.manifest,
    });
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error;
    const failed = makeEvent(
      branchId,
      sequence + batch.length + 1,
      "error",
      "Workspace capture failed after provider result batch",
      {
        toolResultEventIds: results.map((result) => result.id),
        code: "snapshot_capture_failed",
      },
      boundaryTime,
    );
    repository.transaction(() => repository.appendEvents([...batch, failed]));
    return Object.freeze({
      sequence: sequence + batch.length + 1,
      captured: false,
    });
  }
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
  try {
    if (!statSync(path).isDirectory())
      failure(`Workspace is not a directory: ${path}`);
  } catch {
    failure(`Workspace is not a directory: ${path}`);
  }
  return path;
}

function instructionFile(cwd: string, value: string | undefined): string {
  if (value === undefined) usageError("--instruction-file is required");
  return resolve(cwd, value);
}

/** Bounded same-descriptor instruction read; the callback is a race-test seam. */
export function readInstructionFile(
  path: string,
  afterOpen?: () => void,
): string {
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let descriptor: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
      failure("Instruction file must be a real regular file");
    if (process.platform === "win32") assertWindowsInstructionPath(path);
    descriptor = openSync(path, flags);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_INSTRUCTION_BYTES)
      failure("Instruction file must be a regular file no larger than 1 MiB");
    if (!sameFileIdentity(pathBefore, before))
      failure("Instruction file identity changed while it was being opened");
    afterOpen?.();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      length !== before.size
    )
      failure("Instruction file changed while it was being read");
    if (process.platform === "win32") assertWindowsInstructionPath(path, after);
    const pathAfter = lstatSync(path);
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameFileIdentity(pathAfter, after)
    )
      failure("Instruction file identity changed while it was being read");
    return decodeInstructionBytes(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    failure(`Could not read instruction file: ${path}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertWindowsInstructionPath(
  path: string,
  opened?: ReturnType<typeof fstatSync>,
): void {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink())
    failure("Instruction file must be a real regular file");
  const canonical = realpathSync.native(path);
  const after = lstatSync(canonical);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameFileIdentity(before, after)
  )
    failure("Instruction file could not be safely resolved");
  if (opened !== undefined && !sameFileIdentity(after, opened))
    failure("Instruction file identity changed while it was being read");
}

/** Validate the bytes actually read, closing the stat/read race at the limit. */
export function decodeInstructionBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_INSTRUCTION_BYTES)
    failure("Instruction file must be a regular file no larger than 1 MiB");
  let instruction: string;
  try {
    instruction = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failure("Instruction file must contain valid UTF-8");
  }
  if (instruction.trim().length === 0) failure("Instruction file is empty");
  return instruction;
}

function prepareInstruction(workspace: string, instruction: string): string {
  const directory = ensureChronosDir(workspace);
  const path = join(directory, `instruction-${randomUUID()}.txt`);
  writeFileSync(path, instruction, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

async function assertProviderVersion(
  agent: ProviderAgent,
  executable: string,
  cwd: string,
  signal: AbortSignal | undefined,
  executor: ProviderExecutor,
  identity: ExecutableIdentity,
): Promise<void> {
  const expected =
    agent === "codex"
      ? CODEX_SAVED_SESSION_VERSION
      : CLAUDE_SAVED_SESSION_VERSION;
  let output = "";
  let lines = 0;
  assertExecutableIdentity(identity);
  const exitCode = await executor(
    {
      executable,
      args: ["--version"],
      cwd,
      maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
      preserveBlankLines: true,
      expectedExecutableIdentity: { dev: identity.dev, ino: identity.ino },
    },
    async (line) => {
      lines += 1;
      if (
        lines > 1 ||
        Buffer.byteLength(output, "utf8") + Buffer.byteLength(line, "utf8") >
          MAX_VERSION_OUTPUT_BYTES
      ) {
        throw new ProviderProcessError(
          "invalid_version_output",
          `Malformed ${agent} version output`,
        );
      }
      output += `${line}\n`;
    },
    signal,
  );
  assertExecutableIdentity(identity);
  const accepted =
    agent === "codex"
      ? `codex-cli ${expected}\n`
      : `${expected} (Claude Code)\n`;
  if (exitCode !== 0 || lines !== 1 || output !== accepted) {
    failure(
      `Unsupported ${agent} version`,
      `Chronos v0.1 requires ${expected}`,
    );
  }
}

function sameFileIdentity(
  left: Pick<ReturnType<typeof fstatSync>, "dev" | "ino">,
  right: Pick<ReturnType<typeof fstatSync>, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function executeProvider(
  command: ProviderCommand,
  onLine: (line: string) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (
    command.maxOutputBytes !== MAX_VERSION_OUTPUT_BYTES &&
    command.maxOutputBytes !== MAX_RECORD_OUTPUT_BYTES
  )
    throw new ProviderProcessError(
      "invalid_output_limit",
      "Provider output limit must be a Chronos fixed limit",
    );
  if (signal?.aborted === true)
    throw new ProviderProcessError(
      "provider_aborted",
      "Provider process was aborted",
    );
  if (command.expectedExecutableIdentity !== undefined)
    assertExecutableIdentity({
      path: command.executable,
      ...command.expectedExecutableIdentity,
    });
  const child = spawn(command.executable, [...command.args], {
    cwd: command.cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const settled = new Promise<
    | { readonly kind: "exit"; readonly code: number }
    | { readonly kind: "spawn_error"; readonly error: Error }
  >((resolvePromise) => {
    child.once("error", (error) =>
      resolvePromise({ kind: "spawn_error", error }),
    );
    child.once("close", (code) =>
      resolvePromise({ kind: "exit", code: code ?? 1 }),
    );
  });
  let aborted = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (process.platform !== "win32" && forceTimer === undefined) {
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 250);
      forceTimer.unref();
    }
  };
  const abort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await consumeLines(
      child.stdout,
      onLine,
      command.maxOutputBytes,
      command.preserveBlankLines === true,
    );
    const result = await settled;
    if (aborted)
      throw new ProviderProcessError(
        "provider_aborted",
        "Provider process was aborted",
      );
    if (result.kind === "spawn_error") throw result.error;
    if (command.expectedExecutableIdentity !== undefined)
      assertExecutableIdentity({
        path: command.executable,
        ...command.expectedExecutableIdentity,
      });
    return result.code;
  } catch (error) {
    child.stdout.destroy();
    terminate();
    await settled;
    if (aborted)
      throw new ProviderProcessError(
        "provider_aborted",
        "Provider process was aborted",
      );
    throw error;
  } finally {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    signal?.removeEventListener("abort", abort);
    if (command.expectedExecutableIdentity !== undefined)
      assertExecutableIdentity({
        path: command.executable,
        ...command.expectedExecutableIdentity,
      });
  }
}

async function consumeLines(
  input: AsyncIterable<Uint8Array>,
  onLine: (line: string) => Promise<void>,
  maxTotalBytes: number,
  preserveBlankLines: boolean,
): Promise<void> {
  let segments: Buffer[] = [];
  let length = 0;
  let totalBytes = 0;
  const emit = async (): Promise<void> => {
    const bytes = Buffer.concat(segments, length);
    segments = [];
    length = 0;
    const content =
      bytes.at(-1) === 13 ? bytes.subarray(0, bytes.length - 1) : bytes;
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new ProviderProcessError(
        "invalid_provider_output",
        "Provider output is not valid UTF-8",
      );
    }
    if (preserveBlankLines || line.trim().length > 0) await onLine(line);
  };

  for await (const value of input) {
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxTotalBytes)
      throw new ProviderProcessError(
        "provider_output_limit",
        `Provider output exceeds the ${formatByteLimit(maxTotalBytes)} limit`,
      );
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - offset;
      if (length + size > MAX_PROVIDER_LINE_BYTES)
        throw new ProviderProcessError(
          "provider_output_limit",
          "Provider output line exceeds the 1 MiB limit",
        );
      if (size > 0) {
        segments.push(Buffer.from(chunk.subarray(offset, end)));
        length += size;
      }
      if (newline === -1) break;
      await emit();
      offset = newline + 1;
    }
  }
  if (length > 0) await emit();
}

function formatByteLimit(bytes: number): string {
  if (bytes === 4_096) return "4 KiB";
  if (bytes === MAX_RECORD_OUTPUT_BYTES) return "64 MiB";
  return `${String(bytes)} byte`;
}

class ProviderProcessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderProcessError";
    this.code = code;
  }
}

function terminalCode(error: unknown): string {
  if (error instanceof AdapterError) return "invalid_provider_stream";
  if (error instanceof ProviderProcessError) return error.code;
  return "provider_process_failed";
}

function terminalSummary(error: unknown): string {
  if (error instanceof AdapterError) return "Provider stream was rejected";
  if (
    error instanceof ProviderProcessError &&
    error.code === "provider_aborted"
  )
    return "Provider recording was aborted";
  return "Provider recording failed";
}
