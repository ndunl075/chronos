import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { fail } from "./errors.js";
import { verifyManifest, type SnapshotManifest } from "./manifest.js";
import { workspacePath } from "./paths.js";
import { ContentStore, contains, io, isDirectory } from "./store.js";

export interface RestoreOptions {
  readonly manifest: SnapshotManifest;
  readonly store: ContentStore;
  /** Where the reconstructed workspace goes. It must not already hold files. */
  readonly targetPath: string;
  /**
   * Directory the restore is assembled in before it is moved into place.
   * Defaults to a sibling of the target so the move stays on one filesystem.
   */
  readonly stagingPath?: string;
}

export interface RestoreResult {
  readonly workspacePath: string;
  readonly manifestRef: string;
  readonly filesRestored: number;
  readonly directoriesRestored: number;
  readonly bytesRestored: number;
}

/**
 * Reconstruct a snapshot into a new directory, all or nothing.
 *
 * The workspace is assembled in a staging directory and moved into place only
 * once every blob has been read, verified against its address, and written.
 * A failure part-way through leaves the target untouched, because a workspace
 * that is half of one snapshot and half of another is worse than no workspace
 * at all. Nothing here executes anything the transcript recorded.
 */
export function restoreSnapshot(options: RestoreOptions): RestoreResult {
  const store = options.store;
  if (!(store instanceof ContentStore)) {
    fail("INVALID_OPTIONS", "A restore needs a content store");
  }
  const manifest = verifyManifest(options.manifest);
  const targetPath = resolve(requiredPath(options.targetPath, "targetPath"));
  assertEmptyTarget(targetPath);

  const stagingPath = resolve(
    options.stagingPath ??
      join(dirname(targetPath), `.chronos-restore-${randomUUID()}`),
  );
  if (existsSync(stagingPath)) {
    fail("TARGET_NOT_EMPTY", "The staging directory already exists", {
      stagingPath,
    });
  }
  if (contains(stagingPath, targetPath)) {
    fail("UNSAFE_LOCATION", "The staging directory would contain the target", {
      stagingPath,
      targetPath,
    });
  }

  let bytesRestored = 0;
  try {
    io(
      () => mkdirSync(stagingPath, { recursive: true }),
      "The staging directory could not be created",
    );
    for (const directory of manifest.directories) {
      mkdirWithin(stagingPath, workspacePath(directory).value);
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
      const absolute = withinStaging(stagingPath, relative);
      io(() => {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, bytes, { flag: "wx" });
        if (process.platform !== "win32") {
          chmodSync(absolute, file.mode === "executable" ? 0o755 : 0o644);
        }
      }, `The file could not be restored: ${relative}`);
      bytesRestored += bytes.byteLength;
    }
    io(() => {
      mkdirSync(dirname(targetPath), { recursive: true });
      renameSync(stagingPath, targetPath);
    }, "The restored workspace could not be moved into place");
  } catch (error) {
    rmSync(stagingPath, { force: true, recursive: true, maxRetries: 5 });
    throw error;
  }

  return Object.freeze({
    workspacePath: targetPath,
    manifestRef: manifest.ref,
    filesRestored: manifest.files.length,
    directoriesRestored: manifest.directories.length,
    bytesRestored,
  });
}

/**
 * A restore only ever fills a new or empty directory. Overwriting an existing
 * workspace would destroy work the user never asked Chronos to touch.
 */
function assertEmptyTarget(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  if (!isDirectory(targetPath)) {
    fail("TARGET_NOT_EMPTY", "The restore target is not a directory", {
      targetPath,
    });
  }
  const entries = io(
    () => readdirSync(targetPath),
    "The restore target could not be read",
  );
  if (entries.length > 0) {
    fail("TARGET_NOT_EMPTY", "The restore target is not empty", {
      targetPath,
      entries: entries.length,
    });
  }
  // An existing empty directory is removed so the staging move can claim it.
  io(
    () => rmSync(targetPath, { recursive: true }),
    "The empty restore target could not be replaced",
  );
}

function mkdirWithin(stagingPath: string, relative: string): void {
  const absolute = withinStaging(stagingPath, relative);
  io(
    () => mkdirSync(absolute, { recursive: true }),
    `The directory could not be restored: ${relative}`,
  );
}

/**
 * Resolve a manifest path inside the staging directory and prove it stayed
 * there. The path rules already reject traversal; this is the check that does
 * not depend on them being complete.
 */
function withinStaging(stagingPath: string, relative: string): string {
  const absolute = resolve(join(stagingPath, ...relative.split("/")));
  if (!contains(stagingPath, absolute) || absolute === stagingPath) {
    fail(
      "UNSAFE_LOCATION",
      `A manifest path escapes the workspace: ${relative}`,
      {
        path: relative,
      },
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
