import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as schedule } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { TextEncoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ContentStore,
  captureWorkspace,
  parseManifest,
  serializeManifest,
} from "@chronos/snapshots";
import { computeEventCapabilities, indexSession } from "@chronos/core";
import { ChronosRepository, openStorage } from "@chronos/storage";

import {
  CLI_VERSION,
  buildRecordCommand,
  decodeInstructionBytes,
  executeProvider,
  resolveProviderExecutable,
  isSupportedWindowsExecutablePath,
  readInstructionFile,
  run,
} from "../dist/index.js";

const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "adapters",
    "test",
    "fixtures",
    "upload-retry.jsonl",
  ),
  "utf8",
);
const ADAPTER_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "adapters",
  "test",
  "fixtures",
);

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-cli-"));
  const home = join(root, "home");
  const opened = [];
  // Windows will not unlink an open database file, so handles close first.
  t.after(() => {
    for (const storage of opened) storage.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  });
  return {
    root,
    home,
    file(name, contents) {
      const path = join(root, name);
      writeFileSync(path, contents);
      return path;
    },
    /** Open the database the CLI wrote, to check what actually landed. */
    read() {
      const storage = openStorage({ path: join(home, "chronos.sqlite") });
      opened.push(storage);
      return new ChronosRepository(storage);
    },
  };
}

async function cli(box, argv, signal, providerExecutor) {
  const out = [];
  const err = [];
  const exitCode = await run(argv, {
    ...(signal === undefined ? {} : { signal }),
    streams: {
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
    ...(providerExecutor === undefined
      ? {}
      : { providerExecutor: withExactTerminal(providerExecutor) }),
  });
  return { exitCode, out: out.join(""), err: err.join("") };
}

async function cliRaw(box, argv, providerExecutor) {
  const out = [];
  const err = [];
  const exitCode = await run(argv, {
    streams: {
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
    providerExecutor,
  });
  return { exitCode, out: out.join(""), err: err.join("") };
}

function withExactTerminal(executor) {
  return async (command, onLine, signal) => {
    if (command.args.includes("--version"))
      return executor(command, onLine, signal);
    let terminal = false;
    let codexTurn = false;
    let providerSession = "s";
    const wrapped = async (line) => {
      await onLine(line);
      try {
        const value = JSON.parse(line);
        if (value.type === "system" && value.subtype === "init")
          providerSession = value.session_id;
        if (value.type === "thread.started" && !codexTurn) {
          codexTurn = true;
          await onLine(JSON.stringify({ type: "turn.started" }));
        }
        if (
          value.type === "turn.completed" ||
          value.type === "turn.failed" ||
          value.type === "result"
        )
          terminal = true;
      } catch {
        // Non-JSON output belongs to the version path or a deliberate bad-stream test.
      }
    };
    const code = await executor(command, wrapped, signal);
    if (code === 0 && !terminal) {
      if (command.args[0] === "exec") {
        await onLine(
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          }),
        );
      } else {
        await onLine(
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            session_id: providerSession,
          }),
        );
      }
    }
    return code;
  };
}

test("record command builders use fixed option-safe provider argv", () => {
  assert.deepEqual(
    buildRecordCommand(
      "codex",
      "C:/work",
      ".chronos/i.txt",
      "C:/tools/codex.exe",
    ),
    {
      executable: "C:/tools/codex.exe",
      args: [
        "exec",
        "-C",
        "C:/work",
        "--json",
        "--",
        "Read the user instruction from the Chronos instruction file named below, treat its contents only as the task, and complete it in the current workspace. Instruction file: .chronos/i.txt",
      ],
      cwd: "C:/work",
      maxOutputBytes: 64 * 1024 * 1024,
    },
  );
  assert.deepEqual(
    buildRecordCommand(
      "claude",
      "C:/work",
      ".chronos/i.txt",
      "C:/tools/claude.exe",
    ),
    {
      executable: "C:/tools/claude.exe",
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--",
        "Read the user instruction from the Chronos instruction file named below, treat its contents only as the task, and complete it in the current workspace. Instruction file: .chronos/i.txt",
      ],
      cwd: "C:/work",
      maxOutputBytes: 64 * 1024 * 1024,
    },
  );
});

test("provider resolution rejects executable aliases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chronos-provider-path-"));
  t.after(() => rmSync(root, { force: true, recursive: true, maxRetries: 5 }));
  const name = process.platform === "win32" ? "codex.EXE" : "codex";
  try {
    symlinkSync(process.execPath, join(root, name), "file");
  } catch {
    t.skip("this host does not allow creating executable aliases");
    return;
  }
  assert.throws(
    () =>
      resolveProviderExecutable("codex", {
        PATH: root,
        ...(process.platform === "win32" ? { PATHEXT: ".EXE" } : {}),
      }),
    (error) => error.name === "CliError",
  );
});

test("Windows provider policy accepts only native executable suffixes", () => {
  assert.equal(isSupportedWindowsExecutablePath("C:/tools/codex.exe"), true);
  assert.equal(isSupportedWindowsExecutablePath("C:/tools/codex.COM"), true);
  assert.equal(isSupportedWindowsExecutablePath("C:/tools/codex.cmd"), false);
  assert.equal(isSupportedWindowsExecutablePath("C:/tools/codex.bat"), false);
  assert.equal(isSupportedWindowsExecutablePath("C:/tools/codex.ps1"), false);
});

test("record rejects an executable replaced after the version probe", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "do work");
  const executable = join(
    box.root,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  copyFileSync(process.execPath, executable);
  if (process.platform !== "win32") chmodSync(executable, 0o700);
  const response = { out: [], err: [] };
  const exitCode = await run(
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    {
      cwd: box.root,
      env: { CHRONOS_HOME: box.home },
      streams: {
        write: (text) => response.out.push(text),
        writeError: (text) => response.err.push(text),
      },
      providerExecutable: realpathSync.native(executable),
      providerExecutor: async (command, onLine) => {
        assert.equal(command.args.includes("--version"), true);
        await onLine("codex-cli 0.146.0-alpha.3");
        renameSync(executable, `${executable}.old`);
        copyFileSync(process.execPath, executable);
        if (process.platform !== "win32") chmodSync(executable, 0o700);
        return 0;
      },
    },
  );
  assert.equal(exitCode, 1);
  assert.match(response.err.join(""), /executable changed/);
  assert.equal(existsSync(box.home), false);
});

