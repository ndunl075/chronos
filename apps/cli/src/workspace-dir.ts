import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { failure } from "./errors.js";

/**
 * Safely create, or reuse, a workspace's reserved `.chronos/` directory.
 *
 * Both `record` (instruction files) and `launch` (replay files) write
 * artifacts here, and both need the same guarantee: the directory Chronos
 * writes into is a real directory it controls the mode of, never a symlink
 * planted to redirect that write somewhere else. Path policy excludes this
 * directory from every capture, so nothing written here ever becomes
 * workspace state.
 */
export function ensureChronosDir(workspace: string): string {
  const directory = join(workspace, ".chronos");
  try {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "EEXIST")
      failure("Could not create the workspace .chronos directory");
  }
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    failure("Workspace .chronos must be a real directory");
  chmodSync(directory, 0o700);
  return directory;
}
