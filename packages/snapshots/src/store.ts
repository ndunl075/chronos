import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { fail } from "./errors.js";
import { blobRef, contentRefEquals, isContentRef } from "./manifest.js";

const DEFAULT_MAX_BLOB_BYTES = 16 * 1024 * 1024;

export interface ContentStoreOptions {
  /** Directory that holds the blobs. It must be outside every workspace. */
  readonly root: string;
  /** Largest blob this store accepts. Defaults to 16 MiB. */
  readonly maxBlobBytes?: number;
}

/**
 * Blobs on disk, addressed by content.
 *
 * Writes go to a temporary file and are renamed into place, so a crash leaves
 * either nothing or a complete blob and never a half-written one that a later
 * restore would trust. Reads re-hash what they read: a blob store is the one
 * place where a silent corruption would restore a workspace that never
 * existed.
 *
 * The API is synchronous, like the rest of the local-first stack. Capture is
 * bounded by the manifest limits, so the blocking window stays predictable.
 */
export class ContentStore {
  readonly root: string;
  readonly maxBlobBytes: number;

  constructor(options: ContentStoreOptions) {
    const root = options.root;
    if (typeof root !== "string" || root.trim().length === 0) {
      fail("INVALID_OPTIONS", "A content store needs a root directory");
    }
    const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 1) {
      fail("INVALID_OPTIONS", "maxBlobBytes must be a positive integer");
    }
    this.root = resolve(root);
    this.maxBlobBytes = maxBlobBytes;
    io(() => {
      mkdirSync(join(this.root, "blobs"), { recursive: true });
      mkdirSync(join(this.root, "tmp"), { recursive: true });
    }, "The content store root could not be created");
    Object.freeze(this);
  }

  has(ref: string): boolean {
    return existsSync(this.blobPath(ref));
  }

  /** Store bytes and return their address. Storing twice is a no-op. */
  put(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) {
      fail("INVALID_OPTIONS", "A blob must be a Uint8Array");
    }
    if (bytes.byteLength > this.maxBlobBytes) {
      fail("LIMIT_EXCEEDED", "Blob exceeds the store size cap", {
        size: bytes.byteLength,
        maxBlobBytes: this.maxBlobBytes,
      });
    }
    const ref = blobRef(bytes);
    const destination = this.blobPath(ref);
    if (existsSync(destination)) return ref;

    const temporary = join(this.root, "tmp", randomUUID());
    io(() => {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(temporary, bytes, { flag: "wx" });
      if (existsSync(destination)) {
        // Another writer won the race; identical content, so keep theirs.
        rmSync(temporary, { force: true });
        return;
      }
      renameSync(temporary, destination);
    }, `The blob could not be stored: ${ref}`);
    return ref;
  }

  /** Read a blob and confirm it still hashes to the address it was asked for. */
  get(ref: string): Uint8Array {
    if (!isContentRef(ref)) {
      fail("INVALID_OPTIONS", `Not a content address: ${String(ref)}`);
    }
    const path = this.blobPath(ref);
    if (!existsSync(path)) {
      fail("MISSING_BLOB", `The content store has no blob: ${ref}`, { ref });
    }
    const bytes = io(
      () => new Uint8Array(readFileSync(path)),
      `The blob could not be read: ${ref}`,
    );
    if (!contentRefEquals(blobRef(bytes), ref)) {
      fail(
        "DIGEST_MISMATCH",
        `Stored blob does not match its address: ${ref}`,
        {
          ref,
        },
      );
    }
    return bytes;
  }

  /** Where a blob lives. Sharding keeps directories small on every host. */
  blobPath(ref: string): string {
    if (!isContentRef(ref)) {
      fail("INVALID_OPTIONS", `Not a content address: ${String(ref)}`);
    }
    const hex = ref.slice("sha256:".length);
    return join(this.root, "blobs", hex.slice(0, 2), hex.slice(2));
  }

  /**
   * Refuse to write snapshots into the workspace being inspected. A store
   * inside a workspace would capture its own blobs on the next capture.
   */
  assertOutside(workspaceRoot: string): void {
    const workspace = resolve(workspaceRoot);
    if (contains(workspace, this.root) || contains(this.root, workspace)) {
      fail(
        "UNSAFE_LOCATION",
        "A content store must live outside the inspected workspace",
        { store: this.root, workspace },
      );
    }
  }
}

/** True when `candidate` is `parent` or nested inside it. */
export function contains(parent: string, candidate: string): boolean {
  const left = resolve(parent);
  const right = resolve(candidate);
  if (left === right) return true;
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`;
  return right.startsWith(prefix);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Turn a filesystem failure into a storage error without losing the cause. */
export function io<T>(work: () => T, message: string): T {
  try {
    return work();
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      fail("IO_FAILED", `${message} (${String(code)})`);
    }
    fail("IO_FAILED", message);
  }
}