test("provider execution bounds lines, terminates failures, and honors abort", async (t) => {
  const box = sandbox(t);
  const command = (source) => ({
    executable: process.execPath,
    args: ["-e", source],
    cwd: box.root,
    maxOutputBytes: 64 * 1024 * 1024,
  });

  const malformedStart = Date.now();
  await assert.rejects(
    executeProvider(
      command(`process.stdout.write("{bad\\n"); setInterval(() => {}, 1000)`),
      async (line) => JSON.parse(line),
      undefined,
    ),
    SyntaxError,
  );
  assert.equal(Date.now() - malformedStart < 3_000, true);

  await assert.rejects(
    executeProvider(
      command(
        `process.stdout.write("x".repeat(1048577)); setInterval(() => {}, 1000)`,
      ),
      async () => undefined,
      undefined,
    ),
    /1 MiB limit/,
  );

  await assert.rejects(
    executeProvider(
      {
        ...command(
          `process.stdout.write("\\n".repeat(4097)); setInterval(() => {}, 1000)`,
        ),
        maxOutputBytes: 4096,
      },
      async () => undefined,
      undefined,
    ),
    /4 KiB limit/,
  );

  const versionFrames = [];
  assert.equal(
    await executeProvider(
      {
        ...command(`process.stdout.write("\\nexact\\n")`),
        maxOutputBytes: 4096,
        preserveBlankLines: true,
      },
      async (line) => versionFrames.push(line),
      undefined,
    ),
    0,
  );
  assert.deepEqual(versionFrames, ["", "exact"]);

  await assert.rejects(
    executeProvider(
      {
        executable: `chronos-missing-${Date.now()}`,
        args: [],
        cwd: box.root,
        maxOutputBytes: 64 * 1024 * 1024,
      },
      async () => undefined,
      undefined,
    ),
    /ENOENT|not found/i,
  );

  const already = new AbortController();
  already.abort();
  await assert.rejects(
    executeProvider(
      {
        executable: "definitely-not-launched",
        args: [],
        cwd: box.root,
        maxOutputBytes: 64 * 1024 * 1024,
      },
      async () => undefined,
      already.signal,
    ),
    /aborted/,
  );

  const later = new AbortController();
  schedule(() => later.abort(), 50);
  await assert.rejects(
    executeProvider(
      command(`setInterval(() => {}, 1000)`),
      async () => undefined,
      later.signal,
    ),
    /aborted/,
  );
});

test("instruction validation bounds and decodes the bytes actually read", () => {
  assert.throws(
    () => decodeInstructionBytes(new Uint8Array(1024 * 1024 + 1)),
    /no larger than 1 MiB/,
  );
  assert.throws(
    () => decodeInstructionBytes(Uint8Array.from([0xc3, 0x28])),
    /valid UTF-8/,
  );
  assert.equal(
    decodeInstructionBytes(new TextEncoder().encode("do the work")),
    "do the work",
  );
});

test(
  "instruction reads reject FIFO and path replacement without following either",
  { skip: process.platform === "win32" },
  (t) => {
    const box = sandbox(t);
    const fifo = join(box.root, "instruction.fifo");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    assert.throws(() => readInstructionFile(fifo), /real regular file/);

    const original = box.file("original.txt", "original instruction");
    const replacement = box.file("replacement.txt", "replacement instruction");
    assert.throws(
      () =>
        readInstructionFile(original, () => {
          renameSync(original, `${original}.old`);
          renameSync(replacement, original);
        }),
      /identity changed/,
    );
  },
);

test("record rejects symlinked and oversized instruction files", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const target = box.file("target.txt", "do work");
  const alias = join(box.root, "instruction-link.txt");
  let linkedSupported = true;
  try {
    symlinkSync(target, alias, "file");
  } catch {
    linkedSupported = false;
  }
  const versionOnly = async (command, onLine) => {
    assert.equal(command.args.includes("--version"), true);
    await onLine("codex-cli 0.146.0-alpha.3");
    return 0;
  };
  if (linkedSupported) {
    const linked = await cli(
      box,
      [
        "record",
        "--agent",
        "codex",
        "--workspace",
        workspace,
        "--instruction-file",
        alias,
      ],
      undefined,
      versionOnly,
    );
    assert.equal(linked.exitCode, 1);
    assert.match(linked.err, /instruction file/i);
  }

  const oversized = box.file("oversized.txt", "x");
  truncateSync(oversized, 1024 * 1024 + 1);
  const tooLarge = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      oversized,
    ],
    undefined,
    versionOnly,
  );
  assert.equal(tooLarge.exitCode, 1);
  assert.match(tooLarge.err, /no larger than 1 MiB/);
});

test("missing executables have no transient rejection under strict handling", () => {
  const moduleUrl = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js"),
  ).href;
  const script = `
    import { executeProvider } from ${JSON.stringify(moduleUrl)};
    try {
      await executeProvider(
        { executable: "chronos-definitely-missing", args: [], cwd: process.cwd(), maxOutputBytes: 4096 },
        async () => undefined,
        undefined,
      );
    } catch {}
    await new Promise((resolve) => setImmediate(resolve));
  `;
  const result = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test(
  "provider execution force-kills a SIGTERM-resistant child after grace",
  { skip: process.platform === "win32" },
  async (t) => {
    const box = sandbox(t);
    const started = Date.now();
    await assert.rejects(
      executeProvider(
        {
          executable: process.execPath,
          args: [
            "-e",
            `process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)`,
          ],
          cwd: box.root,
          maxOutputBytes: 64 * 1024 * 1024,
        },
        async () => {
          throw new Error("stop after output");
        },
        undefined,
      ),
      /stop after output/,
    );
    assert.equal(Date.now() - started < 3_000, true);
  },
);

test("record checkpoints a fake Codex stream without putting instructions in argv", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "before.txt"), "before\n");
  const instruction = box.file("instruction.txt", "SECRET TASK TEXT");
  const commands = [];
  const executor = async (command, onLine) => {
    commands.push(command);
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-fake" }),
    );
    await onLine(
      JSON.stringify({
        type: "item.started",
        timestamp: "2026-08-09T12:00:00Z",
        item: {
          id: "call-1",
          type: "command_execution",
          command: "write after.txt",
        },
      }),
    );
    writeFileSync(join(workspace, "after.txt"), "after\n");
    await onLine(
      JSON.stringify({
        type: "item.completed",
        timestamp: "2026-08-09T12:00:01Z",
        item: {
          id: "call-1",
          type: "command_execution",
          command: "write after.txt",
          aggregated_output: "done",
          exit_code: 0,
        },
      }),
    );
    return 0;
  };

  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  const result = JSON.parse(response.out);
  assert.equal(result.providerSessionId, "thread-fake");
  assert.equal(result.checkpoints, 2);
  assert.equal(commands.length, 2);
  assert.equal(isAbsolute(commands[0].executable), true);
  assert.equal(commands[0].executable, realpathSync.native(process.execPath));
  assert.equal(commands[1].executable, commands[0].executable);
  assert.equal(commands[0].cwd, workspace);
  assert.equal(commands[1].cwd, workspace);
  assert.deepEqual(commands[1].args.slice(0, 5), [
    "exec",
    "-C",
    workspace,
    "--json",
    "--",
  ]);
  assert.equal(commands[1].args.join(" ").includes("SECRET TASK TEXT"), false);
  assert.equal(commands[1].cwd, workspace);

  const repository = box.read();
  const events = repository.listEvents(result.branchId, { limit: 100 });
  assert.deepEqual(
    events.map((item) => item.kind),
    [
      "system",
      "instruction",
      "tool_call",
      "tool_result",
      "filesystem_change",
      "system",
    ],
  );
  const checkpoints = repository.listCheckpoints(result.branchId);
  assert.deepEqual(
    checkpoints.map((item) => item.eventSeq),
    [1, 5],
  );
  const store = new ContentStore({ root: join(box.home, "store") });
  const manifest = parseManifest(
    Buffer.from(store.get(checkpoints[1].manifestRef)).toString("utf8"),
  );
  assert.deepEqual(
    manifest.files.map((item) => item.path),
    ["after.txt", "before.txt"],
  );
  assert.equal(
    result.baselineExcluded.some((item) => item.path === ".chronos"),
    true,
  );
});

