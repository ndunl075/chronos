import {
  ChronosStorage,
  IN_MEMORY_PATH,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openStorage,
  StorageError,
  type Migration,
  type OpenStorageOptions,
  type StorageErrorCode,
} from "../src/index.js";

declare const options: OpenStorageOptions;
const storage: ChronosStorage = openStorage(options);
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
