import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_PATH_POLICY,
  DEFAULT_SECRET_PATTERNS,
  classifyPath,
  pathPolicy,
} from "../dist/index.js";

function decide(path, kind = "file", policy) {
  return classifyPath(path, kind, policy);
}

test("source files are included by default", () => {
  for (const path of [
    "src/index.ts",
    "README.md",
    "package.json",
    "docs/formats/chronos-jsonl.md",
    "src/distribution.ts",
    "src/outbound.ts",
  ]) {
    assert.deepEqual(decide(path), { included: true }, path);
  }
});

test("version control state and generated output are ignored", () => {
  const cases = [
    [".git/config", ".git/"],
    [".git", ".git/"],
    ["node_modules/left-pad/index.js", "**/node_modules/"],
    ["packages/core/node_modules/x/y.js", "**/node_modules/"],
    ["dist/index.js", "**/dist/"],
    ["packages/core/dist/index.js", "**/dist/"],
    ["target/debug/app", "**/target/"],
    ["src/__pycache__/mod.pyc", "**/__pycache__/"],
    ["packages/core/tsconfig.tsbuildinfo", "**/*.tsbuildinfo"],
    ["assets/.DS_Store", "**/.DS_Store"],
  ];

  for (const [path, pattern] of cases) {
    assert.deepEqual(
      decide(path),
      {
        included: false,
        reason: "ignored",
        pattern,
      },
      path,
    );
  }
});

test("likely secrets are excluded, and the sample files beside them are not", () => {
  const cases = [
    [".env", "**/.env"],
    ["apps/web/.env.production", "**/.env.*"],
    ["certs/server.pem", "**/*.pem"],
    ["certs/server.key", "**/*.key"],
    ["home/.ssh/config", "**/.ssh/"],
    ["keys/id_ed25519", "**/id_ed25519"],
    [".npmrc", "**/.npmrc"],
    ["config/secrets.yaml", "**/secrets.*"],
  ];

  for (const [path, pattern] of cases) {
    assert.deepEqual(
      decide(path),
      {
        included: false,
        reason: "secret",
        pattern,
      },
      path,
    );
  }

  assert.deepEqual(decide(".env.example"), { included: true });
  assert.deepEqual(decide("apps/web/.env.sample"), { included: true });
});

test("unsafe paths are refused before any pattern is consulted", () => {
  assert.deepEqual(decide("../outside.txt"), {
    included: false,
    reason: "unsafe_path",
    detail: "traversal",
  });
  assert.deepEqual(decide("/etc/passwd"), {
    included: false,
    reason: "unsafe_path",
    detail: "absolute",
  });
});

test("only regular files and directories can be captured", () => {
  assert.deepEqual(decide("run/app.sock", "other"), {
    included: false,
    reason: "unsupported_entry",
    detail: "other",
  });
  assert.deepEqual(decide("src/link.ts", "symlink"), {
    included: false,
    reason: "unsupported_entry",
    detail: "symlink",
  });
  assert.deepEqual(decide("src", "directory"), { included: true });
});

test("a custom policy replaces the defaults it names", () => {
  const policy = pathPolicy({
    ignore: ["/build/", "**/*.log"],
    secrets: [],
    include: [],
  });

  assert.deepEqual(decide("build/app.js", "file", policy), {
    included: false,
    reason: "ignored",
    pattern: "/build/",
  });
  // An anchored pattern only claims the workspace root.
  assert.deepEqual(decide("packages/core/build/app.js", "file", policy), {
    included: true,
  });
  assert.deepEqual(decide("logs/run.log", "file", policy), {
    included: false,
    reason: "ignored",
    pattern: "**/*.log",
  });
  assert.deepEqual(decide(".env", "file", policy), { included: true });
  assert.deepEqual(decide("node_modules/x/y.js", "file", policy), {
    included: true,
  });
});

test("an explicit include wins over ignore and secret patterns", () => {
  const policy = pathPolicy({ include: ["**/.env.example", "dist/keep.js"] });

  assert.deepEqual(decide("dist/keep.js", "file", policy), { included: true });
  assert.deepEqual(decide("dist/other.js", "file", policy), {
    included: false,
    reason: "ignored",
    pattern: "**/dist/",
  });
});

test("single-character and single-segment wildcards stay inside a segment", () => {
  const policy = pathPolicy({ ignore: ["*.tmp", "cache?/"], secrets: [] });

  assert.equal(decide("a.tmp", "file", policy).included, false);
  assert.equal(decide("src/a.tmp", "file", policy).included, false);
  assert.equal(decide("a.tmp.keep", "file", policy).included, true);
  assert.equal(decide("cache1/x", "file", policy).included, false);
  assert.equal(decide("cache12/x", "file", policy).included, true);
});

test("a malformed policy is rejected", () => {
  assert.throws(
    () => pathPolicy({ ignore: ["  "] }),
    (error) => error.code === "INVALID_POLICY",
  );
  assert.throws(
    () => pathPolicy({ secrets: ["src\\*.ts"] }),
    (error) => error.code === "INVALID_POLICY",
  );
  assert.throws(
    () => pathPolicy({ include: "**/*.ts" }),
    (error) => error.code === "INVALID_POLICY",
  );
  assert.equal(DEFAULT_PATH_POLICY.ignore, DEFAULT_IGNORE_PATTERNS);
  assert.equal(DEFAULT_PATH_POLICY.secrets, DEFAULT_SECRET_PATTERNS);
});
