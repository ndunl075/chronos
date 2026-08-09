export type SnapshotErrorCode =
  | "INVALID_PATH"
  | "INVALID_POLICY"
  | "INVALID_OPTIONS"
  | "INVALID_MANIFEST"
  | "LIMIT_EXCEEDED"
  | "DIGEST_MISMATCH"
  | "UNSAFE_LOCATION"
  | "TARGET_NOT_EMPTY"
  | "MISSING_BLOB"
  | "IO_FAILED";

/** Why a path is not safe to record in, or restore from, a snapshot. */
export type PathRejection =
  | "empty"
  | "absolute"
  | "drive_letter"
  | "unc_path"
  | "backslash"
  | "traversal"
  | "relative_segment"
  | "empty_segment"
  | "control_character"
  | "reserved_device_name"
  | "trailing_dot_or_space"
  | "segment_too_long"
  | "path_too_long"
  | "too_deep";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: SnapshotErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function fail(
  code: SnapshotErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number>>,
): never {
  throw new SnapshotError(code, message, details);
}
