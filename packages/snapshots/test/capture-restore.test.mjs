import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  ContentStore,
  blobRef,
  canonicalizePotentialPath,
  captureWorkspace,
  diffManifests,
  restoreSnapshot,
  restoreSnapshotInPlace,
} from "../dist/index.js";

const POSIX = process.platform !== "win32";

test("potential paths preserve every missing suffix from a filesystem root", () => {
  const filesystemRoot = parse(resolve(tmpdir())).root;
  const missing = join(
    filesystemRoot,
    `chronos-missing-${process.pid}-${Date.now()}`,
    "one",
    "two",
  );
  assert.equal(canonicalizePotentialPath(missing), resolve(missing));
});

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "chronos-snapshots-"));
  t.after(() => rmSync(root, { force: true, recursive: true, maxRetries: 5 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    store: new ContentStore({ root: join(root, "store") }),
    write(relative, contents) {
      const absolute = join(workspace, ...relative.split("/"));
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, contents);
      return absolute;
    },
    mkdir(relative) {
      const absolute = join(workspace, ...relative.split("/"));
      mkdirSync(absolute, { recursive: true });
      return absolute;
    },
    target(name = "restored") {
      return join(root, name);
    },
  };
}

function bytes(text) {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

test("a blob store is content addressed and verifies what it reads", (t) => {
  const box = sandbox(t);
  const ref = box.store.put(bytes("hello"));

  assert.equal(ref, blobRef(bytes("hello")));
  assert.equal(box.store.has(ref), true);
  assert.deepEqual(box.store.get(ref), bytes("hello"));
  assert.equal(box.store.put(bytes("hello")), ref, "storing twice is a no-op");

  assert.throws(
    () => box.store.get(blobRef(bytes("never stored"))),
    (error) => error.code === "MISSING_BLOB",
  );
  assert.throws(
    () => box.store.get("not-a-ref"),
    (error) => error.code === "INVALID_OPTIONS",
  );
  const tiny = new ContentStore({
    root: join(box.root, "tiny-store"),
    maxBlobBytes: 4,
  });
  assert.equal(tiny.put(bytes("abcd")).startsWith("sha256:"), true);
  assert.throws(
    () => tiny.put(bytes("abcde")),
    (error) => error.code === "LIMIT_EXCEEDED",
  );

  writeFileSync(box.store.blobPath(ref), "tampered");
  assert.throws(
    () => box.store.get(ref),
    (error) => error.code === "DIGEST_MISMATCH",
  );
});

test("a store refuses to live inside the workspace it captures", (t) => {
  const box = sandbox(t);
  const inside = new ContentStore({ root: join(box.workspace, ".chronos") });

  assert.throws(
    () => captureWorkspace({ workspaceRoot: box.workspace, store: inside }),
    (error) => error.code === "UNSAFE_LOCATION",
  );
});

test("store/workspace aliases cannot bypass outside-location checks", (t) => {
  const box = sandbox(t);
  const nestedStore = join(box.workspace, "nested-store");
  mkdirSync(nestedStore);
  const alias = join(box.root, "store-alias");
  try {
    symlinkSync(
      nestedStore,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    t.skip("this host does not allow creating directory aliases");
    return;
  }
  const aliased = new ContentStore({ root: join(alias, "not-yet-created") });
  assert.throws(
    () => captureWorkspace({ workspaceRoot: box.workspace, store: aliased }),
    (error) => error.code === "UNSAFE_LOCATION",
  );
});

test("Windows store containment is case-insensitive", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only path semantics");
    return;
  }
  const box = sandbox(t);
  const inside = new ContentStore({
    root: join(box.workspace.toUpperCase(), "CASE-STORE"),
  });
  assert.throws(
    () => captureWorkspace({ workspaceRoot: box.workspace, store: inside }),
    (error) => error.code === "UNSAFE_LOCATION",
  );
});

test("a capture records the workspace and skips what the policy excludes", (t) => {
  const box = sandbox(t);
  box.write("README.md", "readme");
  box.write("src/index.ts", "export {};\n");
  box.write("src/util/helper.ts", "helper");
  box.write(".env", "SECRET=hunter2");
  box.write("node_modules/left-pad/index.js", "module.exports = 1;");
  box.write("dist/index.js", "built");
  box.mkdir("docs/empty");

  const { manifest, excluded } = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });

  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["README.md", "src/index.ts", "src/util/helper.ts"],
  );
  assert.deepEqual(manifest.directories, ["docs/empty"]);
  assert.equal(
    manifest.totalBytes,
    manifest.files.reduce((total, file) => total + file.size, 0),
  );
  assert.deepEqual(
    excluded.map((item) => `${item.reason}:${item.path}`).sort(),
    ["ignored:dist", "ignored:node_modules", "secret:.env"],
  );
  for (const file of manifest.files) {
    assert.equal(box.store.has(file.digest), true, file.path);
  }
});

