import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { EVENT_KINDS } from "@chronos/protocol";
import {
  IN_MEMORY_PATH,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  StorageError,
  openStorage,
  readSchemaVersion,
} from "../dist/index.js";

const OCCURRED_AT = "2026-08-09T00:00:00Z";

/**
 * A throwaway database file. Handles are closed before the directory is
 * removed because Windows refuses to unlink a file that is still open.
 */
function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "chronos-storage-"));
  const opened = [];
  t.after(() => {
    for (const storage of opened) storage.close();
    rmSync(directory, { force: true, recursive: true, maxRetries: 5 });
  });
  return {
    path: join(directory, "chronos.sqlite"),
    track(storage) {
      opened.push(storage);
      return storage;
    },
  };
}

function openMemory(t) {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  t.after(() => storage.close());
  return storage;
}

function insertEvent(database, id, branchId, seq, kind = "assistant_message") {
  database
    .prepare(
      `INSERT INTO event (
         id, branch_id, seq, kind, occurred_at, summary,
         payload_schema_version, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, branchId, seq, kind, OCCURRED_AT, id, 1, JSON.stringify({ id }));
}

function seedReadyRoot(storage) {
  const database = storage._database();
  database.exec(
    `INSERT INTO session (id, source, created_at)
     VALUES ('s1', 'fixture', '${OCCURRED_AT}')`,
  );
  database.exec(
    `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
     VALUES ('root', 's1', NULL, NULL, 'ready')`,
  );
  return database;
}

test("a new database is migrated to the latest schema version", (t) => {
  const storage = openMemory(t);

  assert.equal(storage.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(readSchemaVersion(storage._database()), LATEST_SCHEMA_VERSION);
  assert.deepEqual(
    storage
      ._database()
      .prepare("SELECT version, name FROM chronos_migration ORDER BY version")
      .all()
      .map((row) => ({ version: row.version, name: row.name })),
    MIGRATIONS.map((migration) => ({
      version: migration.version,
      name: migration.name,
    })),
  );
});

test("migrations run once and survive a reopen", (t) => {
  const { path, track } = temporaryDatabase(t);

  const first = track(openStorage({ path }));
  first._database().exec(
    `INSERT INTO session (id, source, created_at)
     VALUES ('s1', 'fixture', '${OCCURRED_AT}')`,
  );
  first.close();

  const second = track(openStorage({ path }));

  assert.equal(second.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(
    second
      ._database()
      .prepare("SELECT count(*) AS n FROM chronos_migration")
      .get().n,
    MIGRATIONS.length,
  );
  assert.equal(
    second._database().prepare("SELECT count(*) AS n FROM session").get().n,
    1,
  );
  assert.equal(
    second._database().prepare("PRAGMA foreign_keys").get().foreign_keys,
    1,
  );
});

test("a database written by a newer build is refused", (t) => {
  const { path } = temporaryDatabase(t);
  openStorage({ path }).close();

  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
  raw.close();

  assert.throws(
    () => openStorage({ path }),
    (error) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "UNSUPPORTED_SCHEMA_VERSION");
      return true;
    },
  );
});

test("read-only connections require a migrated database and never write", (t) => {
  const { path, track } = temporaryDatabase(t);

  assert.throws(
    () => openStorage({ path: IN_MEMORY_PATH, readOnly: true }),
    (error) => error.code === "INVALID_OPTIONS",
  );

  const empty = new DatabaseSync(path);
  empty.exec("CREATE TABLE placeholder (id TEXT)");
  empty.close();
  assert.throws(
    () => openStorage({ path, readOnly: true }),
    (error) => error.code === "UNSUPPORTED_SCHEMA_VERSION",
  );

  rmSync(path);
  openStorage({ path }).close();
  const reader = track(openStorage({ path, readOnly: true }));
  assert.equal(reader.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.throws(
    () => reader.transaction(() => undefined),
    (error) => error.code === "READ_ONLY",
  );
});

test("invalid open options are rejected before a connection exists", () => {
  assert.throws(
    () => openStorage({ path: "  " }),
    (error) => error.code === "INVALID_OPTIONS",
  );
  assert.throws(
    () => openStorage({ path: IN_MEMORY_PATH, busyTimeoutMs: -1 }),
    (error) => error.code === "INVALID_OPTIONS",
  );
});

test("transactions commit, roll back, and never nest", (t) => {
  const storage = openMemory(t);
  const database = storage._database();
  const count = () =>
    database.prepare("SELECT count(*) AS n FROM session").get().n;

  storage.transaction(() => {
    database.exec(
      `INSERT INTO session (id, source, created_at)
       VALUES ('kept', 'fixture', '${OCCURRED_AT}')`,
    );
  });
  assert.equal(count(), 1);

  assert.throws(
    () =>
      storage.transaction(() => {
        database.exec(
          `INSERT INTO session (id, source, created_at)
           VALUES ('discarded', 'fixture', '${OCCURRED_AT}')`,
        );
        throw new Error("work failed");
      }),
    /work failed/,
  );
  assert.equal(count(), 1);
  assert.equal(database.isTransaction, false);

  assert.throws(
    () => storage.transaction(() => storage.transaction(() => undefined)),
    (error) => error.code === "NESTED_TRANSACTION",
  );
  assert.equal(database.isTransaction, false);
});

test("a closed connection refuses further work", () => {
  const storage = openStorage({ path: IN_MEMORY_PATH });
  storage.close();
  storage.close();

  assert.equal(storage.isOpen, false);
  assert.throws(
    () => storage.transaction(() => undefined),
    (error) => error.code === "DATABASE_CLOSED",
  );
});

test("canonical records are immutable", (t) => {
  const database = seedReadyRoot(openMemory(t));
  insertEvent(database, "e1", "root", 1);
  database.exec(
    `INSERT INTO checkpoint (id, branch_id, event_seq, manifest_ref)
     VALUES ('cp1', 'root', 1, 'sha256:abc')`,
  );

  assert.throws(
    () => database.exec("UPDATE session SET source = 'other'"),
    /sessions are immutable/,
  );
  assert.throws(
    () => database.exec("DELETE FROM session"),
    /sessions are immutable/,
  );
  assert.throws(
    () => database.exec("UPDATE event SET summary = 'rewritten'"),
    /events are immutable/,
  );
  assert.throws(
    () => database.exec("DELETE FROM event"),
    /events are immutable/,
  );
  assert.throws(
    () => database.exec("UPDATE checkpoint SET manifest_ref = 'sha256:zzz'"),
    /checkpoints are immutable/,
  );
  assert.throws(
    () => database.exec("DELETE FROM checkpoint"),
    /checkpoints are immutable/,
  );
  assert.throws(
    () => database.exec("DELETE FROM branch"),
    /branch lineage is immutable/,
  );
  assert.throws(
    () => database.exec("UPDATE branch SET fork_seq = 3 WHERE id = 'root'"),
    /branch lineage is immutable/,
  );
});

test("a session has exactly one root branch", (t) => {
  const database = seedReadyRoot(openMemory(t));

  assert.throws(
    () =>
      database.exec(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES ('root2', 's1', NULL, NULL, 'ready')`,
      ),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES ('halfChild', 's1', 'root', NULL, 'preparing')`,
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES ('orphan', 'missing', NULL, NULL, 'ready')`,
      ),
    /FOREIGN KEY constraint failed/,
  );
});

