import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

import type { ProviderAgent } from "@chronos/adapters";

import { failure, usageError } from "./errors.js";

/**
 * Resolving and pinning the provider executable is one implementation shared
 * by `record` and `launch`: both spawn a real Codex or Claude Code binary,
 * and both need the same defense against PATH aliases, symlinks, non-native
 * Windows shims, and an executable rewritten in place after it was resolved.
 */
export interface ExecutableIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/** Resolve a fixed provider name to one canonical regular executable. */
export function resolveProviderExecutable(
  agent: ProviderAgent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pathValue = env["PATH"];
  if (typeof pathValue !== "string" || pathValue.length === 0)
    failure(`Could not resolve the ${agent} executable: PATH is empty`);
  const extensions =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE")
          .split(";")
          .filter((value) => /^(\.exe|\.com)$/iu.test(value))
          .filter((value) => value.length > 0)
      : [""];
  const names =
    process.platform === "win32" && extname(agent).length === 0
      ? extensions.map((extension) => `${agent}${extension}`)
      : [agent];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (!existsSync(candidate)) continue;
      let before;
      try {
        before = lstatSync(candidate);
        if (!before.isFile() || before.isSymbolicLink()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        const canonical = realpathSync.native(candidate);
        const after = lstatSync(canonical);
        if (!isAbsolute(canonical) || !after.isFile() || after.isSymbolicLink())
          continue;
        if (before.dev !== after.dev || before.ino !== after.ino) continue;
        return canonical;
      } catch {
        continue;
      }
    }
  }
  failure(`Could not resolve a safe ${agent} executable from PATH`);
}

export function isSupportedWindowsExecutablePath(path: string): boolean {
  return /\.(?:exe|com)$/iu.test(extname(path));
}

export function validateProviderExecutable(path: string): string {
  if (!isAbsolute(path))
    failure("Provider executable must be an absolute path");
  try {
    if (process.platform === "win32" && !isSupportedWindowsExecutablePath(path))
      failure("Provider executable must be a native Windows .exe or .com file");
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink())
      failure("Provider executable must be a real regular file");
    const canonical = realpathSync.native(path);
    const after = lstatSync(canonical);
    if (
      canonical !== path ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      failure("Provider executable must be one canonical regular file");
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    failure("Provider executable could not be safely inspected");
  }
}

export function inspectExecutable(path: string): ExecutableIdentity {
  const canonical = validateProviderExecutable(path);
  const stats = lstatSync(canonical);
  return Object.freeze({ path: canonical, dev: stats.dev, ino: stats.ino });
}

/** Re-check a pinned executable's identity; throws if it changed underneath us. */
export function assertExecutableIdentity(expected: ExecutableIdentity): void {
  const current = inspectExecutable(expected.path);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    failure("Provider executable changed since it was resolved");
}

export function requireProviderAgent(value: string | undefined): ProviderAgent {
  if (value === "codex" || value === "claude") return value;
  usageError("--agent must be codex or claude");
}
