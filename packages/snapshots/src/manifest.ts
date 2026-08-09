import { createHash } from "node:crypto";

import { fail } from "./errors.js";
import {
  compareWorkspacePaths,
  workspacePath,
  type PathLimits,
} from "./paths.js";

/** The manifest schema version this build writes. */
export const SNAPSHOT_MANIFEST_VERSION = 1;

export const SNAPSHOT_HASH_ALGORITHM = "sha256";

const REF_PATTERN = /^sha256:[0-9a-f]{64}$/;

const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * The file-mode semantics Chronos declares. Only the executable bit survives
 * a snapshot: it is the one permission bit that changes what a workspace
 * does, and it is the one every host Chronos targets can represent. Owners,
 * groups, and the rest of the mode are not captured and not restored.
 */
export type FileMode = "file" | "executable";

export interface ManifestFile {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly mode: FileMode;
  readonly size: number;
  /** Content address of the file's bytes. */
  readonly digest: string;
}

/**
 * A content-verifiable description of a captured workspace.
 *
 * Timestamps are deliberately absent. Chronos restores content, not mtimes,
 * so two captures of identical content produce the identical manifest and the
 * identical `ref`, which is what makes deduplication and delta comparison
 * meaningful.
 */
export interface SnapshotManifest {
  readonly version: number;
  readonly algorithm: typeof SNAPSHOT_HASH_ALGORITHM;
  /** Captured files, unique and ordered by path. */
  readonly files: readonly ManifestFile[];
  /** Directories that hold no captured file, so an empty one survives. */
  readonly directories: readonly string[];
  readonly totalBytes: number;
  /** This manifest's own content address; not part of what is hashed. */
  readonly ref: string;
}

export interface ManifestLimits {
  /** Most files in one snapshot. Defaults to 50000. */
  readonly maxFiles?: number;
  /** Largest single captured file. Defaults to 16 MiB. */
  readonly maxFileBytes?: number;
  /** Largest total capture. Defaults to 512 MiB. */
  readonly maxTotalBytes?: number;
  readonly path?: PathLimits;
}

/** `ManifestLimits` with every default filled in, ready to enforce as-is. */
export interface ResolvedManifestLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

/**
 * Fill in the defaults `buildManifest` would apply, so a caller that enforces
 * limits earlier — such as a walker deciding whether to keep reading a
 * workspace — checks the exact same numbers `buildManifest` checks last.
 */
export function resolveManifestLimits(
  limits: ManifestLimits = {},
): ResolvedManifestLimits {
  return Object.freeze({
    maxFiles: positive(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
    maxFileBytes: positive(
      limits.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    ),
    maxTotalBytes: positive(
      limits.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      "maxTotalBytes",
    ),
  });
}

export interface ManifestFileInput {
  readonly path: string;
  readonly mode?: FileMode;
  readonly size: number;
  readonly digest: string;
}

export interface ManifestInput {
  readonly files: readonly ManifestFileInput[];
  readonly directories?: readonly string[];
}

export interface ManifestChange {
  readonly before: ManifestFile;
  readonly after: ManifestFile;
}

/** What has to be applied to reach `target` from `base`. */
export interface ManifestDiff {
  readonly added: readonly ManifestFile[];
  readonly modified: readonly ManifestChange[];
  readonly removed: readonly ManifestFile[];
  readonly addedDirectories: readonly string[];
  readonly removedDirectories: readonly string[];
  readonly unchangedFiles: number;
}

/** Content address of a blob, the form every manifest digest takes. */
export function blobRef(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    fail("INVALID_MANIFEST", "A blob must be a Uint8Array");
  }
  return `sha256:${createHash(SNAPSHOT_HASH_ALGORITHM).update(bytes).digest("hex")}`;
}

export function isContentRef(value: unknown): boolean {
  return typeof value === "string" && REF_PATTERN.test(value);
}

/** Equality that also refuses anything that is not a content address. */
export function contentRefEquals(left: unknown, right: unknown): boolean {
  return isContentRef(left) && isContentRef(right) && left === right;
}

/**
 * Validate and normalize a capture into a manifest. Paths are re-checked here
 * even when a walker already checked them, because a manifest also arrives
 * from disk, from an export, and from another machine.
 */
export function buildManifest(
  input: ManifestInput,
  limits: ManifestLimits = {},
): SnapshotManifest {
  const { maxFiles, maxFileBytes, maxTotalBytes } =
    resolveManifestLimits(limits);
  const fileInputs = list(input.files, "files");
  const directoryInputs =
    input.directories === undefined
      ? []
      : list(input.directories, "directories");

  if (fileInputs.length > maxFiles) {
    fail("LIMIT_EXCEEDED", "Snapshot holds too many files", {
      files: fileInputs.length,
      maxFiles,
    });
  }

  const seen = new Set<string>();
  const files: ManifestFile[] = [];
  let totalBytes = 0;
  for (const candidate of fileInputs) {
    const path = workspacePath(candidate.path, limits.path).value;
    if (seen.has(path)) {
      fail("INVALID_MANIFEST", `Duplicate manifest path: ${path}`, { path });
    }
    seen.add(path);
    const mode = candidate.mode ?? "file";
    if (mode !== "file" && mode !== "executable") {
      fail("INVALID_MANIFEST", `Unsupported file mode for ${path}`, { path });
    }
    const size = candidate.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      fail("INVALID_MANIFEST", `Invalid size for ${path}`, { path });
    }
    if (size > maxFileBytes) {
      fail("LIMIT_EXCEEDED", `File exceeds the size cap: ${path}`, {
        path,
        size,
        maxFileBytes,
      });
    }
    if (!isContentRef(candidate.digest)) {
      fail("INVALID_MANIFEST", `Invalid content address for ${path}`, { path });
    }
    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      fail("LIMIT_EXCEEDED", "Snapshot exceeds the total size cap", {
        maxTotalBytes,
      });
    }
    files.push(Object.freeze({ path, mode, size, digest: candidate.digest }));
  }

  const directories = new Set<string>();
  for (const candidate of directoryInputs) {
    directories.add(workspacePath(candidate, limits.path).value);
  }
  // A directory that already holds a captured file is implied by that file.
  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    while (segments.length > 0) {
      directories.delete(segments.join("/"));
      segments.pop();
    }
  }

  files.sort((left, right) => compareWorkspacePaths(left.path, right.path));
  const draft = {
    version: SNAPSHOT_MANIFEST_VERSION,
    algorithm: SNAPSHOT_HASH_ALGORITHM,
    files: Object.freeze(files),
    directories: Object.freeze([...directories].sort(compareWorkspacePaths)),
    totalBytes,
  } as const;
  return Object.freeze({ ...draft, ref: refOf(canonicalize(draft)) });
}

