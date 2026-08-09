export type AdapterErrorCode =
  | "INVALID_INPUT"
  | "INVALID_OPTIONS"
  | "MALFORMED_LINE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_RECORD"
  | "UNKNOWN_RECORD_TYPE"
  | "INVALID_RECORD"
  | "MISSING_SESSION"
  | "DUPLICATE_SESSION"
  | "MISSING_ROOT"
  | "MULTIPLE_ROOTS"
  | "UNKNOWN_BRANCH"
  | "UNKNOWN_EVENT"
  | "DUPLICATE_ID"
  | "INVALID_FORK"
  | "NON_CONTIGUOUS_EVENT"
  | "LIMIT_EXCEEDED";

/** An import failure. `line` is 1-based and points into the source file. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly line: number | undefined;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: AdapterErrorCode,
    message: string,
    line?: number,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(line === undefined ? message : `${message} (line ${String(line)})`);
    this.name = "AdapterError";
    this.code = code;
    this.line = line;
    this.details = Object.freeze({ ...details });
  }
}

export function fail(
  code: AdapterErrorCode,
  message: string,
  line?: number,
  details?: Readonly<Record<string, string | number>>,
): never {
  throw new AdapterError(code, message, line, details);
}