test("record checkpoints a Codex completion-only call/result as one batch", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "write once");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "completion-only" }),
    );
    writeFileSync(join(workspace, "done.txt"), "done\n");
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "call",
          type: "command_execution",
          command: "write done.txt",
          aggregated_output: "done",
          exit_code: 0,
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  const result = JSON.parse(response.out);
  const repository = box.read();
  assert.deepEqual(
    repository
      .listEvents(result.branchId, { limit: 100 })
      .map((event) => event.kind),
    [
      "system",
      "instruction",
      "tool_call",
      "tool_result",
      "filesystem_change",
      "system",
    ],
  );
  assert.deepEqual(
    repository.listCheckpoints(result.branchId).map((item) => item.eventSeq),
    [1, 5],
  );
});

test("a live recording stays preparing until its terminal record is durable", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "observe lifecycle");
  let observed = false;
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    const storage = openStorage({ path: join(box.home, "chronos.sqlite") });
    try {
      const repository = new ChronosRepository(storage);
      const session = repository.listSessions()[0];
      const branch = repository.listBranches(session.id)[0];
      assert.equal(branch.state, "preparing");
      observed = true;
    } finally {
      storage.close();
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-live" }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  assert.equal(observed, true);
  const result = JSON.parse(response.out);
  assert.equal(box.read().getBranch(result.branchId).state, "ready");
});

test("missing and failed Codex terminal records settle recordings failed", async (t) => {
  for (const terminal of ["missing", "failed"]) {
    const box = sandbox(t);
    const workspace = join(box.root, `workspace-${terminal}`);
    mkdirSync(workspace);
    const instruction = box.file(`instruction-${terminal}.txt`, "do work");
    const response = await cliRaw(
      box,
      [
        "record",
        "--agent",
        "codex",
        "--workspace",
        workspace,
        "--instruction-file",
        instruction,
      ],
      async (command, onLine) => {
        if (command.args.includes("--version")) {
          await onLine("codex-cli 0.146.0-alpha.3");
          return 0;
        }
        await onLine(
          JSON.stringify({
            type: "thread.started",
            thread_id: `thread-${terminal}`,
          }),
        );
        await onLine(JSON.stringify({ type: "turn.started" }));
        if (terminal === "failed")
          await onLine(
            JSON.stringify({
              type: "turn.failed",
              error: { message: "provider failure" },
            }),
          );
        return 0;
      },
    );
    assert.equal(response.exitCode, 1);
    const repository = box.read();
    const branch = repository.listBranches(repository.listSessions()[0].id)[0];
    assert.equal(branch.state, "failed");
    assert.equal(
      repository.listEvents(branch.id, { limit: 100 }).at(-1).kind,
      "error",
    );
  }
});

test("a declared Claude terminal failure settles the recording failed", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "do work");
  const response = await cliRaw(
    box,
    [
      "record",
      "--agent",
      "claude",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    async (command, onLine) => {
      if (command.args.includes("--version")) {
        await onLine("2.1.225 (Claude Code)");
        return 0;
      }
      await onLine(
        JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      );
      await onLine(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "provider failure",
          session_id: "s",
        }),
      );
      return 0;
    },
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const branch = repository.listBranches(repository.listSessions()[0].id)[0];
  assert.equal(branch.state, "failed");
});

test("Codex file_change completion captures the changed workspace", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "write a file");
  const changes = [{ path: join(workspace, "changed.txt"), kind: "add" }];
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-file" }),
    );
    await onLine(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "file-1",
          type: "file_change",
          changes,
          status: "in_progress",
        },
      }),
    );
    writeFileSync(join(workspace, "changed.txt"), "captured\n");
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "file-1",
          type: "file_change",
          changes,
          status: "completed",
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  const result = JSON.parse(response.out);
  const repository = box.read();
  const events = repository.listEvents(result.branchId, { limit: 100 });
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "system",
      "instruction",
      "tool_call",
      "tool_result",
      "filesystem_change",
      "system",
    ],
  );
  assert.equal(
    computeEventCapabilities(
      indexSession(repository.loadSessionGraph(result.sessionId)),
      result.branchId,
      4,
    ).branchability.reason,
    "missing_delta",
  );
  assert.equal(
    computeEventCapabilities(
      indexSession(repository.loadSessionGraph(result.sessionId)),
      result.branchId,
      5,
    ).branchability.status,
    "branchable",
  );
  const checkpoint = repository.listCheckpoints(result.branchId).at(-1);
  const manifest = parseManifest(
    Buffer.from(
      new ContentStore({ root: join(box.home, "store") }).get(
        checkpoint.manifestRef,
      ),
    ).toString("utf8"),
  );
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["changed.txt"],
  );
});

test("record stores a safe dirty boundary when post-tool capture fails", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "make a large file");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-dirty" }),
    );
    await onLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "call", type: "command_execution", command: "large" },
      }),
    );
    const large = join(workspace, "large.bin");
    writeFileSync(large, "x");
    truncateSync(large, 16 * 1024 * 1024 + 1);
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "call",
          type: "command_execution",
          command: "large",
          aggregated_output: "done",
          exit_code: 0,
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  const result = JSON.parse(response.out);
  const repository = box.read();
  assert.deepEqual(
    repository
      .listEvents(result.branchId, { limit: 100 })
      .map((item) => item.kind),
    ["system", "instruction", "tool_call", "tool_result", "error", "system"],
  );
  assert.deepEqual(
    repository.listCheckpoints(result.branchId).map((item) => item.eventSeq),
    [1],
  );
  assert.equal(
    repository
      .listEvents(result.branchId, { limit: 100 })
      .find((event) => event.kind === "error")?.payload.data.code,
    "snapshot_capture_failed",
  );
});

