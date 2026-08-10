import type { DatabaseSync } from "node:sqlite";

import { fail } from "./errors.js";

/**
 * A forward-only schema step. Applied migrations are historical records: edit
 * their statements only while a version is unreleased, otherwise add a new one.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/*
 * Storage mirrors the domain invariants that `@chronos/core` enforces in
 * memory so that a database is trustworthy even when it is written by another
 * process or inspected by hand. Lineage depth (a fork sequence that must be
 * visible through recursive ancestry) stays in core; SQL enforces the local
 * rules: immutable history, one root per session, contiguous owned suffixes,
 * and `preparing -> ready | failed` as the only branch state transitions.
 */
const CREATE_SCHEMA_V1: readonly string[] = [
  `CREATE TABLE chronos_migration (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at TEXT NOT NULL
   ) STRICT`,

  `CREATE TABLE session (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     created_at TEXT NOT NULL,
     CHECK (length(id) > 0),
     CHECK (length(source) > 0),
     CHECK (length(created_at) > 0)
   ) STRICT`,

  `CREATE TABLE branch (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL
       REFERENCES session (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
     parent_id TEXT
       REFERENCES branch (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
     fork_seq INTEGER,
     state TEXT NOT NULL,
     CHECK (length(id) > 0),
     CHECK (state IN ('preparing', 'ready', 'failed')),
     CHECK ((parent_id IS NULL) = (fork_seq IS NULL)),
     CHECK (fork_seq IS NULL OR fork_seq >= 1),
     CHECK (parent_id IS NULL OR parent_id <> id)
   ) STRICT`,

  `CREATE UNIQUE INDEX branch_root_per_session
     ON branch (session_id) WHERE parent_id IS NULL`,

  `CREATE INDEX branch_by_session ON branch (session_id)`,

  `CREATE INDEX branch_by_parent
     ON branch (parent_id) WHERE parent_id IS NOT NULL`,

  `CREATE TABLE event (
     id TEXT PRIMARY KEY,
     branch_id TEXT NOT NULL
       REFERENCES branch (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     summary TEXT NOT NULL,
     payload_schema_version INTEGER NOT NULL,
     payload_json TEXT NOT NULL,
     raw_schema_version INTEGER,
     raw_ref TEXT,
     raw_media_type TEXT,
     raw_source_schema_version TEXT,
     CHECK (length(id) > 0),
     CHECK (seq >= 1),
     CHECK (kind IN (
       'instruction', 'assistant_message', 'tool_call', 'tool_result',
       'filesystem_change', 'checkpoint', 'system', 'error'
     )),
     CHECK (length(occurred_at) > 0),
     CHECK (payload_schema_version >= 1),
     CHECK (json_valid(payload_json)),
     CHECK ((raw_ref IS NULL) = (raw_schema_version IS NULL)),
     CHECK (raw_ref IS NULL OR length(raw_ref) > 0),
     CHECK (raw_ref IS NOT NULL
            OR (raw_media_type IS NULL AND raw_source_schema_version IS NULL)),
     UNIQUE (branch_id, seq)
   ) STRICT`,

  `CREATE TABLE checkpoint (
     id TEXT PRIMARY KEY,
     branch_id TEXT NOT NULL,
     event_seq INTEGER NOT NULL,
     manifest_ref TEXT NOT NULL,
     CHECK (length(id) > 0),
     CHECK (event_seq >= 1),
     CHECK (length(manifest_ref) > 0),
     UNIQUE (branch_id, event_seq),
     FOREIGN KEY (branch_id, event_seq) REFERENCES event (branch_id, seq)
       ON DELETE RESTRICT ON UPDATE RESTRICT
   ) STRICT`,

  // Immutable history: canonical records are appended, never rewritten.
  `CREATE TRIGGER session_immutable_update BEFORE UPDATE ON session
   BEGIN SELECT RAISE(ABORT, 'chronos: sessions are immutable'); END`,

  `CREATE TRIGGER session_immutable_delete BEFORE DELETE ON session
   BEGIN SELECT RAISE(ABORT, 'chronos: sessions are immutable'); END`,

  `CREATE TRIGGER event_immutable_update BEFORE UPDATE ON event
   BEGIN SELECT RAISE(ABORT, 'chronos: events are immutable'); END`,

  `CREATE TRIGGER event_immutable_delete BEFORE DELETE ON event
   BEGIN SELECT RAISE(ABORT, 'chronos: events are immutable'); END`,

  `CREATE TRIGGER checkpoint_immutable_update BEFORE UPDATE ON checkpoint
   BEGIN SELECT RAISE(ABORT, 'chronos: checkpoints are immutable'); END`,

  `CREATE TRIGGER checkpoint_immutable_delete BEFORE DELETE ON checkpoint
   BEGIN SELECT RAISE(ABORT, 'chronos: checkpoints are immutable'); END`,

  `CREATE TRIGGER branch_immutable_delete BEFORE DELETE ON branch
   BEGIN SELECT RAISE(ABORT, 'chronos: branch lineage is immutable'); END`,

  `CREATE TRIGGER branch_immutable_lineage BEFORE UPDATE ON branch
   WHEN OLD.id <> NEW.id
     OR OLD.session_id <> NEW.session_id
     OR OLD.parent_id IS NOT NEW.parent_id
     OR OLD.fork_seq IS NOT NEW.fork_seq
   BEGIN SELECT RAISE(ABORT, 'chronos: branch lineage is immutable'); END`,

  // State machine: a branch settles once, out of 'preparing'.
  `CREATE TRIGGER branch_state_transition BEFORE UPDATE OF state ON branch
   WHEN OLD.state <> NEW.state
     AND NOT (OLD.state = 'preparing' AND NEW.state IN ('ready', 'failed'))
   BEGIN SELECT RAISE(ABORT, 'chronos: invalid branch state transition'); END`,

  // A child may only fork from a branch whose workspace was verified ready.
  `CREATE TRIGGER branch_parent_ready BEFORE INSERT ON branch
   WHEN NEW.parent_id IS NOT NULL
     AND (SELECT state FROM branch WHERE id = NEW.parent_id) IS NOT 'ready'
   BEGIN SELECT RAISE(ABORT, 'chronos: a branch parent must be ready'); END`,

  `CREATE TRIGGER event_branch_ready BEFORE INSERT ON event
   WHEN (SELECT state FROM branch WHERE id = NEW.branch_id) IS NOT 'ready'
   BEGIN SELECT RAISE(ABORT, 'chronos: only ready branches may own events'); END`,

  // A branch owns the contiguous suffix that starts after its fork point.
  `CREATE TRIGGER event_contiguous_suffix BEFORE INSERT ON event
   WHEN NEW.seq <> COALESCE(
       (SELECT max(seq) FROM event WHERE branch_id = NEW.branch_id),
       (SELECT coalesce(fork_seq, 0) FROM branch WHERE id = NEW.branch_id)
     ) + 1
   BEGIN
     SELECT RAISE(ABORT, 'chronos: events must extend a contiguous suffix');
   END`,
];

