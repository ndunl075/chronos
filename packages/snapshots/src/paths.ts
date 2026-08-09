import { fail, type PathRejection } from "./errors.js";

/**
 * Limits that keep one hostile manifest from producing a path the host
 * filesystem cannot represent, or a restore that never terminates.
 */
export interface PathLimits {
  /** Longest whole path. Defaults to 1024. */
  readonly maxLength?: number;
  /** Longest single segment. Defaults to 255, the common filesystem limit. */
  readonly maxSegmentLength?: number;
  /** Deepest nesting. Defaults to 64. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_LENGTH = 1024;
const DEFAULT_MAX_SEGMENT_LENGTH = 255;
const DEFAULT_MAX_DEPTH = 64;

/*
 * Manifest paths are workspace-relative POSIX paths. They are the only form
 * Chronos records, so one rule set covers both directions: a path that cannot
 * be recorded cannot be restored, on any host.
 *
 * Windows rules are enforced everywhere. A manifest captured on Linux is
 * restored on Windows often enough that accepting `aux` or a trailing dot
 * would turn a portable snapshot into an unrestorable one, and a backslash is
 * a legal POSIX filename character that becomes a separator on Windows.
 */
const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** A path that has been checked against every rule in this module. */
export interface WorkspacePath {
  /** Slash-separated, workspace-relative, with no `.` or `..` segments. */
  readonly value: string;
  readonly segments: readonly string[];
}

/** Check a path without throwing; useful for filtering a walk. */
export function checkWorkspacePath(
  raw: unknown,
  limits: PathLimits = {},
): PathRejection | undefined {
  const maxLength = positive(limits.maxLength, DEFAULT_MAX_LENGTH, "maxLength");
  const maxSegmentLength = positive(
    limits.maxSegmentLength,
    DEFAULT_MAX_SEGMENT_LENGTH,
    "maxSegmentLength",
  );
  const maxDepth = positive(limits.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth");

  if (typeof raw !== "string" || raw.length === 0) return "empty";
  if (raw.length > maxLength) return "path_too_long";
  if (raw.includes("\\")) return "backslash";
  if (raw.startsWith("//")) return "unc_path";
  if (raw.startsWith("/")) return "absolute";
  if (/^[A-Za-z]:/.test(raw)) return "drive_letter";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/u.test(raw)) return "control_character";

  const segments = raw.split("/");
  if (segments.length > maxDepth) return "too_deep";
  for (const segment of segments) {
    if (segment.length === 0) return "empty_segment";
    if (segment === ".") return "relative_segment";
    if (segment === "..") return "traversal";
    if (segment.length > maxSegmentLength) return "segment_too_long";
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "trailing_dot_or_space";
    }
    const stem = segment.split(".")[0]!.toLowerCase();
    if (RESERVED_DEVICE_NAMES.has(stem)) return "reserved_device_name";
  }
  return undefined;
}

export function isWorkspacePath(raw: unknown, limits?: PathLimits): boolean {
  return checkWorkspacePath(raw, limits) === undefined;
}

/** Validate a path and return it in the single canonical recorded form. */
export function workspacePath(
  raw: unknown,
  limits: PathLimits = {},
): WorkspacePath {
  const rejection = checkWorkspacePath(raw, limits);
  if (rejection !== undefined) {
    fail("INVALID_PATH", `Unsafe workspace path: ${rejection}`, {
      reason: rejection,
      ...(typeof raw === "string" ? { path: raw } : {}),
    });
  }
  const value = raw as string;
  return Object.freeze({
    value,
    segments: Object.freeze(value.split("/")),
  });
}

/**
 * Build a workspace path from the segments a directory walk produced. Host
 * separators never reach a manifest, so a walker passes segments, not a path.
 */
export function workspacePathFromSegments(
  segments: readonly string[],
  limits?: PathLimits,
): WorkspacePath {
  if (!Array.isArray(segments) || segments.length === 0) {
    fail("INVALID_PATH", "Unsafe workspace path: empty", { reason: "empty" });
  }
  for (const segment of segments) {
    if (typeof segment !== "string") {
      fail("INVALID_PATH", "Path segments must be strings", {
        reason: "empty_segment",
      });
    }
  }
  return workspacePath(segments.join("/"), limits);
}

/** True when `candidate` is `parent` itself or something nested inside it. */
export function isWithin(
  parent: WorkspacePath,
  candidate: WorkspacePath,
): boolean {
  if (candidate.segments.length < parent.segments.length) return false;
  return parent.segments.every(
    (segment, index) => candidate.segments[index] === segment,
  );
}

/** Order paths the way a manifest records them: stable, byte-wise, portable. */
export function compareWorkspacePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
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
