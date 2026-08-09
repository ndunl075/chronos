import assert from "node:assert/strict";
import test from "node:test";

import {
  SnapshotError,
  checkWorkspacePath,
  compareWorkspacePaths,
  isWithin,
  isWorkspacePath,
  workspacePath,
  workspacePathFromSegments,
} from "../dist/index.js";

test("ordinary workspace paths are accepted unchanged", () => {
  for (const value of [
    "README.md",
    "src/index.ts",
    "a/b/c/d.txt",
    ".gitignore",
    "src/.hidden/file",
    "space in name.md",
    "unicode-\u00e9\u00e8.txt",
  ]) {
    assert.equal(isWorkspacePath(value), true, value);
    assert.equal(workspacePath(value).value, value);
  }

  assert.deepEqual(workspacePath("a/b.txt").segments, ["a", "b.txt"]);
});

test("paths that could escape the workspace are rejected", () => {
  const cases = {
    "": "empty",
    "/etc/passwd": "absolute",
    "//server/share/file": "unc_path",
    "C:/Windows/System32": "drive_letter",
    "src\\index.ts": "backslash",
    "../outside.txt": "traversal",
    "src/../../outside.txt": "traversal",
    "./src/index.ts": "relative_segment",
    "src//index.ts": "empty_segment",
    "src/": "empty_segment",
  };

  for (const [value, reason] of Object.entries(cases)) {
    assert.equal(checkWorkspacePath(value), reason, value);
    assert.throws(
      () => workspacePath(value),
      (error) => {
        assert.ok(error instanceof SnapshotError);
        assert.equal(error.code, "INVALID_PATH");
        assert.equal(error.details.reason, reason);
        return true;
      },
      value,
    );
  }
});

test("paths no host could restore faithfully are rejected", () => {
  assert.equal(checkWorkspacePath("src/bell\u0007.txt"), "control_character");
  assert.equal(checkWorkspacePath("src/nul\u0000.txt"), "control_character");
  assert.equal(checkWorkspacePath("aux"), "reserved_device_name");
  assert.equal(checkWorkspacePath("src/COM1.txt"), "reserved_device_name");
  assert.equal(checkWorkspacePath("src/name."), "trailing_dot_or_space");
  assert.equal(checkWorkspacePath("src/name "), "trailing_dot_or_space");
  assert.equal(checkWorkspacePath(42), "empty");
  assert.equal(checkWorkspacePath(undefined), "empty");

  // "auxiliary.ts" is a normal file; only the reserved stem is refused.
  assert.equal(checkWorkspacePath("src/auxiliary.ts"), undefined);
});

test("limits bound path length, segment length, and depth", () => {
  assert.equal(checkWorkspacePath("a".repeat(300)), "segment_too_long");
  assert.equal(checkWorkspacePath(`${"a/".repeat(600)}b`), "path_too_long");
  assert.equal(checkWorkspacePath("a/b/c", { maxDepth: 2 }), "too_deep");
  assert.equal(
    checkWorkspacePath("abc", { maxSegmentLength: 2 }),
    "segment_too_long",
  );
  assert.throws(
    () => checkWorkspacePath("a", { maxDepth: 0 }),
    (error) => error.code === "INVALID_OPTIONS",
  );
});

test("segments from a walk become one canonical recorded path", () => {
  assert.equal(
    workspacePathFromSegments(["src", "index.ts"]).value,
    "src/index.ts",
  );
  assert.throws(
    () => workspacePathFromSegments([]),
    (error) => error.details.reason === "empty",
  );
  assert.throws(
    () => workspacePathFromSegments(["src", ".."]),
    (error) => error.details.reason === "traversal",
  );
  assert.throws(
    () => workspacePathFromSegments(["src", 1]),
    (error) => error.code === "INVALID_PATH",
  );
});

test("containment compares whole segments, not string prefixes", () => {
  const directory = workspacePath("src/app");

  assert.equal(isWithin(directory, workspacePath("src/app")), true);
  assert.equal(isWithin(directory, workspacePath("src/app/main.ts")), true);
  assert.equal(isWithin(directory, workspacePath("src/application.ts")), false);
  assert.equal(isWithin(directory, workspacePath("src")), false);
});

test("manifest ordering is stable and byte-wise", () => {
  const paths = ["b.txt", "a/z.txt", "a.txt", "a/a.txt"];

  assert.deepEqual([...paths].sort(compareWorkspacePaths), [
    "a.txt",
    "a/a.txt",
    "a/z.txt",
    "b.txt",
  ]);
  assert.equal(compareWorkspacePaths("a", "a"), 0);
});