test("Claude record checkpoints only the final result in one provider record", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "change two files");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("2.1.225 (Claude Code)");
      return 0;
    }
    assert.deepEqual(command.args.slice(0, 4), [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    await onLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-fake",
      }),
    );
    await onLine(
      JSON.stringify({
        type: "assistant",
        session_id: "claude-fake",
        uuid: "assistant-record",
        message: {
          role: "assistant",
          id: "assistant-message",
          content: [
            { type: "tool_use", id: "one", name: "Write", input: {} },
            { type: "tool_use", id: "two", name: "Write", input: {} },
          ],
        },
      }),
    );
    writeFileSync(join(workspace, "one.txt"), "one");
    writeFileSync(join(workspace, "two.txt"), "two");
    await onLine(
      JSON.stringify({
        type: "user",
        session_id: "claude-fake",
        uuid: "user-record",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "one", content: "one" },
            { type: "tool_result", tool_use_id: "two", content: "two" },
          ],
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "claude",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  const result = JSON.parse(response.out);
  const repository = box.read();
  assert.deepEqual(
    repository
      .listEvents(result.branchId, { limit: 100 })
      .map((item) => item.kind),
    [
      "system",
      "instruction",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "filesystem_change",
      "system",
    ],
  );
  assert.deepEqual(
    repository.listCheckpoints(result.branchId).map((item) => item.eventSeq),
    [1, 7],
  );
});

test("a failed capture atomically preserves Claude's complete two-result batch", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "change two files");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("2.1.225 (Claude Code)");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    );
    await onLine(
      JSON.stringify({
        type: "assistant",
        session_id: "s",
        uuid: "calls",
        message: {
          role: "assistant",
          id: "call-message",
          content: [
            { type: "tool_use", id: "one", name: "Write", input: {} },
            { type: "tool_use", id: "two", name: "Write", input: {} },
          ],
        },
      }),
    );
    const large = join(workspace, "large.bin");
    writeFileSync(large, "x");
    truncateSync(large, 16 * 1024 * 1024 + 1);
    await onLine(
      JSON.stringify({
        type: "user",
        session_id: "s",
        uuid: "results",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "one", content: "one" },
            { type: "tool_result", tool_use_id: "two", content: "two" },
          ],
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "claude",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
      "--json",
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 0, response.err);
  const result = JSON.parse(response.out);
  const repository = box.read();
  const events = repository.listEvents(result.branchId, { limit: 100 });
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "system",
      "instruction",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "error",
      "system",
    ],
  );
  assert.deepEqual(events[6].payload.data.toolResultEventIds, [
    events[4].id,
    events[5].id,
  ]);
  assert.deepEqual(
    repository.listCheckpoints(result.branchId).map((item) => item.eventSeq),
    [1],
  );
});

test("a failed final transaction persists none of Claude's two-result batch", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "change two files");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("2.1.225 (Claude Code)");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    );
    await onLine(
      JSON.stringify({
        type: "assistant",
        session_id: "s",
        uuid: "calls",
        message: {
          role: "assistant",
          id: "call-message",
          content: [
            { type: "tool_use", id: "one", name: "Write", input: {} },
            { type: "tool_use", id: "two", name: "Write", input: {} },
          ],
        },
      }),
    );
    writeFileSync(join(workspace, "changed.txt"), "dirty\n");
    const sabotage = openStorage({ path: join(box.home, "chronos.sqlite") });
    try {
      sabotage._database().exec(`
        CREATE TRIGGER reject_post_tool_checkpoint
        BEFORE INSERT ON checkpoint WHEN NEW.event_seq > 1
        BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END
      `);
    } finally {
      sabotage.close();
    }
    await onLine(
      JSON.stringify({
        type: "user",
        session_id: "s",
        uuid: "results",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "one", content: "one" },
            { type: "tool_result", tool_use_id: "two", content: "two" },
          ],
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "claude",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.equal(branch.state, "failed");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["system", "instruction", "tool_call", "tool_call", "error"],
  );
  assert.equal(
    events.at(-1).payload.data.workspaceState,
    "unknown_after_tool_call",
  );
  assert.deepEqual(
    repository.listCheckpoints(branch.id).map((item) => item.eventSeq),
    [1],
  );
});

test("a ready-settle rollback reuses the terminal sequence for a failed settlement", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "finish safely");
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    async (command, onLine) => {
      if (command.args.includes("--version")) {
        await onLine("codex-cli 0.146.0-alpha.3");
        return 0;
      }
      await onLine(
        JSON.stringify({
          type: "thread.started",
          thread_id: "settle-rollback",
        }),
      );
      const sabotage = openStorage({ path: join(box.home, "chronos.sqlite") });
      try {
        sabotage._database().exec(`
          CREATE TRIGGER reject_ready_settlement
          BEFORE UPDATE OF state ON branch WHEN NEW.state = 'ready'
          BEGIN SELECT RAISE(ABORT, 'forced ready settlement failure'); END
        `);
      } finally {
        sabotage.close();
      }
      return 0;
    },
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const branch = repository.listBranches(repository.listSessions()[0].id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.equal(branch.state, "failed");
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  assert.deepEqual(
    events.map((event) => event.kind),
    ["system", "instruction", "error"],
  );
});

test("an invalid Claude result batch remains dirty and non-branchable", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "change a file");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("2.1.225 (Claude Code)");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    );
    await onLine(
      JSON.stringify({
        type: "assistant",
        session_id: "s",
        uuid: "call-record",
        message: {
          role: "assistant",
          id: "call-message",
          content: [{ type: "tool_use", id: "tool", name: "Write", input: {} }],
        },
      }),
    );
    writeFileSync(join(workspace, "changed.txt"), "dirty\n");
    await onLine(
      JSON.stringify({
        type: "user",
        session_id: "s",
        uuid: "result-record",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool",
              content: "ok",
              is_error: false,
            },
            {
              type: "tool_result",
              tool_use_id: "missing",
              content: "bad",
              is_error: false,
            },
          ],
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "claude",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  assert.equal(branch.state, "failed");
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.deepEqual(
    events.map((event) => event.kind),
    ["system", "instruction", "tool_call", "error"],
  );
  assert.equal(
    events.at(-1).payload.data.workspaceState,
    "unknown_after_tool_call",
  );
  const inspected = await cli(box, [
    "inspect",
    "--branch",
    branch.id,
    "--json",
  ]);
  assert.equal(inspected.exitCode, 0, inspected.err);
  assert.equal(
    JSON.parse(inspected.out).events.at(-1).reason,
    "branch_not_ready",
  );
});

