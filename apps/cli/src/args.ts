import { usageError } from "./errors.js";

export interface FlagSpec {
  readonly type: "boolean" | "string";
  readonly description: string;
}

export interface PositionalSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly positionals: readonly PositionalSpec[];
  readonly flags: Readonly<Record<string, FlagSpec>>;
  /**
   * When true, extra argv after the declared positionals is kept (for
   * `chronos wrap -- cmd ...`). Without this, surplus tokens are a usage error.
   */
  readonly rest?: boolean;
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Parse one command's arguments strictly.
 *
 * An unknown flag is an error rather than something silently ignored: a typo
 * in `--no-redact` must not quietly leave redaction on, and a typo in a path
 * flag must not quietly write to the default location.
 */
export function parseArgs(
  spec: CommandSpec,
  argv: readonly string[],
): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (literal || !argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      literal = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name =
      separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const inlineValue =
      separator === -1 ? undefined : argument.slice(separator + 1);
    const flagSpec = spec.flags[name];
    if (flagSpec === undefined) {
      usageError(
        `Unknown option: --${name}`,
        `Run "chronos ${spec.name} --help" to see what this command accepts`,
      );
    }
    if (Object.hasOwn(flags, name)) {
      usageError(`Option --${name} was given more than once`);
    }
    if (flagSpec.type === "boolean") {
      if (inlineValue !== undefined) {
        usageError(`--${name} does not take a value`);
      }
      flags[name] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (
      value === undefined ||
      (inlineValue === undefined && value.startsWith("--"))
    ) {
      usageError(`--${name} needs a value`);
    }
    if (inlineValue === undefined) index += 1;
    flags[name] = value;
  }

  const required = spec.positionals.filter((item) => item.required);
  if (positionals.length < required.length) {
    usageError(
      `${spec.name} needs ${String(required.length)} argument${required.length === 1 ? "" : "s"}`,
      usageLine(spec),
    );
  }
  if (!spec.rest && positionals.length > spec.positionals.length) {
    usageError(
      `${spec.name} takes at most ${String(spec.positionals.length)} arguments`,
      usageLine(spec),
    );
  }
  return {
    positionals: Object.freeze(positionals),
    flags: Object.freeze(flags),
  };
}

export function usageLine(spec: CommandSpec): string {
  const parts = spec.positionals.map((item) =>
    item.required ? `<${item.name}>` : `[${item.name}]`,
  );
  if (spec.rest) parts.push("--", "<command>...");
  return `Usage: chronos ${spec.name} ${parts.join(" ")} [options]`.trim();
}

export function helpText(spec: CommandSpec): string {
  const lines = [usageLine(spec), "", spec.summary];
  if (spec.positionals.length > 0 || spec.rest) {
    lines.push("", "Arguments:");
    for (const item of spec.positionals) {
      lines.push(`  ${item.name.padEnd(20)}${item.description}`);
    }
    if (spec.rest) {
      lines.push(
        `  ${"command".padEnd(20)}Executable and args after -- (required)`,
      );
    }
  }
  const flagNames = Object.keys(spec.flags).sort();
  if (flagNames.length > 0) {
    lines.push("", "Options:");
    for (const name of flagNames) {
      const flag = spec.flags[name]!;
      const label = flag.type === "string" ? `--${name} <value>` : `--${name}`;
      lines.push(`  ${label.padEnd(20)}${flag.description}`);
    }
  }
  return lines.join("\n");
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    usageError(`--${name} needs a value`);
  }
  return value;
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function requiredPositional(
  args: ParsedArgs,
  index: number,
  name: string,
): string {
  const value = args.positionals[index];
  if (value === undefined || value.trim().length === 0) {
    usageError(`${name} is required`);
  }
  return value;
}
