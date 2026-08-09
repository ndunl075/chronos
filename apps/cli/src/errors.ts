/**
 * Exit codes the CLI promises. A script can tell "you typed it wrong" from
 * "Chronos could not do it", which is the distinction that matters when the
 * command is in a pipeline.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export class CliError extends Error {
  readonly exitCode: number;
  /** A line printed after the message, when there is something to suggest. */
  readonly hint: string | undefined;

  constructor(message: string, exitCode = EXIT_FAILURE, hint?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function usageError(message: string, hint?: string): never {
  throw new CliError(message, EXIT_USAGE, hint);
}

export function failure(message: string, hint?: string): never {
  throw new CliError(message, EXIT_FAILURE, hint);
}
