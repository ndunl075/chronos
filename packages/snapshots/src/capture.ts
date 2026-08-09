import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

import { fail } from "./errors.js";
import {
  buildManifest,
  type ManifestFileInput,
  type ManifestLimits,
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
import { ContentStore, io, isDirectory } from "./store.js";

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
  const workspaceRoot = resolve(requiredPath(options.workspaceRoot));
  if (!isDirectory(workspaceRoot)) {
    fail("IO_FAILED", `The workspace is not a directory: ${workspaceRoot}`);
  }
  store.assertOutside(workspaceRoot);

  const policy = options.policy ?? DEFAULT_PATH_POLICY;
  const limits = options.limits ?? {};
  const files: ManifestFileInput[] = [];
  const directories: string[] = [];
  const excluded: ExcludedEntry[] = [];

  walk(workspaceRoot, [], {
    store,
    policy,
    limits,
    files,
    directories,
    excluded,
  });

  return Object.freeze({
    manifest: buildManifest({ files, directories }, limits),
    excluded: Object.freeze(excluded),
  });
}

interface WalkContext {
  readonly store: ContentStore;
  readonly policy: PathPolicy;
  readonly limits: ManifestLimits & { readonly path?: PathLimits };
  readonly files: ManifestFileInput[];
  readonly directories: string[];
  readonly excluded: ExcludedEntry[];
}

function walk(
  root: string,
  segments: readonly string[],
  context: WalkContext,
): void {
  const absolute = segments.length === 0 ? root : join(root, ...segments);
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
  const stats = io(
    () => statSync(absolute),
    `The file could not be inspected: ${path}`,
  );
  const maxFileBytes = context.limits.maxFileBytes;
  if (maxFileBytes !== undefined && stats.size > maxFileBytes) {
    fail("LIMIT_EXCEEDED", `File exceeds the size cap: ${path}`, {
      path,
      size: stats.size,
      maxFileBytes,
    });
  }
  const bytes = io(
    () => new Uint8Array(readFileSync(absolute)),
    `The file could not be read: ${path}`,
  );
  context.files.push({
    path,
    mode: fileMode(stats.mode),
    size: bytes.byteLength,
    digest: context.store.put(bytes),
  });
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
