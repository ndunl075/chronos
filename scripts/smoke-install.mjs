#!/usr/bin/env node
/**
 * Source-install smoke test.
 *
 * Proves the one thing the full test suite never actually proves: that
 * after `npm install && npm run build`, the packaged `chronos` binary a
 * real user gets runs at all. Everything here spawns the built entry point
 * as a real child process, the same way a shell would, rather than
 * importing it in-process — a broken shebang, a missing `bin` file, or a
 * build that only "works" when imported would slip past every other test
 * in this repo but not this one.
 *
 * Run with `npm run smoke` (builds first) or directly once a build exists.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "apps", "cli", "dist", "main.js");

let failures = 0;

function check(label, condition) {
  if (condition) {
    process.stdout.write(`ok   - ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`FAIL - ${label}\n`);
  }
}

function chronos(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

if (!existsSync(bin)) {
  process.stderr.write(
    `error: ${bin} does not exist. Run "npm run build" first.\n`,
  );
  process.exit(1);
}

// --- the binary starts and answers, without touching anything -----------
const version = chronos(["--version"]);
check("chronos --version exits 0", version.status === 0);
check(
  "chronos --version prints a semantic version",
  /^\d+\.\d+\.\d+\s*$/.test(version.stdout),
);

const help = chronos(["--help"]);
check("chronos --help exits 0", help.status === 0);
check(
  "chronos --help lists the documented commands",
  ["import", "record", "inspect", "serve", "branch", "launch"].every(
    (command) => help.stdout.includes(command),
  ),
);

const unknown = chronos(["not-a-real-command"]);
check("an unknown command is a usage error, not a crash", unknown.status === 2);

// --- one real round trip: import a session, then read it back -----------
const root = mkdtempSync(join(tmpdir(), "chronos-smoke-"));
const home = join(root, "home");
try {
  const fixture = join(root, "session.jsonl");
  writeFileSync(
    fixture,
    [
      JSON.stringify({
        type: "session",
        schemaVersion: 1,
        id: "smoke-session",
        source: "chronos-jsonl",
        createdAt: "2026-08-09T00:00:00Z",
      }),
      JSON.stringify({ type: "branch", schemaVersion: 1, id: "root" }),
      JSON.stringify({
        type: "event",
        schemaVersion: 1,
        id: "e1",
        branchId: "root",
        seq: 1,
        kind: "instruction",
        occurredAt: "2026-08-09T00:00:00Z",
        summary: "smoke test the install",
        payload: { text: "smoke test the install" },
      }),
    ].join("\n"),
  );

  const imported = chronos(["import", fixture, "--json"], {
    CHRONOS_HOME: home,
  });
  check("a fresh install imports a session", imported.status === 0);
  let importedId;
  try {
    importedId = JSON.parse(imported.stdout).sessionId;
  } catch {
    importedId = undefined;
  }
  check("the imported session id round-trips", importedId === "smoke-session");

  const inspected = chronos(["inspect", "smoke-session", "--json"], {
    CHRONOS_HOME: home,
  });
  check("a fresh install inspects the session back", inspected.status === 0);
  check(
    "the database landed under the given home, not somewhere else",
    existsSync(join(home, "chronos.sqlite")),
  );
} finally {
  rmSync(root, { force: true, recursive: true, maxRetries: 5 });
}

if (failures > 0) {
  process.stderr.write(`\n${String(failures)} smoke check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll smoke checks passed.\n");
