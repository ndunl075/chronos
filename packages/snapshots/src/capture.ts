import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { join, resolve } from "node:path";

import { fail } from "./errors.js";
import {
  buildManifest,
  resolveManifestLimits,
  type ManifestFileInput,
  type ManifestLimits,
  type ResolvedManifestLimits,
  type SnapshotManifest,
} from "./manifest.js";
import {
  DEFAULT_PATH_POLICY,
  classifyPath,
  type EntryKind,
  type ExclusionReason,
  type PathPolicy,
} from "./policy.js";
import type { PathLimits } from "./paths.js";
import {
  ContentStore,
  canonicalizePotentialPath,
  contains,
  io,
  isDirectory,
} from "./store.js";

export interface CaptureOptions {
  /** The workspace to snapshot. It is only read, never written. */
  readonly workspaceRoot: string;
  readonly store: ContentStore;
  readonly policy?: PathPolicy;
  readonly limits?: ManifestLimits & { readonly path?: PathLimits };
}

export interface ExcludedEntry {
  readonly path: string;
  readonly reason: ExclusionReason;
  readonly pattern?: string;
  readonly detail?: string;
}

export interface CaptureResult {
  readonly manifest: SnapshotManifest;
  /** Everything the walk deliberately left out, so a user can see the gaps. */
  readonly excluded: readonly ExcludedEntry[];
}

/**
 * Walk a workspace and record it as a manifest plus blobs.
 *
 * Symbolic links are never followed and never captured: following one leaves
 * the workspace, and recording one would restore a link whose target may not
 * exist on the restoring host. Excluded directories are not descended into at
 * all, which is what keeps a capture cheap enough to take after every
 * mutating tool call.
 */
export function captureWorkspace(options: CaptureOptions): CaptureResult {
  const store = options.store;
  if (!(store instanceof ContentStore)) {
    fail("INVALID_OPTIONS", "A capture needs a content store");
  }
  const requestedRoot = resolve(requiredPath(options.workspaceRoot));
  const workspaceRoot = canonicalizePotentialPath(requestedRoot);
  if (!isDirectory(workspaceRoot)) {
    fail("IO_FAILED", `The workspace is not a directory: ${workspaceRoot}`);
  }
  store.assertOutside(workspaceRoot);

  const policy = options.policy ?? DEFAULT_PATH_POLICY;
  const limits = options.limits ?? {};
  // Resolved once, up front, so the walk enforces the exact same defaults
  // buildManifest would otherwise only discover after every file underneath
  // them was already read, hashed, and written into the content store.
  const resolvedLimits = resolveManifestLimits(limits);
  const files: ManifestFileInput[] = [];
  const directories: string[] = [];
  const excluded: ExcludedEntry[] = [];

  walk(workspaceRoot, [], {
    root: workspaceRoot,
    store,
    policy,
    limits,
    resolvedLimits,
    files,
    directories,
    excluded,
    totalBytes: 0,
  });

  return Object.freeze({
    manifest: buildManifest({ files, directories }, limits),
    excluded: Object.freeze(excluded),
  });
}

interface WalkContext {
  readonly root: string;
  readonly store: ContentStore;
  readonly policy: PathPolicy;
  readonly limits: ManifestLimits & { readonly path?: PathLimits };
  readonly resolvedLimits: ResolvedManifestLimits;
  readonly files: ManifestFileInput[];
  readonly directories: string[];
  readonly excluded: ExcludedEntry[];
  /** Running total of captured bytes, checked before each file is read. */
  totalBytes: number;
}

function walk(
  root: string,
  segments: readonly string[],
  context: WalkContext,
): void {
  const absolute = segments.length === 0 ? root : join(root, ...segments);
  assertSafeDirectory(root, absolute);
  const entries = io(
    () => readdirSync(absolute, { withFileTypes: true }),
    `The workspace directory could not be read: ${absolute}`,
  ).sort((left, right) => (left.name < right.name ? -1 : 1));

  let captured = 0;
  for (const entry of entries) {
    const childSegments = [...segments, entry.name];
    const path = childSegments.join("/");
    const kind = entryKind(entry);
    const decision = classifyPath(
      path,
      kind,
      context.policy,
      context.limits.path,
    );
    if (!decision.included) {
      context.excluded.push(
        Object.freeze({
          path,
          reason: decision.reason,
          ...(decision.pattern === undefined
            ? {}
            : { pattern: decision.pattern }),
          ...(decision.detail === undefined ? {} : { detail: decision.detail }),
        }),
      );
      continue;
    }
    captured += 1;
    if (kind === "directory") {
      walk(root, childSegments, context);
      continue;
    }
    if (context.files.length >= context.resolvedLimits.maxFiles) {
      fail("LIMIT_EXCEEDED", "Snapshot holds too many files", {
        files: context.files.length + 1,
        maxFiles: context.resolvedLimits.maxFiles,
      });
    }
    captureFile(join(root, ...childSegments), path, context);
  }

  // A directory that captured nothing still has to exist after a restore.
  if (captured === 0 && segments.length > 0) {
    context.directories.push(segments.join("/"));
  }
}

