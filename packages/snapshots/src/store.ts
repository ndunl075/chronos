import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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
    // Resolve aliases before creating the missing suffix, so the store's
    // durable identity cannot depend on later path spelling or junctions.
    this.root = canonicalizePotentialPath(root);
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
    const workspace = canonicalizePotentialPath(workspaceRoot);
    const store = canonicalizePotentialPath(this.root);
    if (contains(workspace, store) || contains(store, workspace)) {
      fail(
        "UNSAFE_LOCATION",
        "A content store must live outside the inspected workspace",
        { store, workspace },
      );
    }
  }
}

/** True when `candidate` is `parent` or nested inside it. */
export function contains(parent: string, candidate: string): boolean {
  let left = resolve(parent);
  let right = resolve(candidate);
  if (process.platform === "win32") {
    left = left.toLocaleLowerCase("en-US");
    right = right.toLocaleLowerCase("en-US");
  }
  if (left === right) return true;
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`;
  return right.startsWith(prefix);
}

/**
 * Canonicalize an existing path, or its nearest existing ancestor plus the
 * still-missing suffix. This lets callers compare locations safely before a
 * directory is created and closes aliases through symlinks/junctions.
 */
export function canonicalizePotentialPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const stats = io(
    () => lstatSync(existing),
    `The path could not be inspected: ${existing}`,
  );
  // realpath resolves both POSIX symlinks and Windows junction/reparse aliases.
  const canonicalAncestor = io(
    () => realpathSync.native(existing),
    `The path could not be canonicalized: ${existing}`,
  );
  const suffix = relative(existing, absolute);
  const canonical = resolve(canonicalAncestor, suffix);
  // lstat is intentional: it also forces an error for inaccessible reparse
  // points before realpath is trusted.
  void stats;
  return canonical;
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
