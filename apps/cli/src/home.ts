import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { failure } from "./errors.js";

/**
 * Everything Chronos keeps for a user, in one directory.
 *
 * Snapshots and the database live here rather than beside an inspected
 * workspace, so capturing a repository never writes into that repository and
 * a restored branch never lands inside the workspace it forked from.
 */
export interface ChronosHome {
  readonly root: string;
  readonly databasePath: string;
  readonly storeRoot: string;
  readonly workspacesRoot: string;
}

export interface HomeEnvironment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function resolveHome(
  flag: string | undefined,
  environment: HomeEnvironment,
): ChronosHome {
  const configured = flag ?? environment.env["CHRONOS_HOME"];
  const root =
    configured === undefined
      ? join(homedir(), ".chronos")
      : isAbsolute(configured)
        ? resolve(configured)
        : resolve(environment.cwd, configured);
  return Object.freeze({
    root,
    databasePath: join(root, "chronos.sqlite"),
    storeRoot: join(root, "store"),
    workspacesRoot: join(root, "workspaces"),
  });
}

/** Create the home directory tree. Doing it twice is a no-op. */
export function ensureHome(home: ChronosHome): ChronosHome {
  try {
    assertRealDirectoryIfPresent(home.root);
    mkdirSync(home.root, { recursive: true });
    assertRealDirectoryIfPresent(home.root);
    assertRealDirectoryIfPresent(home.storeRoot);
    mkdirSync(home.storeRoot, { recursive: true });
    assertRealDirectoryIfPresent(home.storeRoot);
    assertRealDirectoryIfPresent(home.workspacesRoot);
    mkdirSync(home.workspacesRoot, { recursive: true });
    assertRealDirectoryIfPresent(home.workspacesRoot);
    chmodSync(home.root, 0o700);
    chmodSync(home.storeRoot, 0o700);
    chmodSync(home.workspacesRoot, 0o700);
  } catch (error) {
    failure(
      `Could not prepare the Chronos home directory: ${home.root}`,
      error instanceof Error ? error.message : undefined,
    );
  }
  return home;
}

function assertRealDirectoryIfPresent(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`Chronos directory is not a real directory: ${path}`);
}
