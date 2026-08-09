import { DatabaseSync, type StatementSync } from "node:sqlite";

import { StorageError, fail } from "./errors.js";
import {
  LATEST_SCHEMA_VERSION,
  migrate,
  readSchemaVersion,
} from "./migrations.js";

/** The SQLite path that keeps a database in process memory only. */
export const IN_MEMORY_PATH = ":memory:";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface OpenStorageOptions {
  /** A filesystem path, or `IN_MEMORY_PATH`. Parent directories must exist. */
  readonly path: string;
  /** Open an existing database without migrating it. Defaults to false. */
  readonly readOnly?: boolean;
  /** Lock wait before SQLITE_BUSY. Defaults to 5000ms. */
  readonly busyTimeoutMs?: number;
}

const storageToken = Symbol("ChronosStorage");

/**
 * An open, migrated connection. Repositories build on this handle; it owns the
 * connection lifetime, a prepared-statement cache, and transaction boundaries.
 */
export class ChronosStorage {
  readonly path: string;
  readonly readOnly: boolean;
  readonly schemaVersion: number;
  #database: DatabaseSync;
  #statements = new Map<string, StatementSync>();

  /** @internal Construct through openStorage. */
  constructor(
    token: typeof storageToken,
    database: DatabaseSync,
    path: string,
    readOnly: boolean,
    schemaVersion: number,
  ) {
    if (token !== storageToken) {
      fail("INVALID_OPTIONS", "ChronosStorage must be created by openStorage");
    }
    this.#database = database;
    this.path = path;
    this.readOnly = readOnly;
    this.schemaVersion = schemaVersion;
    Object.freeze(this);
  }

  get isOpen(): boolean {
    return this.#database.isOpen;
  }

  /**
   * Run `work` inside one `BEGIN IMMEDIATE` transaction, committing on return
   * and rolling back on throw. Transactions do not nest.
   */
  transaction<T>(work: () => T): T {
    const database = this.#open();
    if (this.readOnly) {
      fail("READ_ONLY", "This connection cannot write");
    }
    if (database.isTransaction) {
      fail("NESTED_TRANSACTION", "A transaction is already in progress");
    }
    database.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = work();
    } catch (error) {
      this.#rollback();
      throw error;
    }
    try {
      database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "The transaction could not be committed",
        {},
        { cause: error },
      );
    }
    return result;
  }

  /** @internal Prepared statements are cached for the connection lifetime. */
  _prepare(sql: string): StatementSync {
    const database = this.#open();
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = database.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  /** @internal */
  _database(): DatabaseSync {
    return this.#open();
  }

  /** Close the connection. Closing an already-closed handle is a no-op. */
  close(): void {
    if (!this.#database.isOpen) return;
    this.#statements.clear();
    this.#rollback();
    this.#database.close();
  }

  #open(): DatabaseSync {
    if (!this.#database.isOpen) {
      fail("DATABASE_CLOSED", "The storage connection is closed");
    }
    return this.#database;
  }

  #rollback(): void {
    try {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
    } catch {
      // Surface the caller's failure rather than a rollback failure.
    }
  }
}

/**
 * Open a local database, apply pending migrations, and return the handle.
 * A read-only connection is verified against the expected schema instead.
 */
export function openStorage(options: OpenStorageOptions): ChronosStorage {
  const path = options.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    fail("INVALID_OPTIONS", "A database path is required");
  }
  const readOnly = options.readOnly ?? false;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    fail("INVALID_OPTIONS", "busyTimeoutMs must be a non-negative integer");
  }
  if (readOnly && path === IN_MEMORY_PATH) {
    fail("INVALID_OPTIONS", "An in-memory database cannot be read-only");
  }

  const database = new DatabaseSync(path, {
    open: true,
    readOnly,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: busyTimeoutMs,
  });

  try {
    // Untrusted schemas must never reach the extension or virtual-table paths.
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA foreign_keys = ON");
    if (!readOnly) {
      if (path !== IN_MEMORY_PATH) database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
    }
    const schemaVersion = readOnly
      ? verifyReadOnlySchema(database)
      : migrate(database);
    return new ChronosStorage(
      storageToken,
      database,
      path,
      readOnly,
      schemaVersion,
    );
  } catch (error) {
    closeQuietly(database);
    throw error;
  }
}

function verifyReadOnlySchema(database: DatabaseSync): number {
  const version = readSchemaVersion(database);
  if (version !== LATEST_SCHEMA_VERSION) {
    fail(
      "UNSUPPORTED_SCHEMA_VERSION",
      "A read-only database must already be migrated",
      { found: version, supported: LATEST_SCHEMA_VERSION },
    );
  }
  return version;
}

function closeQuietly(database: DatabaseSync): void {
  try {
    if (database.isOpen) database.close();
  } catch {
    // The open failure is the useful one.
  }
}