test("a checkpoint transaction failure persists a dirty failed terminal boundary", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "change a file");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(JSON.stringify({ type: "thread.started", thread_id: "s" }));
    await onLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "call", type: "command_execution", command: "write" },
      }),
    );
    writeFileSync(join(workspace, "changed.txt"), "dirty\n");
    const sabotage = openStorage({ path: join(box.home, "chronos.sqlite") });
    try {
      sabotage._database().exec(`
        CREATE TRIGGER reject_post_tool_checkpoint
        BEFORE INSERT ON checkpoint WHEN NEW.event_seq > 1
        BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END
      `);
    } finally {
      sabotage.close();
    }
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "call",
          type: "command_execution",
          command: "write",
          aggregated_output: "done",
          exit_code: 0,
        },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.equal(branch.state, "failed");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["system", "instruction", "tool_call", "error"],
  );
  assert.equal(
    events.at(-1).payload.data.workspaceState,
    "unknown_after_tool_call",
  );
  assert.deepEqual(
    repository.listCheckpoints(branch.id).map((item) => item.eventSeq),
    [1],
  );
});

test("a malformed live stream records one safe terminal error", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "do something");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine("{bad json");
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.deepEqual(
    events.map((item) => item.kind),
    ["system", "instruction", "error"],
  );
  assert.equal(events[2].summary, "Provider stream was rejected");
  assert.deepEqual(events[2].payload.data, {
    code: "invalid_provider_stream",
  });
});

test("an unknown mutating provider surface fails closed with unknown workspace state", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace-unknown-surface");
  mkdirSync(workspace);
  const instruction = box.file("instruction-unknown.txt", "do something");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "strict-stream" }),
    );
    writeFileSync(join(workspace, "mutated.txt"), "outside allowlist");
    await onLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "unknown", type: "shell_command", command: "write" },
      }),
    );
    return 0;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.equal(branch.state, "failed");
  assert.deepEqual(events.at(-1).payload.data, {
    code: "invalid_provider_stream",
    workspaceState: "unknown_after_tool_call",
  });
  assert.deepEqual(
    repository.listCheckpoints(branch.id).map((item) => item.eventSeq),
    [1],
  );
});

test("Claude live recording rejects cross-session and duplicate message identities", async (t) => {
  for (const scenario of ["cross-session", "duplicate-message"]) {
    const box = sandbox(t);
    const workspace = join(box.root, `workspace-${scenario}`);
    mkdirSync(workspace);
    const instruction = box.file(`instruction-${scenario}.txt`, "do something");
    const executor = async (command, onLine) => {
      if (command.args.includes("--version")) {
        await onLine("2.1.225 (Claude Code)");
        return 0;
      }
      await onLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session-one",
        }),
      );
      await onLine(
        JSON.stringify({
          type: "assistant",
          session_id:
            scenario === "cross-session" ? "session-two" : "session-one",
          uuid: "record-one",
          message: { role: "assistant", id: "message-one", content: [] },
        }),
      );
      if (scenario === "duplicate-message") {
        await onLine(
          JSON.stringify({
            type: "assistant",
            session_id: "session-one",
            uuid: "record-two",
            message: { role: "assistant", id: "message-one", content: [] },
          }),
        );
      }
      return 0;
    };
    const response = await cli(
      box,
      [
        "record",
        "--agent",
        "claude",
        "--workspace",
        workspace,
        "--instruction-file",
        instruction,
      ],
      undefined,
      executor,
    );
    assert.equal(response.exitCode, 1, scenario);
    const repository = box.read();
    const session = repository.listSessions()[0];
    const branch = repository.listBranches(session.id)[0];
    assert.deepEqual(
      repository
        .listEvents(branch.id, { limit: 100 })
        .map((event) => event.kind),
      ["system", "instruction", "error"],
    );
  }
});

test("spawn and abort failures leave an explicit safe terminal event", async (t) => {
  for (const scenario of ["spawn", "abort"]) {
    const box = sandbox(t);
    const workspace = join(box.root, "workspace");
    mkdirSync(workspace);
    const instruction = box.file("instruction.txt", "do something");
    const controller = new AbortController();
    const executor = async (command, onLine, signal) => {
      if (command.args.includes("--version")) {
        await onLine("codex-cli 0.146.0-alpha.3");
        return 0;
      }
      if (scenario === "spawn") throw new Error("simulated spawn failure");
      schedule(() => controller.abort(), 30);
      return executeProvider(
        {
          executable: process.execPath,
          args: ["-e", `setInterval(() => {}, 1000)`],
          cwd: box.root,
          maxOutputBytes: 64 * 1024 * 1024,
        },
        onLine,
        signal,
      );
    };
    const response = await cli(
      box,
      [
        "record",
        "--agent",
        "codex",
        "--workspace",
        workspace,
        "--instruction-file",
        instruction,
      ],
      controller.signal,
      executor,
    );
    assert.equal(response.exitCode, 1, scenario);
    const repository = box.read();
    const session = repository.listSessions()[0];
    const branch = repository.listBranches(session.id)[0];
    const terminal = repository.listEvents(branch.id, { limit: 100 }).at(-1);
    assert.equal(terminal.kind, "error");
    assert.equal(
      terminal.payload.data.code,
      scenario === "abort" ? "provider_aborted" : "provider_process_failed",
    );
  }
});

test("a real missing provider executable is contained by the CLI lifecycle", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "do something");
  const executor = async (command, onLine, signal) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    const spawnCommand = { ...command };
    delete spawnCommand.expectedExecutableIdentity;
    return executeProvider(
      {
        ...spawnCommand,
        executable: join(box.root, `chronos-missing-${Date.now()}.exe`),
      },
      onLine,
      signal,
    );
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  assert.match(response.err, /ENOENT|not found/i);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.deepEqual(
    events.map((item) => item.kind),
    ["system", "instruction", "error"],
  );
  assert.equal(events.at(-1).payload.data.code, "provider_process_failed");
});

test("a terminal provider failure after a tool call records unknown workspace state", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "start a tool");
  const executor = async (command, onLine) => {
    if (command.args.includes("--version")) {
      await onLine("codex-cli 0.146.0-alpha.3");
      return 0;
    }
    await onLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-dirty" }),
    );
    await onLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "unfinished", type: "command_execution", command: "x" },
      }),
    );
    return 1;
  };
  const response = await cli(
    box,
    [
      "record",
      "--agent",
      "codex",
      "--workspace",
      workspace,
      "--instruction-file",
      instruction,
    ],
    undefined,
    executor,
  );
  assert.equal(response.exitCode, 1);
  const repository = box.read();
  const session = repository.listSessions()[0];
  const branch = repository.listBranches(session.id)[0];
  const events = repository.listEvents(branch.id, { limit: 100 });
  assert.deepEqual(
    events.map((item) => item.kind),
    ["system", "instruction", "tool_call", "error"],
  );
  assert.deepEqual(events.at(-1).payload.data, {
    code: "invalid_provider_stream",
    workspaceState: "unknown_after_tool_call",
  });
  assert.deepEqual(
    repository.listCheckpoints(branch.id).map((item) => item.eventSeq),
    [1],
  );
});