test("symbolic links are neither followed nor captured", (t) => {
  const box = sandbox(t);
  box.write("real.txt", "real");
  const outside = join(box.root, "outside.txt");
  writeFileSync(outside, "should never be captured");

  try {
    symlinkSync(outside, join(box.workspace, "link.txt"));
  } catch {
    t.skip("this host does not allow creating symbolic links");
    return;
  }

  const { manifest, excluded } = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });

  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["real.txt"],
  );
  assert.deepEqual(excluded, [
    { path: "link.txt", reason: "unsupported_entry", detail: "symlink" },
  ]);
});

test("a capture round-trips into a new directory", (t) => {
  const box = sandbox(t);
  box.write("README.md", "readme");
  box.write("src/index.ts", "export {};\n");
  box.mkdir("docs/empty");
  if (POSIX) {
    chmodSync(box.write("bin/run.sh", "#!/bin/sh\n"), 0o755);
  }

  const { manifest } = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });
  const target = box.target();
  const result = restoreSnapshot({
    manifest,
    store: box.store,
    targetPath: target,
  });

  assert.equal(result.workspacePath, target);
  assert.equal(result.manifestRef, manifest.ref);
  assert.equal(result.filesRestored, manifest.files.length);
  assert.equal(result.bytesRestored, manifest.totalBytes);

  assert.equal(readFileSync(join(target, "README.md"), "utf8"), "readme");
  assert.equal(
    readFileSync(join(target, "src", "index.ts"), "utf8"),
    "export {};\n",
  );
  assert.equal(statSync(join(target, "docs", "empty")).isDirectory(), true);
  if (POSIX) {
    assert.equal(statSync(join(target, "bin", "run.sh")).mode & 0o111, 0o111);
    assert.equal(statSync(join(target, "README.md")).mode & 0o111, 0);
  }

  // Capturing the restored workspace reproduces the same manifest address.
  const recaptured = captureWorkspace({
    workspaceRoot: target,
    store: box.store,
  });
  assert.equal(recaptured.manifest.ref, manifest.ref);
  assert.equal(
    diffManifests(manifest, recaptured.manifest).unchangedFiles,
    manifest.files.length,
  );
});

test("a restore only ever fills a new or empty directory", (t) => {
  const box = sandbox(t);
  box.write("a.txt", "a");
  const { manifest } = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });

  const empty = box.target("empty");
  mkdirSync(empty);
  assert.equal(
    restoreSnapshot({ manifest, store: box.store, targetPath: empty })
      .filesRestored,
    1,
  );

  assert.throws(
    () => restoreSnapshot({ manifest, store: box.store, targetPath: empty }),
    (error) => error.code === "TARGET_NOT_EMPTY",
  );
  assert.throws(
    () =>
      restoreSnapshot({
        manifest,
        store: box.store,
        targetPath: box.workspace,
      }),
    (error) => error.code === "TARGET_NOT_EMPTY",
  );
});

test("a restore that cannot finish leaves nothing behind", (t) => {
  const box = sandbox(t);
  box.write("a.txt", "a");
  box.write("b.txt", "b");
  const { manifest } = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });

  rmSync(box.store.blobPath(manifest.files[1].digest));

  const target = box.target();
  assert.throws(
    () => restoreSnapshot({ manifest, store: box.store, targetPath: target }),
    (error) => error.code === "MISSING_BLOB",
  );
  assert.equal(
    readdirSync(box.root).some((name) => name.startsWith(".chronos-restore-")),
    false,
    "the staging directory is cleaned up",
  );
  assert.throws(
    () => statSync(target),
    (error) => error.code === "ENOENT",
  );
});