const ALLOW_PREPARING_RECORDING_EVENTS_V2: readonly string[] = [
  `DROP TRIGGER event_branch_ready`,

  `CREATE TRIGGER event_branch_ready BEFORE INSERT ON event
   WHEN (SELECT state FROM branch WHERE id = NEW.branch_id) IS NOT 'ready'
     AND NOT EXISTS (
       SELECT 1 FROM branch AS recording_branch
       JOIN session AS recording_session
         ON recording_session.id = recording_branch.session_id
       WHERE recording_branch.id = NEW.branch_id
         AND recording_branch.parent_id IS NULL
         AND recording_branch.state = 'preparing'
         AND recording_session.source IN ('codex-record', 'claude-record')
     )
   BEGIN SELECT RAISE(ABORT, 'chronos: only ready branches may own events'); END`,
];

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "canonical_records",
    statements: Object.freeze(CREATE_SCHEMA_V1),
  }),
  Object.freeze({
    version: 2,
    name: "preparing_provider_recordings",
    statements: Object.freeze(ALLOW_PREPARING_RECORDING_EVENTS_V2),
  }),
  Object.freeze({
    version: 3,
    name: "persisted_deltas",
    statements: Object.freeze([
      `CREATE TABLE delta (
         id TEXT PRIMARY KEY,
         branch_id TEXT NOT NULL,
         event_seq INTEGER NOT NULL,
         diff_ref TEXT NOT NULL,
         CHECK (length(id) > 0),
         CHECK (event_seq >= 1),
         CHECK (length(diff_ref) > 0),
         UNIQUE (branch_id, event_seq),
         FOREIGN KEY (branch_id, event_seq) REFERENCES event (branch_id, seq)
           ON DELETE RESTRICT ON UPDATE RESTRICT
       ) STRICT`,

      // A sequence holds a full checkpoint or an incremental delta, never both.
      `CREATE TRIGGER delta_not_checkpoint BEFORE INSERT ON delta
       WHEN EXISTS (
         SELECT 1 FROM checkpoint
         WHERE checkpoint.branch_id = NEW.branch_id
           AND checkpoint.event_seq = NEW.event_seq
       )
       BEGIN SELECT RAISE(ABORT, 'chronos: a sequence cannot hold both a checkpoint and a delta'); END`,

      `CREATE TRIGGER checkpoint_not_delta BEFORE INSERT ON checkpoint
       WHEN EXISTS (
         SELECT 1 FROM delta
         WHERE delta.branch_id = NEW.branch_id
           AND delta.event_seq = NEW.event_seq
       )
       BEGIN SELECT RAISE(ABORT, 'chronos: a sequence cannot hold both a checkpoint and a delta'); END`,

      `CREATE TRIGGER delta_immutable_update BEFORE UPDATE ON delta
       BEGIN SELECT RAISE(ABORT, 'chronos: deltas are immutable'); END`,

      `CREATE TRIGGER delta_immutable_delete BEFORE DELETE ON delta
       BEGIN SELECT RAISE(ABORT, 'chronos: deltas are immutable'); END`,
    ]),
  }),
]);