test("version output must be one bounded exact line", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.root, "workspace");
  mkdirSync(workspace);
  const instruction = box.file("instruction.txt", "do something");
  for (const versionLines of [
    ["codex-cli 0.146.0-alpha.3", "codex-cli 0.146.0-alpha.3"],
    [`codex-cli 0.146.0-alpha.3 ${"x".repeat(4096)}`],
    ["prefix codex-cli 0.146.0-alpha.3 suffix"],
    [""],
    [" codex-cli 0.146.0-alpha.3"],
    ["codex-cli 0.146.0-alpha.3 "],
  ]) {
    const executor = async (command, onLine) => {
      assert.equal(command.args.includes("--version"), true);
      for (const line of versionLines) await onLine(line);
      return 0;
    };
    const response = await cli(
      box,
      [
        "record",
        "--agent",
        "codex",
        "--workspace",
        workspace,
        "--instruction-file",
        instruction,
      ],
      undefined,
      executor,
    );
    assert.equal(response.exitCode, 1);
    assert.equal(existsSync(box.home), false);
    assert.equal(existsSync(join(workspace, ".chronos")), false);
  }
});

test("help and version answer without touching anything", async (t) => {
  const box = sandbox(t);

  const help = await cli(box, []);
  assert.equal(help.exitCode, 0);
  assert.match(help.out, /Usage: chronos <command>/);
  assert.match(help.out, /^ {2}import/m);

  assert.equal((await cli(box, ["--help"])).exitCode, 0);
  assert.equal((await cli(box, ["--version"])).out.trim(), CLI_VERSION);

  const commandHelp = await cli(box, ["import", "--help"]);
  assert.equal(commandHelp.exitCode, 0);
  assert.match(commandHelp.out, /Usage: chronos import <file>/);
  assert.match(commandHelp.out, /--retain-raw/);
});

test("a typo is a usage error, not a silent default", async (t) => {
  const box = sandbox(t);

  const unknownCommand = await cli(box, ["improt", "x.jsonl"]);
  assert.equal(unknownCommand.exitCode, 2);
  assert.match(unknownCommand.err, /Unknown command: improt/);

  const unknownFlag = await cli(box, ["import", "x.jsonl", "--no-redakt"]);
  assert.equal(unknownFlag.exitCode, 2);
  assert.match(unknownFlag.err, /Unknown option: --no-redakt/);

  const missingValue = await cli(box, ["import", "x.jsonl", "--home"]);
  assert.equal(missingValue.exitCode, 2);
  assert.match(missingValue.err, /--home needs a value/);

  const valueOnBoolean = await cli(box, ["import", "x.jsonl", "--json=yes"]);
  assert.equal(valueOnBoolean.exitCode, 2);

  const noFile = await cli(box, ["import"]);
  assert.equal(noFile.exitCode, 2);
  assert.match(noFile.err, /Usage: chronos import <file>/);
});

test("a session file imports into the local database", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const result = await cli(box, ["import", path]);
  assert.equal(result.exitCode, 0);
  assert.match(result.out, /Imported session s_upload from chronos-jsonl/);
  assert.match(result.out, /events {7}6/);
  assert.match(result.err, /warning: Raw data for event e3 was dropped/);

  const repository = box.read();
  assert.equal(repository.getSession("s_upload").source, "chronos-jsonl");
  assert.deepEqual(
    repository.listBranches("s_upload").map((branch) => branch.id),
    ["b_root", "b_retry"],
  );
  assert.equal(repository.countEvents("b_root"), 4);
  assert.equal(repository.countEvents("b_retry"), 2);
  assert.deepEqual(
    repository.listCheckpoints("b_root").map((item) => item.id),
    ["cp3"],
  );
});

test("json mode prints one object and no prose", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const result = await cli(box, ["import", path, "--json"]);
  assert.equal(result.exitCode, 0);

  const parsed = JSON.parse(result.out);
  assert.equal(parsed.sessionId, "s_upload");
  assert.equal(parsed.events, 6);
  assert.equal(parsed.checkpoints, 2);
  assert.equal(parsed.databasePath, join(box.home, "chronos.sqlite"));
  assert.deepEqual(
    parsed.diagnostics.map((item) => item.code),
    ["raw_envelope_dropped"],
  );
});

test("raw retention is unavailable while redaction remains opt-out", async (t) => {
  const box = sandbox(t);
  const retained = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const result = await cli(retained, [
    "import",
    path,
    "--retain-raw",
    "--json",
  ]);
  assert.equal(result.exitCode, 1);
  assert.match(result.err, /Raw retention is unavailable/);

  const plain = sandbox(t);
  const secret = plain.file(
    "secret.jsonl",
    [
      `{"type":"session","schemaVersion":1,"id":"s2","source":"x","createdAt":"2026-08-09T00:00:00Z"}`,
      `{"type":"branch","schemaVersion":1,"id":"b1"}`,
      `{"type":"event","schemaVersion":1,"id":"e1","branchId":"b1","seq":1,"kind":"tool_result","occurredAt":"2026-08-09T00:00:00Z","summary":"key AKIAIOSFODNN7EXAMPLE","payload":{"text":"ok"}}`,
    ].join("\n"),
  );

  assert.equal((await cli(plain, ["import", secret])).exitCode, 0);
  assert.equal(plain.read().getEvent("e1").summary, "key [redacted:aws key]");

  const raw = sandbox(t);
  const disabled = await cli(raw, ["import", secret, "--no-redact"]);
  assert.equal(disabled.exitCode, 0);
  assert.match(disabled.err, /warning: Redaction was disabled/);
  assert.equal(raw.read().getEvent("e1").summary, "key AKIAIOSFODNN7EXAMPLE");
});

test("import selects exact-version provider adapters", async (t) => {
  for (const [format, filename, id] of [
    ["codex", "codex-0.146.0-alpha.3.jsonl", "codex-fixture"],
    ["claude", "claude-2.1.225.jsonl", "claude-fixture"],
  ]) {
    const box = sandbox(t);
    const result = await cli(box, [
      "import",
      join(ADAPTER_FIXTURES, filename),
      "--format",
      format,
      "--json",
    ]);
    assert.equal(result.exitCode, 0, result.err);
    assert.equal(JSON.parse(result.out).sessionId, id);
    assert.equal(box.read().getSession(id).source, format);
  }

  const box = sandbox(t);
  const rejected = await cli(box, ["import", "unused", "--format", "future"]);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.err, /Unknown import format/);
});