test("a tampered manifest is refused before anything is written", (t) => {
  const box = sandbox(t);
  box.write("a.txt", "a");
  const { manifest } = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });

  assert.throws(
    () =>
      restoreSnapshot({
        manifest: { ...manifest, ref: blobRef(bytes("wrong")) },
        store: box.store,
        targetPath: box.target(),
      }),
    (error) => error.code === "DIGEST_MISMATCH",
  );
  assert.throws(
    () =>
      restoreSnapshot({
        manifest: {
          ...manifest,
          files: [{ ...manifest.files[0], path: "../escape.txt" }],
        },
        store: box.store,
        targetPath: box.target(),
      }),
    (error) => error.code === "INVALID_PATH",
  );
});

test("capture limits stop a workspace that is too large", (t) => {
  const box = sandbox(t);
  box.write("small.txt", "ok");
  box.write("large.txt", "x".repeat(64));

  assert.throws(
    () =>
      captureWorkspace({
        workspaceRoot: box.workspace,
        store: box.store,
        limits: { maxFileBytes: 8 },
      }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      captureWorkspace({
        workspaceRoot: box.workspace,
        store: box.store,
        limits: { maxFiles: 1 },
      }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      captureWorkspace({
        workspaceRoot: join(box.root, "missing"),
        store: box.store,
      }),
    (error) => error.code === "IO_FAILED",
  );
});

test("a file count limit stops the walk before the excess file is read", (t) => {
  const box = sandbox(t);
  box.write("a.txt", "first");
  box.write("z.txt", "z".repeat(64));

  assert.throws(
    () =>
      captureWorkspace({
        workspaceRoot: box.workspace,
        store: box.store,
        limits: { maxFiles: 1 },
      }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  // z.txt sorts after a.txt, so it is the one the limit should stop the
  // walk from ever opening, reading, or storing.
  assert.equal(box.store.has(blobRef(bytes("z".repeat(64)))), false);
});

test("a total-bytes limit stops the walk before the excess file is read", (t) => {
  const box = sandbox(t);
  box.write("a.txt", "x".repeat(10));
  box.write("z.txt", "z".repeat(10));

  assert.throws(
    () =>
      captureWorkspace({
        workspaceRoot: box.workspace,
        store: box.store,
        limits: { maxTotalBytes: 10 },
      }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  // a.txt alone already spends the whole cap, so z.txt must never be opened,
  // read, or stored — the limit has to stop the walk mid-traversal, not only
  // reject the finished manifest afterward.
  assert.equal(box.store.has(blobRef(bytes("z".repeat(10)))), false);
});

test("the default file-size limit is enforced during the walk, not only afterward", (t) => {
  const box = sandbox(t);
  const oversized = "x".repeat(16 * 1024 * 1024 + 1);
  box.write("a-oversized.bin", oversized);
  box.write("z-small.txt", "small");

  assert.throws(
    () =>
      captureWorkspace({
        workspaceRoot: box.workspace,
        store: box.store,
      }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  // No explicit limits were given, so this only passes if the default
  // maxFileBytes (16 MiB) is resolved and enforced against every file as the
  // walk visits it — not just re-discovered by buildManifest once the whole
  // oversized file, and everything after it, was already read and stored.
  assert.equal(box.store.has(blobRef(bytes(oversized))), false);
  assert.equal(box.store.has(blobRef(bytes("small"))), false);
});

test("in-place restore rewrites included files and leaves exclusions alone", (t) => {
  const box = sandbox(t);
  box.write("keep.txt", "v1");
  box.write("gone.txt", "delete-me");
  mkdirSync(join(box.workspace, ".git"), { recursive: true });
  writeFileSync(join(box.workspace, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(box.workspace, ".env"), "SECRET=1");

  const baseline = captureWorkspace({
    workspaceRoot: box.workspace,
    store: box.store,
  });
  box.write("keep.txt", "v2");
  box.write("extra.txt", "new");

  const result = restoreSnapshotInPlace({
    manifest: baseline.manifest,
    store: box.store,
    workspaceRoot: box.workspace,
  });

  assert.equal(readFileSync(join(box.workspace, "keep.txt"), "utf8"), "v1");
  assert.equal(existsSync(join(box.workspace, "gone.txt")), true);
  assert.equal(existsSync(join(box.workspace, "extra.txt")), false);
  assert.equal(readFileSync(join(box.workspace, ".env"), "utf8"), "SECRET=1");
  assert.equal(
    readFileSync(join(box.workspace, ".git", "HEAD"), "utf8"),
    "ref: refs/heads/main",
  );
  assert.ok(result.filesWritten >= 1);
  assert.ok(result.filesRemoved >= 1);
});
