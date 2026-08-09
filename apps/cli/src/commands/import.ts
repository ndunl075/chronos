import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { chronosJsonlAdapter, AdapterError } from "@chronos/adapters";
import { ChronosRepository, StorageError, openStorage } from "@chronos/storage";

import {
  booleanFlag,
  requiredPositional,
  type CommandSpec,
  type ParsedArgs,
} from "../args.js";
import { failure } from "../errors.js";
import { ensureHome, type ChronosHome } from "../home.js";
import type { Reporter } from "../output.js";

export const importSpec: CommandSpec = {
  name: "import",
  summary:
    "Import a Chronos JSONL session file into the local database. Canonical data is redacted on the way in.",
  positionals: [
    { name: "file", required: true, description: "Path to a .jsonl session" },
  ],
  flags: {
    home: { type: "string", description: "Chronos home directory" },
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
  const source = read(file);
  const redact = !booleanFlag(args, "no-redact");

  let imported;
  try {
    imported = chronosJsonlAdapter.parse(source, {
      retainRaw: booleanFlag(args, "retain-raw"),
      ...(redact ? {} : { redaction: null }),
    });
  } catch (error) {
    if (error instanceof AdapterError) {
      failure(
        `${file} could not be imported: ${error.message}`,
        "See docs/formats/chronos-jsonl.md for the accepted record shapes",
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

function report(
  imported: ReturnType<typeof chronosJsonlAdapter.parse>,
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
  try {
    return readFileSync(file, "utf8");
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
}