test("a bad file fails before anything is written", async (t) => {
  const box = sandbox(t);

  const missing = await cli(box, ["import", "nope.jsonl"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err, /Could not read/);
  assert.match(missing.err, /The file does not exist/);

  const oversized = box.file("oversized.jsonl", "x");
  truncateSync(oversized, 67_108_865);
  const tooLarge = await cli(box, ["import", oversized, "--format", "codex"]);
  assert.equal(tooLarge.exitCode, 1);
  assert.match(tooLarge.err, /67108864 byte import limit/);

  const malformed = box.file("bad.jsonl", "{not json\n");
  const rejected = await cli(box, ["import", malformed]);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.err, /line 1/);
  assert.match(rejected.err, /docs\/formats\/chronos-jsonl\.md/);

  const truncated = box.file(
    "half.jsonl",
    [
      `{"type":"session","schemaVersion":1,"id":"s3","source":"x","createdAt":"2026-08-09T00:00:00Z"}`,
      `{"type":"branch","schemaVersion":1,"id":"b1"}`,
      `{"type":"event","schemaVersion":1,"id":"e1","branchId":"b1","seq":1,"kind":"system","occurredAt":"2026-08-09T00:00:00Z","summary":"ok","payload":{}}`,
      `{"type":"event","schemaVersion":1,"id":"e2","branchId":"b1","seq":9,"kind":"system","occurredAt":"2026-08-09T00:00:00Z","summary":"gap","payload":{}}`,
    ].join("\n"),
  );
  const gap = await cli(box, ["import", truncated]);
  assert.equal(gap.exitCode, 1);

  // Nothing from either rejected file reached the database.
  await cli(box, ["import", box.file("ok.jsonl", FIXTURE)]);
  const repository = box.read();
  assert.deepEqual(
    repository.listSessions().map((session) => session.id),
    ["s_upload"],
  );
});

test("a session is never imported twice", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  assert.equal((await cli(box, ["import", path])).exitCode, 0);
  const again = await cli(box, ["import", path]);
  assert.equal(again.exitCode, 1);
  assert.match(again.err, /already imported/);
  assert.match(again.err, /never rewrites history/);

  assert.equal(box.read().listSessions().length, 1);
});

test("inspect lists what has been imported", async (t) => {
  const box = sandbox(t);
  const path = box.file("session.jsonl", FIXTURE);

  const empty = await cli(box, ["inspect"]);
  assert.equal(empty.exitCode, 1);
  assert.match(empty.err, /No Chronos database/);

  await cli(box, ["import", path]);

  const list = await cli(box, ["inspect"]);
  assert.equal(list.exitCode, 0);
  assert.match(list.out, /^SESSION\s+SOURCE\s+CREATED\s+BRANCHES\s+EVENTS/m);
  assert.match(list.out, /s_upload\s+chronos-jsonl\s+\S+\s+2\s+6/);

  const json = JSON.parse((await cli(box, ["inspect", "--json"])).out);
  assert.deepEqual(json.sessions, [
    {
      id: "s_upload",
      source: "chronos-jsonl",
      createdAt: "2026-08-09T00:00:00Z",
      branches: 2,
      events: 6,
    },
  ]);
});

test("inspect describes a session's lineage", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const overview = await cli(box, ["inspect", "s_upload"]);
  assert.equal(overview.exitCode, 0);
  assert.match(overview.out, /Session s_upload/);
  assert.match(overview.out, /b_root\s+ready\s+\(root\)\s+4\s+1/);
  assert.match(overview.out, /b_retry\s+ready\s+b_root@3\s+2\s+1/);

  const missing = await cli(box, ["inspect", "nope"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err, /No such session: nope/);
});

test("inspect shows a branch timeline with inherited history", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const timeline = await cli(box, ["inspect", "--branch", "b_retry"]);
  assert.equal(timeline.exitCode, 0);
  assert.match(timeline.out, /Branch b_retry \(5 events visible\)/);
  assert.match(timeline.out, /instruction \(inherited\)/);
  assert.match(timeline.out, /\* marks an event a branch can be created from/);

  const json = JSON.parse(
    (await cli(box, ["inspect", "--branch", "b_retry", "--json"])).out,
  );
  assert.deepEqual(
    json.events.map((event) => [event.seq, event.inherited, event.branchable]),
    [
      [1, true, false],
      [2, true, false],
      [3, true, true],
      [4, false, true],
      [5, false, true],
    ],
  );
  assert.equal(json.events[0].reason, "no_checkpoint");
  assert.equal(json.events[2].reason, undefined);
});

test("a timeline pages and validates its window", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const firstPage = await cli(box, [
    "inspect",
    "--branch",
    "b_retry",
    "--limit",
    "2",
    "--json",
  ]);
  assert.deepEqual(
    JSON.parse(firstPage.out).events.map((event) => event.seq),
    [1, 2],
  );

  const secondPage = await cli(box, [
    "inspect",
    "--branch",
    "b_retry",
    "--from",
    "3",
    "--json",
  ]);
  assert.deepEqual(
    JSON.parse(secondPage.out).events.map((event) => event.seq),
    [3, 4, 5],
  );

  assert.match(
    (await cli(box, ["inspect", "--branch", "b_retry", "--limit", "2"])).out,
    /continue with --from 3/,
  );

  for (const bad of [
    ["--limit", "0"],
    ["--limit", "5000"],
    ["--from", "0"],
    ["--from", "x"],
  ]) {
    const response = await cli(box, ["inspect", "--branch", "b_retry", ...bad]);
    assert.equal(response.exitCode, 2, bad.join(" "));
  }

  const unknownBranch = await cli(box, ["inspect", "--branch", "nope"]);
  assert.equal(unknownBranch.exitCode, 1);
});

test("inspect shows one event without running anything", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const detail = await cli(box, ["inspect", "--event", "e2"]);
  assert.equal(detail.exitCode, 0);
  assert.match(detail.out, /Event e2/);
  assert.match(detail.out, /kind {6}tool_call/);
  assert.match(detail.out, /"path": "src\/upload\.ts"/);
  assert.match(detail.out, /Chronos displays it and never runs it/);

  const missing = await cli(box, ["inspect", "--event", "nope"]);
  assert.equal(missing.exitCode, 1);

  const conflicting = await cli(box, [
    "inspect",
    "--event",
    "e2",
    "--branch",
    "b_root",
  ]);
  assert.equal(conflicting.exitCode, 2);
});

test("serve runs the API until it is asked to stop", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const stopping = new AbortController();
  const running = cli(box, ["serve", "--json"], stopping.signal);

  // The server is up as soon as the result is printed, so read it by polling
  // the promise's resolution rather than guessing at a delay.
  const finished = (async () => {
    const result = await running;
    return JSON.parse(result.out.split("\n").slice(0).join("\n"));
  })();

  stopping.abort();
  const served = await finished;

  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(served.host, "127.0.0.1");
  assert.equal(served.token.length >= 32, true);
  assert.equal(
    served.browserUrl,
    `${served.url}/?token=${encodeURIComponent(served.token)}`,
  );
  assert.equal(served.databasePath, join(box.home, "chronos.sqlite"));
  assert.equal(served.workspacesRoot, join(box.home, "workspaces"));
});