function captureFile(
  absolute: string,
  path: string,
  context: WalkContext,
): void {
  const beforePath = inspectFilePath(absolute, path, context);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = io(
    () => openSync(absolute, constants.O_RDONLY | noFollow),
    `The file could not be opened without following links: ${path}`,
  );
  try {
    const before = io(
      () => fstatSync(fd, { bigint: true }),
      `The opened file could not be inspected: ${path}`,
    );
    requireRegular(before, path);
    requireSameIdentity(beforePath.stats, before, path);
    assertOpenedFileContained(fd, absolute, path, context);
    const { maxFileBytes, maxTotalBytes } = context.resolvedLimits;
    if (before.size > BigInt(maxFileBytes)) {
      fail("LIMIT_EXCEEDED", `File exceeds the size cap: ${path}`, {
        path,
        size: Number(before.size),
        maxFileBytes,
      });
    }
    // Checked before the read, not after: a workspace that would blow the
    // total cap must not have its remaining bytes read, hashed, and written
    // into the content store first.
    if (context.totalBytes + Number(before.size) > maxTotalBytes) {
      fail("LIMIT_EXCEEDED", "Snapshot exceeds the total size cap", {
        maxTotalBytes,
      });
    }
    const bytes = io(
      () => new Uint8Array(readFileSync(fd)),
      `The file could not be read: ${path}`,
    );
    const after = io(
      () => fstatSync(fd, { bigint: true }),
      `The opened file could not be re-inspected: ${path}`,
    );
    requireStable(before, after, bytes.byteLength, path);
    const afterPath = inspectFilePath(absolute, path, context);
    requireSameIdentity(before, afterPath.stats, path);
    assertOpenedFileContained(fd, absolute, path, context);
    context.files.push({
      path,
      mode: fileMode(Number(before.mode)),
      size: bytes.byteLength,
      digest: context.store.put(bytes),
    });
    context.totalBytes += bytes.byteLength;
  } finally {
    closeSync(fd);
  }
}

function assertSafeDirectory(root: string, absolute: string): void {
  const stats = io(
    () => lstatSync(absolute),
    `The workspace directory could not be inspected: ${absolute}`,
  );
  if (!stats.isDirectory() || stats.isSymbolicLink())
    fail(
      "IO_FAILED",
      `Workspace directory is not a real directory: ${absolute}`,
    );
  const canonical = io(
    () => realpathSync.native(absolute),
    `The workspace directory could not be canonicalized: ${absolute}`,
  );
  if (!contains(root, canonical))
    fail("UNSAFE_LOCATION", "Workspace traversal escaped its canonical root");
}

function inspectFilePath(
  absolute: string,
  path: string,
  context: WalkContext,
): { readonly stats: BigIntStats; readonly canonical: string } {
  const stats = io(
    () => lstatSync(absolute, { bigint: true }),
    `The file could not be inspected: ${path}`,
  );
  requireRegular(stats, path);
  if (stats.isSymbolicLink())
    fail("UNSAFE_LOCATION", `A symbolic link cannot be captured: ${path}`);
  const canonical = io(
    () => realpathSync.native(absolute),
    `The file could not be canonicalized: ${path}`,
  );
  if (!contains(context.root, canonical))
    fail("UNSAFE_LOCATION", `A file escaped the workspace: ${path}`);
  return { stats, canonical };
}

function requireRegular(stats: BigIntStats, path: string): void {
  if (!stats.isFile())
    fail("IO_FAILED", `Workspace entry is not a regular file: ${path}`);
}

function requireSameIdentity(
  left: BigIntStats,
  right: BigIntStats,
  path: string,
): void {
  if (left.dev !== right.dev || left.ino !== right.ino)
    fail("IO_FAILED", `File identity changed during capture: ${path}`);
}

function requireStable(
  before: BigIntStats,
  after: BigIntStats,
  bytes: number,
  path: string,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.size !== BigInt(bytes)
  ) {
    fail("IO_FAILED", `File changed while it was captured: ${path}`);
  }
}

function assertOpenedFileContained(
  fd: number,
  absolute: string,
  path: string,
  context: WalkContext,
): void {
  let canonical: string;
  try {
    canonical =
      process.platform === "linux"
        ? realpathSync.native(`/proc/self/fd/${String(fd)}`)
        : realpathSync.native(absolute);
  } catch {
    fail("IO_FAILED", `The opened file could not be canonicalized: ${path}`);
  }
  if (!contains(context.root, canonical))
    fail("UNSAFE_LOCATION", `An opened file escaped the workspace: ${path}`);
}

/**
 * Windows does not carry a POSIX executable bit, so a capture there records
 * every file as a plain file. That is a declared limitation, not a silent
 * one: the manifest says what it captured, and a restore honours it.
 */
function fileMode(mode: number): "file" | "executable" {
  if (process.platform === "win32") return "file";
  return (mode & 0o111) === 0 ? "file" : "executable";
}

function entryKind(entry: Dirent): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

function requiredPath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_OPTIONS", "A workspace path is required");
  }
  return value;
}