/** The exact bytes a manifest is addressed by. */
export function serializeManifest(manifest: SnapshotManifest): string {
  return canonicalize(manifest);
}

export function parseManifest(
  serialized: string,
  limits?: ManifestLimits,
): SnapshotManifest {
  if (typeof serialized !== "string") {
    fail("INVALID_MANIFEST", "A serialized manifest must be a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    fail("INVALID_MANIFEST", "A serialized manifest must be JSON", {
      detail: error instanceof Error ? error.message : "unparseable",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("INVALID_MANIFEST", "A serialized manifest must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== SNAPSHOT_MANIFEST_VERSION) {
    fail("INVALID_MANIFEST", "Unsupported manifest version", {
      supported: SNAPSHOT_MANIFEST_VERSION,
    });
  }
  if (record["algorithm"] !== SNAPSHOT_HASH_ALGORITHM) {
    fail("INVALID_MANIFEST", "Unsupported manifest hash algorithm");
  }
  const manifest = buildManifest(
    {
      files: record["files"] as readonly ManifestFileInput[],
      ...(record["directories"] === undefined
        ? {}
        : { directories: record["directories"] as readonly string[] }),
    },
    limits,
  );
  if (record["totalBytes"] !== manifest.totalBytes) {
    fail("INVALID_MANIFEST", "Recorded total size does not match the files", {
      recorded: String(record["totalBytes"]),
      computed: manifest.totalBytes,
    });
  }
  // Re-serializing a manifest that was already canonical reproduces it byte
  // for byte, which is what makes the address verifiable rather than trusted.
  if (serializeManifest(manifest) !== serialized) {
    fail("INVALID_MANIFEST", "A manifest must be in canonical form");
  }
  return manifest;
}

/** Recompute a manifest's address and confirm it matches what it claims. */
export function verifyManifest(
  manifest: SnapshotManifest,
  limits?: ManifestLimits,
): SnapshotManifest {
  const rebuilt = buildManifest(
    { files: manifest.files, directories: manifest.directories },
    limits,
  );
  if (!contentRefEquals(rebuilt.ref, manifest.ref)) {
    fail("DIGEST_MISMATCH", "Manifest content does not match its address", {
      expected: manifest.ref,
      computed: rebuilt.ref,
    });
  }
  return rebuilt;
}

/** Every distinct blob a manifest needs, for storing or garbage collecting. */
export function manifestBlobRefs(
  manifest: SnapshotManifest,
): readonly string[] {
  return Object.freeze(
    [...new Set(manifest.files.map((file) => file.digest))].sort(),
  );
}

/**
 * What changed between two captures. This is the delta a restore applies when
 * the nearest prior checkpoint is not the target itself.
 */
export function diffManifests(
  base: SnapshotManifest,
  target: SnapshotManifest,
): ManifestDiff {
  const before = new Map(base.files.map((file) => [file.path, file]));
  const added: ManifestFile[] = [];
  const modified: ManifestChange[] = [];
  let unchangedFiles = 0;

  for (const file of target.files) {
    const previous = before.get(file.path);
    if (previous === undefined) {
      added.push(file);
      continue;
    }
    before.delete(file.path);
    if (previous.digest === file.digest && previous.mode === file.mode) {
      unchangedFiles += 1;
      continue;
    }
    modified.push(Object.freeze({ before: previous, after: file }));
  }

  const baseDirectories = new Set(base.directories);
  const targetDirectories = new Set(target.directories);
  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    removed: Object.freeze([...before.values()]),
    addedDirectories: Object.freeze(
      target.directories.filter((item) => !baseDirectories.has(item)),
    ),
    removedDirectories: Object.freeze(
      base.directories.filter((item) => !targetDirectories.has(item)),
    ),
    unchangedFiles,
  });
}

function canonicalize(
  manifest: Omit<SnapshotManifest, "ref"> | SnapshotManifest,
): string {
  return JSON.stringify({
    version: manifest.version,
    algorithm: manifest.algorithm,
    files: manifest.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      size: file.size,
      digest: file.digest,
    })),
    directories: manifest.directories,
    totalBytes: manifest.totalBytes,
  });
}

function refOf(canonical: string): string {
  return `sha256:${createHash(SNAPSHOT_HASH_ALGORITHM).update(canonical, "utf8").digest("hex")}`;
}

function list<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (!Array.isArray(value)) {
    fail("INVALID_MANIFEST", `Manifest ${label} must be an array`);
  }
  for (const item of value) {
    if (item === null || item === undefined) {
      fail("INVALID_MANIFEST", `Manifest ${label} contains an empty entry`);
    }
  }
  return value;
}

function positive(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_OPTIONS", `${label} must be a positive integer`);
  }
  return value;
}
