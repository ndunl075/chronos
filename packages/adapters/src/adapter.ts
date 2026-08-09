import type { Branch, Checkpoint, Event, Session } from "@chronos/protocol";

import type { RedactionPolicy } from "./redaction.js";

/** Bounds applied while reading a source file. */
export interface ImportLimits {
  /** Most UTF-16 code units accepted before line splitting. Defaults to 67108864. */
  readonly maxInputLength?: number;
  /** Longest accepted line, in UTF-16 code units. Defaults to 1048576. */
  readonly maxLineLength?: number;
  /** Most records accepted from one file. Defaults to 200000. */
  readonly maxRecords?: number;
}

export interface ImportOptions {
  /**
   * Keep references to provider data held outside canonical storage. Off by
   * default: raw retention is opt-in, and the bytes belong in a separate
   * encrypted store that exports never include.
   */
  readonly retainRaw?: boolean;
  readonly limits?: ImportLimits;
  /**
   * Secret patterns applied to canonical data before it is returned. Defaults
   * to `DEFAULT_REDACTION_POLICY`; pass `null` only when the caller has
   * already redacted the source and can say so.
   */
  readonly redaction?: RedactionPolicy | null;
}

export type ImportDiagnosticCode =
  | "raw_envelope_dropped"
  | "empty_summary"
  | "no_checkpoints"
  | "redacted"
  | "redaction_disabled"
  | "unsupported_record";

/**
 * Something a user should know about an import that is not a failure. An
 * import that dropped data always says so rather than looking complete.
 */
export interface ImportDiagnostic {
  readonly code: ImportDiagnosticCode;
  readonly message: string;
  /** 1-based source line, when the diagnostic came from one record. */
  readonly line?: number;
}

/**
 * A parsed session in the shape `@chronos/core` indexes, plus what the import
 * wants to tell the user. Nothing here has been persisted yet.
 */
export interface ImportedSession {
  readonly session: Session;
  readonly branches: readonly Branch[];
  readonly events: readonly Event[];
  readonly checkpoints: readonly Checkpoint[];
  readonly diagnostics: readonly ImportDiagnostic[];
}

/**
 * One provider format behind one interface. An adapter is written from an
 * observed fixture of a real format; Chronos JSONL is the exception because
 * Chronos defines it. Adapters parse and normalize only: they never execute a
 * recorded action and never touch a filesystem or a database.
 */
export interface SessionAdapter {
  /** Stable machine identifier, also used as a session `source` label. */
  readonly id: string;
  readonly displayName: string;
  /** Highest source schema version this adapter understands. */
  readonly formatVersion: number;
  /** Where the format this adapter reads is documented. */
  readonly documentation: string;
  parse(input: string, options?: ImportOptions): ImportedSession;
}
