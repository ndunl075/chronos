import type { Event, JsonValue, Session } from "@chronos/protocol";

import {
  AdapterError,
  CHRONOS_JSONL_SCHEMA_VERSION,
  DEFAULT_REDACTION_POLICY,
  chronosJsonlAdapter,
  claudeJsonlAdapter,
  codexJsonlAdapter,
  parseClaudeJsonl,
  parseCodexJsonl,
  parseChronosJsonl,
  redactJson,
  redactText,
  redactionPolicy,
  type AdapterErrorCode,
  type RedactionPolicy,
  type ImportOptions,
  type ImportedSession,
  type SessionAdapter,
} from "../src/index.js";

declare const source: string;
declare const options: ImportOptions;

const adapter: SessionAdapter = chronosJsonlAdapter;
const providers: readonly SessionAdapter[] = [
  codexJsonlAdapter,
  claudeJsonlAdapter,
];
const imported: ImportedSession = adapter.parse(source, options);
const session: Session = imported.session;
const first: Event | undefined = imported.events[0];
const raw: Event["rawEnvelope"] = first?.rawEnvelope;
const code: AdapterErrorCode = new AdapterError("INVALID_INPUT", "bad").code;
const line: number | undefined = new AdapterError("INVALID_INPUT", "bad", 3)
  .line;
void session;
void raw;
void code;
void line;
void CHRONOS_JSONL_SCHEMA_VERSION;
void providers;

parseChronosJsonl(source, { retainRaw: true, limits: { maxRecords: 10 } });
parseChronosJsonl(source, { redaction: null });
parseCodexJsonl(source, { redaction: null });
parseClaudeJsonl(source, { limits: { maxRecords: 10 } });
parseClaudeJsonl(source, { limits: { maxInputLength: 1024 } });

const policy: RedactionPolicy = redactionPolicy({
  rules: [{ id: "ticket", label: "ticket", pattern: /TICKET-\d+/g }],
});
const redactedText: string = redactText("TICKET-42", policy).value;
const redactedJson: JsonValue = redactJson({ note: "TICKET-42" }, policy).value;
void redactedText;
void redactedJson;
void DEFAULT_REDACTION_POLICY;

// @ts-expect-error a rule needs a compiled pattern
redactionPolicy({ rules: [{ id: "x", label: "x", pattern: "TICKET" }] });
// @ts-expect-error the default policy is frozen
DEFAULT_REDACTION_POLICY.rules = [];

// @ts-expect-error import options are checked
parseChronosJsonl(source, { retainRaw: "yes" });
// @ts-expect-error unknown limits are not silently ignored
parseChronosJsonl(source, { limits: { maxBytes: 10 } });
// @ts-expect-error imported collections are immutable
imported.events.push(first);
// @ts-expect-error an adapter describes a format it can already read
adapter.formatVersion = 2;
