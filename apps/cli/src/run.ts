import {
  booleanFlag,
  helpText,
  parseArgs,
  stringFlag,
  type CommandSpec,
  type ParsedArgs,
} from "./args.js";
import { CliError, EXIT_OK, EXIT_USAGE, usageError } from "./errors.js";
import {
  importSpec,
  runImport,
  type CommandContext,
} from "./commands/import.js";
import { branchSpec, runBranch } from "./commands/branch.js";
import { inspectSpec, runInspect } from "./commands/inspect.js";
import { runServe, serveSpec } from "./commands/serve.js";
import { recordSpec, runRecord } from "./commands/record.js";
import { launchSpec, runLaunch } from "./commands/launch.js";
import { resolveHome } from "./home.js";
import { Reporter, table, type Streams } from "./output.js";

export const CLI_VERSION = "0.2.0";

type CommandRunner = (
  args: ParsedArgs,
  context: CommandContext,
) => void | Promise<void>;

interface Command {
  readonly spec: CommandSpec;
  readonly run: CommandRunner;
}

const COMMANDS: readonly Command[] = Object.freeze([
  { spec: importSpec, run: runImport },
  { spec: recordSpec, run: runRecord },
  { spec: inspectSpec, run: runInspect },
  { spec: serveSpec, run: runServe },
  { spec: branchSpec, run: runBranch },
  { spec: launchSpec, run: runLaunch },
]);

export interface RunEnvironment {
  readonly streams: Streams;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborted to ask a long-running command, such as serve, to stop. */
  readonly signal?: AbortSignal;
  /** Test/integration seam; normal CLI invocations use child_process.spawn. */
  readonly providerExecutor?: import("./commands/record.js").ProviderExecutor;
  /** Test-only canonical executable seam used to exercise replacement checks. */
  readonly providerExecutable?: string;
  /** Test/integration seam; normal CLI invocations use child_process.spawn. */
  readonly launchExecutor?: import("./commands/launch.js").LaunchExecutor;
}

/**
 * Run one invocation and return its exit code.
 *
 * The entry point never throws: a failure is a message on stderr and a code,
 * because a stack trace tells a user nothing they can act on.
 */
export async function run(
  argv: readonly string[],
  environment: RunEnvironment,
): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "help") {
    environment.streams.write(`${overview()}\n`);
    return EXIT_OK;
  }
  if (name === "--version") {
    environment.streams.write(`${CLI_VERSION}\n`);
    return EXIT_OK;
  }

  const command = COMMANDS.find((candidate) => candidate.spec.name === name);
  try {
    if (command === undefined) {
      usageError(
        `Unknown command: ${name}`,
        `Run "chronos --help" to see the available commands`,
      );
    }
    if (rest.includes("--help")) {
      environment.streams.write(`${helpText(command.spec)}\n`);
      return EXIT_OK;
    }
    const args = parseArgs(command.spec, rest);
    const reporter = new Reporter(
      environment.streams,
      booleanFlag(args, "json"),
    );
    await command.run(args, {
      home: resolveHome(stringFlag(args, "home"), {
        cwd: environment.cwd,
        env: environment.env,
      }),
      reporter,
      cwd: environment.cwd,
      signal: environment.signal,
      ...(environment.providerExecutor === undefined
        ? {}
        : { providerExecutor: environment.providerExecutor }),
      ...(environment.providerExecutable === undefined
        ? {}
        : { providerExecutable: environment.providerExecutable }),
      ...(environment.launchExecutor === undefined
        ? {}
        : { launchExecutor: environment.launchExecutor }),
    });
    return EXIT_OK;
  } catch (error) {
    return report(error, environment.streams);
  }
}

function report(error: unknown, streams: Streams): number {
  if (error instanceof CliError) {
    streams.writeError(`error: ${error.message}\n`);
    if (error.hint !== undefined) streams.writeError(`${error.hint}\n`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  streams.writeError(`error: ${message}\n`);
  return 1;
}

function overview(): string {
  const rows = COMMANDS.map(
    (command) =>
      [`  ${command.spec.name}`, firstSentence(command.spec.summary)] as const,
  );
  return [
    "chronos - time-travel debugging for AI coding-agent sessions",
    "",
    "Usage: chronos <command> [options]",
    "",
    "Commands:",
    ...table(rows),
    "",
    "Options:",
    ...table([
      ["  --help", "Show help for a command"],
      ["  --version", "Print the Chronos version"],
    ]),
    "",
    `Chronos stores everything under ${"$CHRONOS_HOME"} (default ~/.chronos).`,
  ].join("\n");
}

function firstSentence(summary: string): string {
  const stop = summary.indexOf(". ");
  return stop === -1 ? summary : summary.slice(0, stop + 1);
}

export { EXIT_USAGE };
