import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  chronosJsonlAdapter,
  codexJsonlAdapter,
  claudeJsonlAdapter,
  AdapterError,
  type SessionAdapter,
  DEFAULT_PROVIDER_MAX_INPUT_LENGTH,
} from "@chronos/adapters";
import { ChronosRepository, StorageError, openStorage } from "@chronos/storage";

import {
  booleanFlag,
  requiredPositional,
  stringFlag,
  type CommandSpec,
  type ParsedArgs,
} from "../args.js";
import { failure } from "../errors.js";
import { ensureHome, type ChronosHome } from "../home.js";
import type { Reporter } from "../output.js";

export const importSpec: CommandSpec = {
  name: "import",
  summary:
    "Import a Chronos, Codex, or Claude Code JSONL session. Canonical data is redacted on the way in.",
  positionals: [
    { name: "file", required: true, description: "Path to a .jsonl session" },
  ],
  flags: {
    home: { type: "string", description: "Chronos home directory" },
    format: {
      type: "string",
      description:
        "Source format: chronos, codex, or claude (default: chronos)",
    },
    json: { type: "boolean", description: "Print the result as JSON" },
    "retain-raw": {
      type: "boolean",
      description: "Keep references to raw provider data (off by default)",
    },
    "no-redact": {
      type: "boolean",
      description: "Store canonical data exactly as written (not recommended)",
    },
  },
};

export interface CommandContext {
  readonly home: ChronosHome;
  readonly reporter: Reporter;
  readonly cwd: string;
  /** Aborted when the caller asks a long-running command to stop. */
  readonly signal: AbortSignal | undefined;
  /** Test/integration seam for deterministic provider processes. */
  readonly providerExecutor?: import("./record.js").ProviderExecutor;
  /** Test seam: must already be an absolute canonical regular file. */
  readonly providerExecutable?: string;
}

/**
 * Read a session file, normalize it, and store it.
 *
 * Nothing is written until the whole file parses: a half-imported session
 * would look like a complete transcript that simply ended early, which is
 * exactly the illusion Chronos exists to prevent.
 */
export function runImport(args: ParsedArgs, context: CommandContext): void {
  const file = resolve(context.cwd, requiredPositional(args, 0, "file"));
  const redact = !booleanFlag(args, "no-redact");
  const adapter = selectAdapter(stringFlag(args, "format") ?? "chronos");

  if (booleanFlag(args, "retain-raw")) {
    failure(
      "Raw retention is unavailable in Chronos v0.1",
      "An encrypted restricted raw store has not been implemented",
    );
  }
  const source = read(file);

  let imported;
  try {
    imported = adapter.parse(source, {
      ...(redact ? {} : { redaction: null }),
    });
  } catch (error) {
    if (error instanceof AdapterError) {
      failure(
        `${file} could not be imported: ${error.message}`,
        `See ${adapter.documentation} for the accepted record shapes`,
      );
    }
    throw error;
  }

  const home = ensureHome(context.home);
  const storage = openStorage({ path: home.databasePath });
  try {
    const repository = new ChronosRepository(storage);
    if (repository.getSession(imported.session.id) !== undefined) {
      failure(
        `Session ${imported.session.id} is already imported`,
        "Chronos never rewrites history; import the session under a new id instead",
      );
    }
    repository.transaction(() => {
      repository.insertSession(imported.session);
      for (const branch of imported.branches) repository.insertBranch(branch);
      repository.appendEvents(imported.events);
      for (const checkpoint of imported.checkpoints) {
        repository.insertCheckpoint(checkpoint);
      }
    });
  } catch (error) {
    if (error instanceof StorageError) {
      failure(`${file} could not be stored: ${error.message}`);
    }
    throw error;
  } finally {
    storage.close();
  }

  report(imported, context.reporter, home);
}

function selectAdapter(format: string): SessionAdapter {
  if (format === "chronos") return chronosJsonlAdapter;
  if (format === "codex") return codexJsonlAdapter;
  if (format === "claude") return claudeJsonlAdapter;
  failure(
    `Unknown import format: ${format}`,
    "--format must be chronos, codex, or claude",
  );
}

function report(
  imported: ReturnType<SessionAdapter["parse"]>,
  reporter: Reporter,
  home: ChronosHome,
): void {
  for (const diagnostic of imported.diagnostics) {
    const where =
      diagnostic.line === undefined ? "" : ` (line ${String(diagnostic.line)})`;
    reporter.warn(`${diagnostic.message}${where}`);
  }

  reporter.line(
    `Imported session ${imported.session.id} from ${imported.session.source}`,
  );
  reporter.line(`  branches     ${String(imported.branches.length)}`);
  reporter.line(`  events       ${String(imported.events.length)}`);
  reporter.line(`  checkpoints  ${String(imported.checkpoints.length)}`);
  reporter.line(`  database     ${home.databasePath}`);
  if (imported.checkpoints.length === 0) {
    reporter.line();
    reporter.line(
      "No checkpoints were imported, so no event can be branched from yet.",
    );
  }

  reporter.result({
    sessionId: imported.session.id,
    source: imported.session.source,
    branches: imported.branches.length,
    events: imported.events.length,
    checkpoints: imported.checkpoints.length,
    databasePath: home.databasePath,
    diagnostics: imported.diagnostics,
  });
}

function read(file: string): string {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
    failure(
      `Could not read ${file}`,
      code === "ENOENT" ? "The file does not exist" : code,
    );
  }
  if (size > DEFAULT_PROVIDER_MAX_INPUT_LENGTH) {
    failure(
      `Could not read ${file}`,
      `The file exceeds the ${String(DEFAULT_PROVIDER_MAX_INPUT_LENGTH)} byte import limit`,
    );
  }
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
    failure(`Could not read ${file}`, code);
  }
}
