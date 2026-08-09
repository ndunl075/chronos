import {
  isLogicalSequence,
  type Branch,
  type BranchState,
  type Checkpoint,
  type Event,
  type LogicalSequence,
  type Session,
} from "@chronos/protocol";

import type { ChronosStorage } from "./database.js";
import { StorageError, fail } from "./errors.js";
import {
  branchColumns,
  eventColumns,
  text,
  toBranch,
  toCheckpoint,
  toEvent,
  toEventSummary,
  toSession,
  type EventSummary,
} from "./records.js";

const EVENT_COLUMNS = `id, branch_id, seq, kind, occurred_at, summary,
  payload_schema_version, payload_json, raw_schema_version, raw_ref,
  raw_media_type, raw_source_schema_version`;

const SUMMARY_COLUMNS = `id, branch_id, seq, kind, occurred_at, summary, raw_ref`;

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

/** A page of a branch's own history, ordered by logical sequence. */
export interface EventPageOptions {
  /** Inclusive lower bound on the logical sequence. Defaults to the start. */
  readonly fromSeq?: LogicalSequence;
  /** Rows to return, at most 1000. Defaults to 200. */
  readonly limit?: number;
}

/**
 * The records `@chronos/core` needs to index a session. Events are ordered by
 * branch and then by sequence, which satisfies the per-owner monotonic order
 * that indexing requires.
 */
export interface SessionGraph {
  readonly session: Session;
  readonly branches: readonly Branch[];
  readonly events: readonly Event[];
  readonly checkpoints: readonly Checkpoint[];
}

/**
 * Repositories over one open connection. Every method is atomic on its own;
 * wrap several in `transaction` when they have to succeed or fail together.
 */
export class ChronosRepository {
  #storage: ChronosStorage;

  constructor(storage: ChronosStorage) {
    this.#storage = storage;
    Object.freeze(this);
  }

  /** Run `work` in one transaction, joining an outer one when it exists. */
  transaction<T>(work: () => T): T {
    return this.#storage.isInTransaction
      ? work()
      : this.#storage.transaction(work);
  }

