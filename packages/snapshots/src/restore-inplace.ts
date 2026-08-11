import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { captureWorkspace } from "./capture.js";
import { fail } from "./errors.js";
import { verifyManifest, type SnapshotManifest } from "./manifest.js";
import { workspacePath } from "./paths.js";
import { ContentStore, contains, io, isDirectory } from "./store.js";

export interface InPlaceRestoreOptions {
  readonly manifest: SnapshotManifest;
  readonly store: ContentStore;
  /**
   * Existing workspace to rewrite. Excluded paths (`.git/`, `.env`,
   * `.chronos/`, …) are left untouched; only policy-included files change.
   */
  readonly workspaceRoot: string;
}

export interface InPlaceRestoreResult {
  readonly workspacePath: string;
  readonly manifestRef: string;
  readonly filesWritten: number;
  readonly filesRemoved: number;
  readonly bytesWritten: number;
}

/**
 * Rewrite an existing workspace to match a snapshot, without touching excluded
 * paths.
 *
 * Unlike {@link restoreSnapshot}, this is for rollback into the live project
 * directory. It is best-effort rather than all-or-nothing: files are written
 * before removals so a crash mid-restore tends to leave extra files rather
 * than delete the only copy. Callers that need isolation should keep using
 * {@link restoreSnapshot} into an empty target.
 */
export function restoreSnapshotInPlace(
  options: InPlaceRestoreOptions,
): InPlaceRestoreResult {
  const store = options.store;
  if (!(store instanceof ContentStore)) {
    fail("INVALID_OPTIONS", "An in-place restore needs a content store");
  }
  const manifest = verifyManifest(options.manifest);
  const workspaceRoot = resolve(
    requiredPath(options.workspaceRoot, "workspaceRoot"),
  );
  if (!existsSync(workspaceRoot) || !isDirectory(workspaceRoot)) {
    fail("INVALID_OPTIONS", "The workspace root must be an existing directory", {
      workspaceRoot,
    });
  }

  const current = captureWorkspace({ workspaceRoot, store });
  const targetFiles = new Map(
    manifest.files.map((file) => [file.path, file] as const),
  );
  let bytesWritten = 0;
  let filesWritten = 0;

  for (const directory of manifest.directories) {
    const relative = workspacePath(directory).value;
    const absolute = withinWorkspace(workspaceRoot, relative);
    io(
      () => mkdirSync(absolute, { recursive: true }),
      `The directory could not be restored: ${relative}`,
    );
  }

  for (const file of manifest.files) {
    const relative = workspacePath(file.path).value;
    const bytes = store.get(file.digest);
    if (bytes.byteLength !== file.size) {
      fail("DIGEST_MISMATCH", `Blob size does not match the manifest`, {
        path: relative,
        expected: file.size,
        found: bytes.byteLength,
      });
    }
    const absolute = withinWorkspace(workspaceRoot, relative);
    io(() => {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
      if (process.platform !== "win32") {
        chmodSync(absolute, file.mode === "executable" ? 0o755 : 0o644);
      }
    }, `The file could not be restored: ${relative}`);
    filesWritten += 1;
    bytesWritten += bytes.byteLength;
  }

  let filesRemoved = 0;
  for (const file of current.manifest.files) {
    if (targetFiles.has(file.path)) continue;
    const relative = workspacePath(file.path).value;
    const absolute = withinWorkspace(workspaceRoot, relative);
    if (!existsSync(absolute)) continue;
    io(() => unlinkSync(absolute), `The file could not be removed: ${relative}`);
    filesRemoved += 1;
  }

  // Drop empty directories that the target no longer lists, deepest first.
  const targetDirs = new Set(manifest.directories);
  const obsoleteDirs = current.manifest.directories
    .filter((directory) => !targetDirs.has(directory))
    .map((directory) => workspacePath(directory).value)
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const relative of obsoleteDirs) {
    const absolute = withinWorkspace(workspaceRoot, relative);
    try {
      rmSync(absolute, { recursive: false });
    } catch {
      // Still holds excluded or leftover entries — leave it.
    }
  }

  return Object.freeze({
    workspacePath: workspaceRoot,
    manifestRef: manifest.ref,
    filesWritten,
    filesRemoved,
    bytesWritten,
  });
}

function withinWorkspace(workspaceRoot: string, relative: string): string {
  const absolute = resolve(join(workspaceRoot, ...relative.split("/")));
  if (!contains(workspaceRoot, absolute) || absolute === workspaceRoot) {
    fail(
      "UNSAFE_LOCATION",
      `A manifest path escapes the workspace: ${relative}`,
      { path: relative },
    );
  }
  return absolute;
}

function requiredPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_OPTIONS", `${label} is required`);
  }
  return value;
}
