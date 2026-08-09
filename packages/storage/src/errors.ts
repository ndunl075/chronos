export type StorageErrorCode =
  | "INVALID_OPTIONS"
  | "DATABASE_CLOSED"
  | "READ_ONLY"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "MIGRATION_FAILED"
  | "INVALID_MIGRATION"
  | "NESTED_TRANSACTION"
  | "CONSTRAINT_VIOLATION"
  | "INVALID_RECORD"
  | "CORRUPT_RECORD"
  | "DUPLICATE_RECORD"
  | "UNKNOWN_RECORD"
  | "INVALID_STATE_TRANSITION"
  | "INVALID_PAGE";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: StorageErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(message, Object.hasOwn(options, "cause") ? options : undefined);
    this.name = "StorageError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function fail(
  code: StorageErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number>>,
  options?: Readonly<{ cause?: unknown }>,
): never {
  throw new StorageError(code, message, details, options);
}