  insertSession(session: Session): Session {
    const id = text(session.id, "session id", "INVALID_RECORD");
    const source = text(session.source, "session source", "INVALID_RECORD");
    const createdAt = text(
      session.createdAt,
      "session createdAt",
      "INVALID_RECORD",
    );
    this.#write("Session", () =>
      this.#statement(
        `INSERT INTO session (id, source, created_at) VALUES (?, ?, ?)`,
      ).run(id, source, createdAt),
    );
    return Object.freeze({ id, source, createdAt });
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.#statement(
      `SELECT id, source, created_at FROM session WHERE id = ?`,
    ).get(text(sessionId, "session id", "INVALID_RECORD"));
    return row === undefined ? undefined : toSession(row);
  }

  listSessions(): readonly Session[] {
    return Object.freeze(
      this.#statement(
        `SELECT id, source, created_at FROM session ORDER BY created_at, id`,
      )
        .all()
        .map(toSession),
    );
  }

  insertBranch(branch: Branch): Branch {
    const columns = branchColumns(branch);
    this.#write("Branch", () =>
      this.#statement(
        `INSERT INTO branch (id, session_id, parent_id, fork_seq, state)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        columns.id,
        columns.sessionId,
        columns.parentId,
        columns.forkSeq,
        columns.state,
      ),
    );
    return this.#requireBranch(columns.id);
  }

  getBranch(branchId: string): Branch | undefined {
    const row = this.#statement(
      `SELECT id, session_id, parent_id, fork_seq, state
       FROM branch WHERE id = ?`,
    ).get(text(branchId, "branch id", "INVALID_RECORD"));
    return row === undefined ? undefined : toBranch(row);
  }

  listBranches(sessionId: string): readonly Branch[] {
    return Object.freeze(
      this.#statement(
        `SELECT id, session_id, parent_id, fork_seq, state
         FROM branch WHERE session_id = ?
         ORDER BY (parent_id IS NOT NULL), fork_seq, id`,
      )
        .all(text(sessionId, "session id", "INVALID_RECORD"))
        .map(toBranch),
    );
  }

  /**
   * Settle a `preparing` branch. This is the only mutation Chronos performs on
   * a canonical record, and it may happen exactly once per branch.
   */
  settleBranch(
    branchId: string,
    state: Extract<BranchState, "ready" | "failed">,
  ): Branch {
    const id = text(branchId, "branch id", "INVALID_RECORD");
    if (state !== "ready" && state !== "failed") {
      fail("INVALID_RECORD", "A branch settles as ready or failed");
    }
    const changes = this.#write("Branch", () =>
      Number(
        this.#statement(
          `UPDATE branch SET state = ? WHERE id = ? AND state = 'preparing'`,
        ).run(state, id).changes,
      ),
    );
    if (changes === 0) {
      const current = this.getBranch(id);
      if (current === undefined) {
        fail("UNKNOWN_RECORD", `Unknown branch: ${id}`, { branchId: id });
      }
      fail("INVALID_STATE_TRANSITION", "A branch settles only once", {
        branchId: id,
        state: current.state,
      });
    }
    return this.#requireBranch(id);
  }

  /**
   * Append events to their owning branches. Every record is validated before
   * anything is written, and the batch lands atomically.
   */
  appendEvents(events: readonly Event[]): readonly Event[] {
    const rows = events.map((event) => eventColumns(event));
    if (rows.length === 0) return Object.freeze([]);
    this.transaction(() => {
      const statement = this.#statement(
        `INSERT INTO event (
           id, branch_id, seq, kind, occurred_at, summary,
           payload_schema_version, payload_json, raw_schema_version, raw_ref,
           raw_media_type, raw_source_schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        this.#write("Event", () =>
          statement.run(
            row.id,
            row.branchId,
            row.seq,
            row.kind,
            row.occurredAt,
            row.summary,
            row.payloadSchemaVersion,
            row.payloadJson,
            row.rawSchemaVersion,
            row.rawRef,
            row.rawMediaType,
            row.rawSourceSchemaVersion,
          ),
        );
      }
    });
    return Object.freeze(rows.map((row) => this.#requireEvent(row.id)));
  }

  getEvent(eventId: string): Event | undefined {
    const row = this.#statement(
      `SELECT ${EVENT_COLUMNS} FROM event WHERE id = ?`,
    ).get(text(eventId, "event id", "INVALID_RECORD"));
    return row === undefined ? undefined : toEvent(row);
  }

  /** Read the events a branch owns; inherited history is resolved by core. */
  listEvents(
    branchId: string,
    options: EventPageOptions = {},
  ): readonly Event[] {
    const page = pageBounds(options);
    return Object.freeze(
      this.#statement(
        `SELECT ${EVENT_COLUMNS} FROM event
         WHERE branch_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      )
        .all(
          text(branchId, "branch id", "INVALID_RECORD"),
          page.fromSeq,
          page.limit,
        )
        .map(toEvent),
    );
  }

  /** Page a timeline without loading payloads or raw envelope references. */
  listEventSummaries(
    branchId: string,
    options: EventPageOptions = {},
  ): readonly EventSummary[] {
    const page = pageBounds(options);
    return Object.freeze(
      this.#statement(
        `SELECT ${SUMMARY_COLUMNS} FROM event
         WHERE branch_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      )
        .all(
          text(branchId, "branch id", "INVALID_RECORD"),
          page.fromSeq,
          page.limit,
        )
        .map(toEventSummary),
    );
  }

  countEvents(branchId: string): number {
    const row = this.#statement(
      `SELECT count(*) AS total FROM event WHERE branch_id = ?`,
    ).get(text(branchId, "branch id", "INVALID_RECORD"));
    return Number(row?.["total"] ?? 0);
  }

  insertCheckpoint(checkpoint: Checkpoint): Checkpoint {
    const id = text(checkpoint.id, "checkpoint id", "INVALID_RECORD");
    const branchId = text(
      checkpoint.branchId,
      "checkpoint branchId",
      "INVALID_RECORD",
    );
    const manifestRef = text(
      checkpoint.manifestRef,
      "checkpoint manifestRef",
      "INVALID_RECORD",
    );
    const eventSeq = checkpoint.eventSeq;
    if (!isLogicalSequence(eventSeq)) {
      fail("INVALID_RECORD", "Checkpoint eventSeq is invalid");
    }
    this.#write("Checkpoint", () =>
      this.#statement(
        `INSERT INTO checkpoint (id, branch_id, event_seq, manifest_ref)
         VALUES (?, ?, ?, ?)`,
      ).run(id, branchId, eventSeq, manifestRef),
    );
    return Object.freeze({ id, branchId, eventSeq, manifestRef });
  }

  listCheckpoints(branchId: string): readonly Checkpoint[] {
    return Object.freeze(
      this.#statement(
        `SELECT id, branch_id, event_seq, manifest_ref
         FROM checkpoint WHERE branch_id = ? ORDER BY event_seq`,
      )
        .all(text(branchId, "branch id", "INVALID_RECORD"))
        .map(toCheckpoint),
    );
  }

  /** Read a whole session in the shape `@chronos/core` indexes. */
  loadSessionGraph(sessionId: string): SessionGraph {
    const id = text(sessionId, "session id", "INVALID_RECORD");
    const session = this.getSession(id);
    if (session === undefined) {
      fail("UNKNOWN_RECORD", `Unknown session: ${id}`, { sessionId: id });
    }
    return Object.freeze({
      session,
      branches: this.listBranches(id),
      events: Object.freeze(
        this.#statement(
          `SELECT ${EVENT_COLUMNS} FROM event
           WHERE branch_id IN (SELECT id FROM branch WHERE session_id = ?)
           ORDER BY branch_id, seq`,
        )
          .all(id)
          .map(toEvent),
      ),
      checkpoints: Object.freeze(
        this.#statement(
          `SELECT id, branch_id, event_seq, manifest_ref FROM checkpoint
           WHERE branch_id IN (SELECT id FROM branch WHERE session_id = ?)
           ORDER BY branch_id, event_seq`,
        )
          .all(id)
          .map(toCheckpoint),
      ),
    });
  }

  #statement(sql: string) {
    return this.#storage._prepare(sql);
  }

  #requireBranch(branchId: string): Branch {
    const branch = this.getBranch(branchId);
    if (branch === undefined) {
      fail("CORRUPT_RECORD", `Branch disappeared after writing: ${branchId}`);
    }
    return branch;
  }

  #requireEvent(eventId: string): Event {
    const event = this.getEvent(eventId);
    if (event === undefined) {
      fail("CORRUPT_RECORD", `Event disappeared after writing: ${eventId}`);
    }
    return event;
  }

  /** Translate SQLite constraint and trigger failures into storage errors. */
  #write<T>(label: string, work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed")) {
        fail(
          "DUPLICATE_RECORD",
          `${label} conflicts with an existing record`,
          {},
          { cause: error },
        );
      }
      fail(
        "CONSTRAINT_VIOLATION",
        `${label} was rejected by storage: ${message}`,
        {},
        { cause: error },
      );
    }
  }
}

function pageBounds(
  options: EventPageOptions,
): Readonly<{ fromSeq: number; limit: number }> {
  const fromSeq = options.fromSeq ?? 1;
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!isLogicalSequence(fromSeq)) {
    fail("INVALID_PAGE", "fromSeq must be a 1-based logical sequence");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    fail(
      "INVALID_PAGE",
      `limit must be between 1 and ${String(MAX_PAGE_SIZE)}`,
    );
  }
  return Object.freeze({ fromSeq, limit });
}
