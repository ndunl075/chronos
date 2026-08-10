import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  SNAPSHOT_MANIFEST_VERSION,
  applyManifestDiff,
  applyManifestDiffChain,
  blobRef,
  buildManifest,
  contentRefEquals,
  diffManifests,
  isContentRef,
  manifestBlobRefs,
  parseManifest,
  parseManifestDiff,
  serializeManifest,
  serializeManifestDiff,
  verifyManifest,
} from "../dist/index.js";

const bytes = (text) => new TextEncoder().encode(text);
const ref = (text) =>
  `sha256:${createHash("sha256").update(bytes(text)).digest("hex")}`;

function file(path, text, mode) {
  return {
    path,
    size: bytes(text).length,
    digest: ref(text),
    ...(mode === undefined ? {} : { mode }),
  };
}

test("a blob address is the sha-256 of its bytes", () => {
  assert.equal(
    blobRef(bytes("hello")),
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assert.equal(isContentRef(blobRef(bytes(""))), true);
  assert.equal(isContentRef("sha256:not-hex"), false);
  assert.equal(isContentRef("md5:abc"), false);
  assert.equal(contentRefEquals(blobRef(bytes("a")), ref("a")), true);
  assert.equal(contentRefEquals(ref("a"), ref("b")), false);
  assert.equal(contentRefEquals("nonsense", "nonsense"), false);
  assert.throws(
    () => blobRef("hello"),
    (error) => error.code === "INVALID_MANIFEST",
  );
});

test("a manifest is ordered, deduplicated of directories, and addressable", () => {
  const manifest = buildManifest({
    files: [
      file("src/b.ts", "beta"),
      file("README.md", "readme"),
      file("bin/run", "#!/bin/sh", "executable"),
    ],
    directories: ["src", "empty/nested", "bin"],
  });

  assert.equal(manifest.version, SNAPSHOT_MANIFEST_VERSION);
  assert.equal(manifest.algorithm, "sha256");
  assert.deepEqual(
    manifest.files.map((item) => item.path),
    ["README.md", "bin/run", "src/b.ts"],
  );
  assert.equal(manifest.files[1].mode, "executable");
  assert.equal(manifest.files[0].mode, "file");
  // "src" and "bin" already hold a file; only the genuinely empty one stays.
  assert.deepEqual(manifest.directories, ["empty/nested"]);
  assert.equal(manifest.totalBytes, 6 + 9 + 4);
  assert.equal(isContentRef(manifest.ref), true);
});

test("identical content produces an identical address", () => {
  const first = buildManifest({ files: [file("a.txt", "same")] });
  const second = buildManifest({
    files: [file("a.txt", "same")],
    directories: [],
  });
  const different = buildManifest({ files: [file("a.txt", "other")] });

  assert.equal(first.ref, second.ref);
  assert.notEqual(first.ref, different.ref);

  // Input order does not change the address.
  const ordered = buildManifest({
    files: [file("a.txt", "x"), file("b.txt", "y")],
  });
  const reversed = buildManifest({
    files: [file("b.txt", "y"), file("a.txt", "x")],
  });
  assert.equal(ordered.ref, reversed.ref);
});

test("manifests round-trip through their canonical serialization", () => {
  const manifest = buildManifest({
    files: [file("src/index.ts", "code"), file("bin/run", "sh", "executable")],
    directories: ["docs"],
  });
  const serialized = serializeManifest(manifest);
  const parsed = parseManifest(serialized);

  assert.deepEqual(parsed, manifest);
  assert.equal(parsed.ref, manifest.ref);
  assert.equal(serializeManifest(parsed), serialized);
  assert.equal(JSON.parse(serialized).ref, undefined);
});

test("a manifest that is not in canonical form is refused", () => {
  const manifest = buildManifest({ files: [file("a.txt", "x")] });
  const decoded = JSON.parse(serializeManifest(manifest));

  assert.throws(
    () => parseManifest(JSON.stringify({ ...decoded, totalBytes: 999 })),
    (error) => error.code === "INVALID_MANIFEST",
  );
  assert.throws(
    () => parseManifest(JSON.stringify({ ...decoded, version: 2 })),
    (error) => error.code === "INVALID_MANIFEST",
  );
  assert.throws(
    () => parseManifest(JSON.stringify({ ...decoded, algorithm: "md5" })),
    (error) => error.code === "INVALID_MANIFEST",
  );
  assert.throws(
    () => parseManifest(`  ${serializeManifest(manifest)}  `),
    (error) => error.code === "INVALID_MANIFEST",
  );
  assert.throws(
    () => parseManifest("{not json"),
    (error) => error.code === "INVALID_MANIFEST",
  );
});

test("verification recomputes the address instead of trusting it", () => {
  const manifest = buildManifest({ files: [file("a.txt", "x")] });

  assert.equal(verifyManifest(manifest).ref, manifest.ref);
  assert.throws(
    () => verifyManifest({ ...manifest, ref: ref("tampered") }),
    (error) => error.code === "DIGEST_MISMATCH",
  );
});

test("unsafe or malformed entries never reach a manifest", () => {
  const cases = [
    [{ files: [file("../escape.txt", "x")] }, "INVALID_PATH"],
    [{ files: [file("a.txt", "x"), file("a.txt", "y")] }, "INVALID_MANIFEST"],
    [
      { files: [{ path: "a.txt", size: -1, digest: ref("x") }] },
      "INVALID_MANIFEST",
    ],
    [
      { files: [{ path: "a.txt", size: 1, digest: "nope" }] },
      "INVALID_MANIFEST",
    ],
    [{ files: [file("a.txt", "x", "setuid")] }, "INVALID_MANIFEST"],
    [{ files: "everything" }, "INVALID_MANIFEST"],
    [{ files: [], directories: ["../outside"] }, "INVALID_PATH"],
  ];

  for (const [input, code] of cases) {
    assert.throws(
      () => buildManifest(input),
      (error) => error.code === code,
      JSON.stringify(input),
    );
  }
});

test("limits cap file count, file size, and total size", () => {
  const files = [file("a.txt", "aaaa"), file("b.txt", "bbbb")];

  assert.throws(
    () => buildManifest({ files }, { maxFiles: 1 }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () => buildManifest({ files }, { maxFileBytes: 3 }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () => buildManifest({ files }, { maxTotalBytes: 5 }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () => buildManifest({ files }, { maxFiles: 0 }),
    (error) => error.code === "INVALID_OPTIONS",
  );
  assert.equal(buildManifest({ files }, { maxTotalBytes: 8 }).totalBytes, 8);
});

test("a diff describes what a restore has to apply", () => {
  const base = buildManifest({
    files: [
      file("keep.txt", "same"),
      file("change.txt", "before"),
      file("gone.txt", "removed"),
      file("mode.sh", "run"),
    ],
    directories: ["old-empty"],
  });
  const target = buildManifest({
    files: [
      file("keep.txt", "same"),
      file("change.txt", "after"),
      file("new.txt", "added"),
      file("mode.sh", "run", "executable"),
    ],
    directories: ["new-empty"],
  });

  const diff = diffManifests(base, target);

  assert.deepEqual(
    diff.added.map((item) => item.path),
    ["new.txt"],
  );
  assert.deepEqual(
    diff.modified.map((item) => item.after.path),
    ["change.txt", "mode.sh"],
  );
  assert.equal(diff.modified[0].before.digest, ref("before"));
  assert.equal(diff.modified[0].after.digest, ref("after"));
  assert.deepEqual(
    diff.removed.map((item) => item.path),
    ["gone.txt"],
  );
  assert.deepEqual(diff.addedDirectories, ["new-empty"]);
  assert.deepEqual(diff.removedDirectories, ["old-empty"]);
  assert.equal(diff.unchangedFiles, 1);

  const unchanged = diffManifests(base, base);
  assert.deepEqual(
    [unchanged.added, unchanged.modified, unchanged.removed],
    [[], [], []],
  );
  assert.equal(unchanged.unchangedFiles, base.files.length);
});

test("applying a diff reconstructs the target manifest", () => {
  const base = buildManifest({
    files: [
      file("keep.txt", "same"),
      file("change.txt", "before"),
      file("gone.txt", "removed"),
    ],
    directories: ["old-empty"],
  });
  const target = buildManifest({
    files: [
      file("keep.txt", "same"),
      file("change.txt", "after"),
      file("new.txt", "added"),
    ],
    directories: ["new-empty"],
  });
  const diff = diffManifests(base, target);
  const applied = applyManifestDiff(base, diff);
  assert.equal(applied.ref, target.ref);
  assert.equal(
    applyManifestDiffChain(base, [diff]).ref,
    target.ref,
  );
});

test("manifest diffs round-trip through their canonical serialization", () => {
  const base = buildManifest({
    files: [file("a.txt", "one"), file("b.txt", "two")],
    directories: ["empty"],
  });
  const target = buildManifest({
    files: [file("a.txt", "changed"), file("c.txt", "three", "executable")],
    directories: ["other"],
  });
  const diff = diffManifests(base, target);
  assert.equal(diff.modified.length, 1);
  const serialized = serializeManifestDiff(diff);
  const parsed = parseManifestDiff(serialized);
  assert.deepEqual(parsed, diff);
  assert.equal(serializeManifestDiff(parsed), serialized);
  assert.throws(
    () => parseManifestDiff(serialized.replace('"sha256:', '"SHA256:')),
    (error) => error.code === "INVALID_MANIFEST",
  );
  assert.throws(
    () =>
      applyManifestDiff(base, {
        ...diff,
        modified: [
          {
            before: { ...diff.modified[0].before, digest: ref("wrong") },
            after: diff.modified[0].after,
          },
        ],
      }),
    (error) => error.code === "DIGEST_MISMATCH",
  );
});

test("blob addresses are deduplicated for the content store", () => {
  const manifest = buildManifest({
    files: [
      file("a.txt", "same"),
      file("b.txt", "same"),
      file("c.txt", "other"),
    ],
  });

  assert.deepEqual(
    manifestBlobRefs(manifest),
    [ref("other"), ref("same")].sort(),
  );
});
