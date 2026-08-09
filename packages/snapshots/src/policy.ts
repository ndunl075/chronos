import { fail } from "./errors.js";
import { checkWorkspacePath, type PathLimits } from "./paths.js";

/** What a directory walk found at a path. */
export type EntryKind = "file" | "directory" | "symlink" | "other";

export type ExclusionReason =
  "unsafe_path" | "unsupported_entry" | "ignored" | "secret";

export type PathDecision =
  | { readonly included: true }
  | {
      readonly included: false;
      readonly reason: ExclusionReason;
      /** The pattern that decided it, when a pattern did. */
      readonly pattern?: string;
      readonly detail?: string;
    };

export interface PathPolicy {
  /** Generated output and version-control state. */
  readonly ignore: readonly string[];
  /** Patterns treated as secrets. Detection is best-effort. */
  readonly secrets: readonly string[];
  /** Re-includes checked last, except the reserved `.chronos/` runtime root. */
  readonly include: readonly string[];
}

/*
 * Excluding version-control state and generated output is what makes a
 * snapshot small enough to take after every mutating tool call. `.git` is
 * excluded because restoring half a repository into a new directory produces
 * a workspace that lies about its own history.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  ".chronos/",
  ".git/",
  ".hg/",
  ".svn/",
  "**/node_modules/",
  "**/.venv/",
  "**/venv/",
  "**/__pycache__/",
  "**/.mypy_cache/",
  "**/.pytest_cache/",
  "**/target/",
  "**/dist/",
  "**/build/",
  "**/out/",
  "**/coverage/",
  "**/.next/",
  "**/.nuxt/",
  "**/.turbo/",
  "**/.cache/",
  "**/.gradle/",
  "**/.terraform/",
  "**/*.tsbuildinfo",
  "**/.DS_Store",
]);

export const DEFAULT_SECRET_PATTERNS: readonly string[] = Object.freeze([
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.p12",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
  "**/.aws/credentials",
  "**/.ssh/",
  "**/secrets.*",
  "**/*.keystore",
]);

/** Files kept even though a secret pattern matches their neighbours. */
const DEFAULT_INCLUDE_PATTERNS: readonly string[] = Object.freeze([
  "**/.env.example",
  "**/.env.sample",
]);

export const DEFAULT_PATH_POLICY: PathPolicy = Object.freeze({
  ignore: DEFAULT_IGNORE_PATTERNS,
  secrets: DEFAULT_SECRET_PATTERNS,
  include: DEFAULT_INCLUDE_PATTERNS,
});

export function pathPolicy(overrides: Partial<PathPolicy> = {}): PathPolicy {
  return Object.freeze({
    ignore: patternList(overrides.ignore ?? DEFAULT_IGNORE_PATTERNS, "ignore"),
    secrets: patternList(
      overrides.secrets ?? DEFAULT_SECRET_PATTERNS,
      "secrets",
    ),
    include: patternList(
      overrides.include ?? DEFAULT_INCLUDE_PATTERNS,
      "include",
    ),
  });
}

/**
 * Decide whether one walked entry belongs in a snapshot.
 *
 * Order matters: an unsafe path is refused before any pattern is consulted,
 * anything that is not a regular file or directory is refused because a
 * socket or device cannot be restored faithfully. The reserved `.chronos/`
 * root is never overridable; other explicit includes override ignore and
 * secret patterns because the user asked for them.
 */
export function classifyPath(
  path: string,
  kind: EntryKind,
  policy: PathPolicy = DEFAULT_PATH_POLICY,
  limits?: PathLimits,
): PathDecision {
  const rejection = checkWorkspacePath(path, limits);
  if (rejection !== undefined) {
    return Object.freeze({
      included: false,
      reason: "unsafe_path",
      detail: rejection,
    });
  }
  if (kind !== "file" && kind !== "directory") {
    return Object.freeze({
      included: false,
      reason: "unsupported_entry",
      detail: kind,
    });
  }
  // Chronos runtime material is never workspace state. Treat the reserved
  // root name case-insensitively on every host so a capture made on Linux
  // cannot restore `.ChRoNoS` onto a case-insensitive Windows filesystem.
  if (path.split("/", 1)[0]?.toLowerCase() === ".chronos") {
    return Object.freeze({
      included: false,
      reason: "ignored",
      pattern: ".chronos/",
    });
  }
  if (matches(path, policy.include) !== undefined) {
    return Object.freeze({ included: true });
  }
  const secret = matches(path, policy.secrets);
  if (secret !== undefined) {
    return Object.freeze({
      included: false,
      reason: "secret",
      pattern: secret,
    });
  }
  const ignored = matches(path, policy.ignore);
  if (ignored !== undefined) {
    return Object.freeze({
      included: false,
      reason: "ignored",
      pattern: ignored,
    });
  }
  return Object.freeze({ included: true });
}

function matches(
  path: string,
  patterns: readonly string[],
): string | undefined {
  for (const pattern of patterns) {
    if (compile(pattern).test(path)) return pattern;
  }
  return undefined;
}

const compiled = new Map<string, RegExp>();

/**
 * Compile the gitignore-style subset Chronos supports: `*` within a segment,
 * `?` for one character, `**` across segments, a trailing `/` for directories
 * and everything under them, and a leading `/` to anchor at the workspace
 * root. Character classes and negation are deliberately absent; a policy is
 * configuration, and a surprising match here silently drops a user's file.
 */
function compile(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;

  const directoryOnly = pattern.endsWith("/");
  let body = directoryOnly ? pattern.slice(0, -1) : pattern;
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);

  let source = "";
  let index = 0;
  while (index < body.length) {
    const character = body[index]!;
    if (character === "*") {
      if (body[index + 1] === "*") {
        // `**/` also matches zero directories, so `**/x` matches a root `x`.
        if (body[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += character.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }

  const prefix = anchored ? "^" : "^(?:[^/]+/)*";
  // A directory pattern also claims everything beneath the directory.
  const suffix = directoryOnly ? "(?:/.*)?$" : "$";
  const expression = new RegExp(`${prefix}${source}${suffix}`);
  compiled.set(pattern, expression);
  return expression;
}

function patternList(
  patterns: readonly string[],
  label: string,
): readonly string[] {
  if (!Array.isArray(patterns)) {
    fail("INVALID_POLICY", `${label} must be an array of patterns`);
  }
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      fail("INVALID_POLICY", `${label} contains an empty pattern`);
    }
    if (pattern.includes("\\")) {
      fail("INVALID_POLICY", `${label} patterns use forward slashes`);
    }
  }
  return Object.freeze([...patterns]);
}
