export interface Streams {
  write(text: string): void;
  writeError(text: string): void;
}

/**
 * Two ways to answer, chosen once per invocation.
 *
 * `--json` prints one object and nothing else, so a script can parse stdout
 * without stripping progress lines. Human output goes to stdout too; only
 * warnings and failures go to stderr.
 */
export class Reporter {
  readonly json: boolean;
  #streams: Streams;

  constructor(streams: Streams, json: boolean) {
    this.#streams = streams;
    this.json = json;
    Object.freeze(this);
  }

  /** A line of human output. Suppressed entirely in JSON mode. */
  line(text = ""): void {
    if (this.json) return;
    this.#streams.write(`${text}\n`);
  }

  /** A warning. It is printed in both modes, always to stderr. */
  warn(text: string): void {
    this.#streams.writeError(`warning: ${text}\n`);
  }

  error(text: string): void {
    this.#streams.writeError(`error: ${text}\n`);
  }

  /** The machine-readable result, printed only in JSON mode. */
  result(value: unknown): void {
    if (!this.json) return;
    this.#streams.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

/** Pad a table so columns line up without pulling in a formatting library. */
export function table(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}
