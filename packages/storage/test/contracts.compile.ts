import type { Branch, Event, Session } from "@chronos/protocol";

import {
  ChronosRepository,
  ChronosStorage,
  IN_MEMORY_PATH,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openStorage,
  StorageError,
  type EventSummary,
  type Migration,
  type OpenStorageOptions,
  type SessionGraph,
  type StorageErrorCode,
} from "../src/index.js";

declare const options: OpenStorageOptions;
declare const session: Session;
declare const branch: Branch;
declare const events: readonly Event[];
const storage: ChronosStorage = openStorage(options);
const repository = new ChronosRepository(storage);
const stored: Session = repository.insertSession(session);
const lineage: Branch = repository.insertBranch(branch);
const appended: readonly Event[] = repository.appendEvents(events);
const summaries: readonly EventSummary[] = repository.listEventSummaries(
  lineage.id,
  { limit: 50 },
);
const graph: SessionGraph = repository.loadSessionGraph(stored.id);
void appended;
void summaries;
void graph;
const version: number = storage.schemaVersion;
const committed: string = storage.transaction(() => "committed");
const migration: Migration | undefined = MIGRATIONS[0];
const code: StorageErrorCode = new StorageError("READ_ONLY", "read only").code;
storage.close();
void version;
void committed;
void migration;
void code;
void IN_MEMORY_PATH;
void LATEST_SCHEMA_VERSION;

// @ts-expect-error a database path is required
openStorage({});
// @ts-expect-error handles are created by openStorage
new ChronosStorage();
// @ts-expect-error the applied schema version is read-only
storage.schemaVersion = LATEST_SCHEMA_VERSION;
// @ts-expect-error migrations are frozen historical records
MIGRATIONS.push(migration);
// @ts-expect-error a branch never settles back into preparing
repository.settleBranch(lineage.id, "preparing");
// @ts-expect-error stored collections are immutable
summaries.push(summaries[0]);
// @ts-expect-error a session graph is read-only
graph.branches = [];