test("serve answers the API it advertises", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", box.file("session.jsonl", FIXTURE)]);

  const stopping = new AbortController();
  const out = [];
  const running = run(["serve", "--json"], {
    streams: {
      write: (text) => out.push(text),
      writeError: () => undefined,
    },
    cwd: box.root,
    env: { CHRONOS_HOME: box.home },
    signal: stopping.signal,
  });

  // Wait for the server to advertise itself before calling it.
  while (out.length === 0) await delay(5);
  const served = JSON.parse(out.join(""));

  const sessions = await fetch(`${served.url}/sessions`, {
    headers: { authorization: `Bearer ${served.token}` },
  });
  assert.equal(sessions.status, 200);
  assert.deepEqual(
    (await sessions.json()).items.map((item) => item.id),
    ["s_upload"],
  );

  const unauthorized = await fetch(`${served.url}/sessions`);
  assert.equal(unauthorized.status, 401);

  const page = await fetch(served.browserUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Chronos — Session Instrument/);

  stopping.abort();
  assert.equal(await running, 0);

  // The port is released once the command returns.
  await assert.rejects(() => fetch(`${served.url}/sessions`));
});

test("serve reports a port it cannot use", async (t) => {
  const box = sandbox(t);

  const badPort = await cli(box, ["serve", "--port", "99999"]);
  assert.equal(badPort.exitCode, 2);
  assert.match(badPort.err, /--port must be an integer/);
});

/**
 * A session whose checkpoint really does address a captured workspace, so
 * branching from it reconstructs real files rather than a fixture stub.
 */
function branchable(box) {
  const workspace = join(box.root, "project");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "upload.ts"),
    "export const retries = 0;\n",
  );
  writeFileSync(join(workspace, "README.md"), "# upload\n");

  mkdirSync(box.home, { recursive: true });
  const store = new ContentStore({ root: join(box.home, "store") });
  const { manifest } = captureWorkspace({ workspaceRoot: workspace, store });
  const manifestRef = store.put(
    new Uint8Array(Buffer.from(serializeManifest(manifest), "utf8")),
  );

  return box.file(
    "branchable.jsonl",
    [
      `{"type":"session","schemaVersion":1,"id":"s_live","source":"fixture","createdAt":"2026-08-09T00:00:00Z"}`,
      `{"type":"branch","schemaVersion":1,"id":"b_root"}`,
      `{"type":"event","schemaVersion":1,"id":"e1","branchId":"b_root","seq":1,"kind":"instruction","occurredAt":"2026-08-09T00:00:00Z","summary":"add retries","payload":{"text":"add retries"}}`,
      `{"type":"event","schemaVersion":1,"id":"e2","branchId":"b_root","seq":2,"kind":"filesystem_change","occurredAt":"2026-08-09T00:00:05Z","summary":"wrote src/upload.ts","payload":{"paths":["src/upload.ts"]}}`,
      `{"type":"checkpoint","schemaVersion":1,"id":"cp2","branchId":"b_root","eventSeq":2,"manifestRef":"${manifestRef}"}`,
      `{"type":"event","schemaVersion":1,"id":"e3","branchId":"b_root","seq":3,"kind":"assistant_message","occurredAt":"2026-08-09T00:00:09Z","summary":"used a fixed sleep","payload":{"text":"used a fixed sleep"}}`,
    ].join("\n"),
  );
}

test("branch forks a session and reconstructs its workspace", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const created = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "2",
    "--instruction",
    "use a real backoff instead of a sleep",
    "--id",
    "retry",
    "--json",
  ]);
  assert.equal(created.exitCode, 0);

  const result = JSON.parse(created.out);
  assert.deepEqual(result.branch, {
    id: "retry",
    sessionId: "s_live",
    parentId: "b_root",
    forkSeq: 2,
    state: "ready",
  });
  assert.equal(
    result.launchPlan.workspacePath,
    join(box.home, "workspaces", "retry"),
  );
  assert.equal(result.launchPlan.context.length, 2);

  // The reconstructed workspace holds the real files, isolated from the source.
  assert.equal(
    readFileSync(
      join(result.launchPlan.workspacePath, "src", "upload.ts"),
      "utf8",
    ),
    "export const retries = 0;\n",
  );

  // The branch is visible to inspect, with the instruction as its own event.
  const timeline = JSON.parse(
    (await cli(box, ["inspect", "--branch", "retry", "--json"])).out,
  );
  assert.deepEqual(
    timeline.events.map((item) => [item.seq, item.inherited, item.kind]),
    [
      [1, true, "instruction"],
      [2, true, "filesystem_change"],
      [3, false, "instruction"],
    ],
  );
});

test("branch says plainly that it has run nothing", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const created = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "2",
    "--instruction",
    "try the other fix",
  ]);
  assert.equal(created.exitCode, 0);
  assert.match(created.out, /Created branch \S+ from b_root@2/);
  assert.match(created.out, /Chronos has run nothing/);
});

test("branch refuses an event with no reconstructable state", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const tooEarly = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "1",
    "--instruction",
    "branch before the checkpoint",
  ]);
  assert.equal(tooEarly.exitCode, 1);
  assert.match(tooEarly.err, /cannot reconstruct a workspace/);
  assert.match(tooEarly.err, /marked with \*/);

  // Only the root branch exists; the refused attempt created no lineage.
  const overview = JSON.parse(
    (await cli(box, ["inspect", "s_live", "--json"])).out,
  );
  assert.deepEqual(
    overview.branches.map((branch) => branch.id),
    ["b_root"],
  );
});

test("branch validates what it was asked to do", async (t) => {
  const box = sandbox(t);
  await cli(box, ["import", branchable(box)]);

  const noAt = await cli(box, ["branch", "s_live", "--instruction", "x"]);
  assert.equal(noAt.exitCode, 2);
  assert.match(noAt.err, /--at is required/);

  const noInstruction = await cli(box, ["branch", "s_live", "--at", "2"]);
  assert.equal(noInstruction.exitCode, 2);
  assert.match(noInstruction.err, /--instruction is required/);

  const badAt = await cli(box, [
    "branch",
    "s_live",
    "--at",
    "0",
    "--instruction",
    "x",
  ]);
  assert.equal(badAt.exitCode, 2);

  const unknownSession = await cli(box, [
    "branch",
    "nope",
    "--at",
    "2",
    "--instruction",
    "x",
  ]);
  assert.equal(unknownSession.exitCode, 1);
  assert.match(unknownSession.err, /No such session: nope/);

  const unknownParent = await cli(box, [
    "branch",
    "s_live",
    "--from",
    "nope",
    "--at",
    "2",
    "--instruction",
    "x",
  ]);
  assert.equal(unknownParent.exitCode, 1);
});