test("a branch settles once, out of preparing", (t) => {
  const database = seedReadyRoot(openMemory(t));
  insertEvent(database, "e1", "root", 1);
  database.exec(
    `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
     VALUES ('child', 's1', 'root', 1, 'preparing')`,
  );
  database.exec(
    `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
     VALUES ('retry', 's1', 'root', 1, 'preparing')`,
  );

  database.exec("UPDATE branch SET state = 'ready' WHERE id = 'child'");
  database.exec("UPDATE branch SET state = 'failed' WHERE id = 'retry'");
  assert.throws(
    () =>
      database.exec("UPDATE branch SET state = 'preparing' WHERE id = 'child'"),
    /invalid branch state transition/,
  );
  assert.throws(
    () =>
      database.exec("UPDATE branch SET state = 'failed' WHERE id = 'child'"),
    /invalid branch state transition/,
  );
  assert.throws(
    () => database.exec("UPDATE branch SET state = 'ready' WHERE id = 'retry'"),
    /invalid branch state transition/,
  );
  // The state machine trigger runs before column checks, so an unknown state
  // is reported as an illegal transition on update and as a check on insert.
  assert.throws(
    () => database.exec("UPDATE branch SET state = 'done' WHERE id = 'child'"),
    /invalid branch state transition/,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES ('unknownState', 's1', NULL, NULL, 'done')`,
      ),
    /CHECK constraint failed/,
  );
});

test("children fork only from ready branches", (t) => {
  const database = seedReadyRoot(openMemory(t));
  insertEvent(database, "e1", "root", 1);
  database.exec(
    `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
     VALUES ('preparingChild', 's1', 'root', 1, 'preparing')`,
  );

  assert.throws(
    () =>
      database.exec(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES ('grandchild', 's1', 'preparingChild', 1, 'preparing')`,
      ),
    /a branch parent must be ready/,
  );
  // A branch cannot be its own parent: the row is not visible (and so never
  // ready) while it is being inserted, and the check would reject it anyway.
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES ('selfParent', 's1', 'selfParent', 1, 'preparing')`,
      ),
    /a branch parent must be ready/,
  );
});

test("events extend a contiguous suffix owned by a ready branch", (t) => {
  const database = seedReadyRoot(openMemory(t));
  insertEvent(database, "r1", "root", 1);
  insertEvent(database, "r2", "root", 2);

  assert.throws(
    () => insertEvent(database, "gap", "root", 4),
    /events must extend a contiguous suffix/,
  );
  assert.throws(
    () => insertEvent(database, "replay", "root", 2),
    /events must extend a contiguous suffix/,
  );

  database.exec(
    `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
     VALUES ('child', 's1', 'root', 1, 'preparing')`,
  );
  assert.throws(
    () => insertEvent(database, "early", "child", 2),
    /only ready branches may own events/,
  );

  database.exec("UPDATE branch SET state = 'ready' WHERE id = 'child'");
  assert.throws(
    () => insertEvent(database, "inherited", "child", 1),
    /events must extend a contiguous suffix/,
  );
  insertEvent(database, "c2", "child", 2);
  assert.equal(
    database
      .prepare("SELECT count(*) AS n FROM event WHERE branch_id = 'child'")
      .get().n,
    1,
  );
});

test("checkpoints reference an event owned by the same branch", (t) => {
  const database = seedReadyRoot(openMemory(t));
  insertEvent(database, "r1", "root", 1, "filesystem_change");

  assert.throws(
    () =>
      database.exec(
        `INSERT INTO checkpoint (id, branch_id, event_seq, manifest_ref)
         VALUES ('cp', 'root', 2, 'sha256:abc')`,
      ),
    /FOREIGN KEY constraint failed/,
  );
  database.exec(
    `INSERT INTO checkpoint (id, branch_id, event_seq, manifest_ref)
     VALUES ('cp', 'root', 1, 'sha256:abc')`,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO checkpoint (id, branch_id, event_seq, manifest_ref)
         VALUES ('cp2', 'root', 1, 'sha256:def')`,
      ),
    /UNIQUE constraint failed/,
  );
});

test("the stored event kinds match the protocol event kinds", (t) => {
  const database = seedReadyRoot(openMemory(t));

  EVENT_KINDS.forEach((kind, offset) => {
    insertEvent(database, `e${offset + 1}`, "root", offset + 1, kind);
  });
  assert.equal(
    database.prepare("SELECT count(DISTINCT kind) AS n FROM event").get().n,
    EVENT_KINDS.length,
  );
  assert.throws(
    () =>
      insertEvent(
        database,
        "unknown",
        "root",
        EVENT_KINDS.length + 1,
        "speculation",
      ),
    /CHECK constraint failed/,
  );
});

test("payloads must be stored as valid JSON", (t) => {
  const database = seedReadyRoot(openMemory(t));

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO event (
             id, branch_id, seq, kind, occurred_at, summary,
             payload_schema_version, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("bad", "root", 1, "system", OCCURRED_AT, "bad", 1, "{not json"),
    /CHECK constraint failed/,
  );
});