/** The schema version this build writes and expects to read. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

/** Read the applied schema version; an untouched database reports 0. */
export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("MIGRATION_FAILED", "The database reported an unreadable version");
  }
  return value;
}

/**
 * Apply every pending migration, each in its own transaction, and return the
 * resulting schema version. A database from a newer build is never downgraded.
 */
export function migrate(database: DatabaseSync): number {
  const current = readSchemaVersion(database);
  if (current > LATEST_SCHEMA_VERSION) {
    fail(
      "UNSUPPORTED_SCHEMA_VERSION",
      "The database was written by a newer version of Chronos",
      { found: current, supported: LATEST_SCHEMA_VERSION },
    );
  }

  let applied = current;
  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;
    if (migration.version !== applied + 1) {
      fail("INVALID_MIGRATION", "Migrations must be contiguous and ordered", {
        expected: applied + 1,
        found: migration.version,
      });
    }
    applyMigration(database, migration);
    applied = migration.version;
  }
  return applied;
}

function applyMigration(database: DatabaseSync, migration: Migration): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of migration.statements) database.exec(statement);
    database
      .prepare(
        `INSERT INTO chronos_migration (version, name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(migration.version, migration.name, new Date().toISOString());
    // PRAGMA arguments cannot be bound; the value is a validated integer.
    database.exec(`PRAGMA user_version = ${String(migration.version)}`);
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    fail(
      "MIGRATION_FAILED",
      `Migration ${String(migration.version)} (${migration.name}) failed`,
      { version: migration.version, name: migration.name },
      { cause: error },
    );
  }
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    if (database.isTransaction) database.exec("ROLLBACK");
  } catch {
    // The original failure is more useful than a rollback failure.
  }
}
