import type { JsonObject, JsonValue } from "@chronos/protocol";

import { fail } from "./errors.js";

/**
 * One best-effort secret pattern. Detection is a safety net, not a guarantee:
 * a rule that never fires does not mean a transcript is clean.
 */
export interface RedactionRule {
  /** Stable id, reported so a user can see which rule fired. */
  readonly id: string;
  /** Short human label used in the replacement marker. */
  readonly label: string;
  readonly pattern: RegExp;
}

export interface RedactionPolicy {
  readonly rules: readonly RedactionRule[];
  /**
   * Field names whose values are removed whatever they contain. Names are
   * compared with case, underscores, and dashes ignored.
   */
  readonly sensitiveKeys: readonly string[];
}

export interface RedactionResult<Value extends JsonValue = JsonValue> {
  readonly value: Value;
  /** Ids of the rules that fired, deduplicated and sorted. */
  readonly matchedRuleIds: readonly string[];
}

/*
 * Patterns stay linear and anchored on a distinctive prefix. A pattern that
 * backtracks is a denial-of-service risk on an untrusted transcript, and one
 * that is too loose redacts a transcript into uselessness.
 */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  Object.freeze({
    id: "pem_private_key",
    label: "private key",
    pattern:
      /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g,
  }),
  Object.freeze({
    id: "aws_access_key_id",
    label: "aws key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  }),
  Object.freeze({
    id: "github_token",
    label: "github token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  }),
  Object.freeze({
    id: "slack_token",
    label: "slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
  }),
  Object.freeze({
    id: "json_web_token",
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  }),
  Object.freeze({
    id: "bearer_token",
    label: "bearer token",
    pattern: /\bBearer [A-Za-z0-9._~+/-]{16,}={0,2}/g,
  }),
  Object.freeze({
    id: "url_credentials",
    label: "url credentials",
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/?#@]+:[^\s/?#@]+@/g,
  }),
  Object.freeze({
    id: "assigned_secret",
    label: "secret",
    // The value class excludes brackets so an earlier rule's marker, such as
    // "[redacted:github token]", is never redacted a second time.
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"',;}[\]]{8,}/gi,
  }),
]);

export const DEFAULT_SENSITIVE_KEYS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "apitoken",
  "authorization",
  "credential",
  "credentials",
  "privatekey",
  "sessionkey",
]);

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  rules: DEFAULT_REDACTION_RULES,
  sensitiveKeys: DEFAULT_SENSITIVE_KEYS,
});

const KEY_MARKER = "[redacted:field]";

/** Build a policy, defaulting anything the caller did not override. */
export function redactionPolicy(
  overrides: Partial<RedactionPolicy> = {},
): RedactionPolicy {
  const rules = overrides.rules ?? DEFAULT_REDACTION_RULES;
  const sensitiveKeys = overrides.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  const ids = new Set<string>();
  for (const rule of rules) {
    if (
      typeof rule.id !== "string" ||
      rule.id.trim().length === 0 ||
      typeof rule.label !== "string" ||
      !(rule.pattern instanceof RegExp)
    ) {
      fail(
        "INVALID_OPTIONS",
        "A redaction rule needs an id, label, and pattern",
      );
    }
    if (ids.has(rule.id)) {
      fail("INVALID_OPTIONS", `Duplicate redaction rule id: ${rule.id}`);
    }
    ids.add(rule.id);
  }
  for (const key of sensitiveKeys) {
    if (typeof key !== "string" || key.trim().length === 0) {
      fail(
        "INVALID_OPTIONS",
        "A sensitive key name must be a non-empty string",
      );
    }
  }
  return Object.freeze({
    rules: Object.freeze([...rules]),
    sensitiveKeys: Object.freeze([...sensitiveKeys]),
  });
}

/** Redact a display string. Structure is preserved; matches are replaced. */
export function redactText(
  value: string,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionResult<string> {
  const matched = new Set<string>();
  const redacted = applyRules(value, policy, matched);
  return Object.freeze({
    value: redacted,
    matchedRuleIds: sortedIds(matched),
  });
}

/**
 * Redact canonical payload data. Values under a sensitive field name are
 * removed whatever they hold; every other string is matched against the rules.
 */
export function redactJson(
  value: JsonValue,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionResult {
  const matched = new Set<string>();
  const redacted = redactValue(value, policy, matched);
  return Object.freeze({
    value: redacted,
    matchedRuleIds: sortedIds(matched),
  });
}

function redactValue(
  value: JsonValue,
  policy: RedactionPolicy,
  matched: Set<string>,
): JsonValue {
  if (typeof value === "string") return applyRules(value, policy, matched);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => redactValue(item, policy, matched)),
    );
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key, policy)) {
      matched.add("sensitive_field");
      result[key] = KEY_MARKER;
      continue;
    }
    result[key] = redactValue(item, policy, matched);
  }
  return Object.freeze(result) as JsonObject;
}

function applyRules(
  value: string,
  policy: RedactionPolicy,
  matched: Set<string>,
): string {
  let result = value;
  for (const rule of policy.rules) {
    // Clone so a caller's stateful regex cannot skip matches through lastIndex.
    const pattern = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g")
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`,
    );
    const next = result.replace(pattern, `[redacted:${rule.label}]`);
    if (next !== result) matched.add(rule.id);
    result = next;
  }
  return result;
}

function isSensitiveKey(key: string, policy: RedactionPolicy): boolean {
  const normalized = normalizeKey(key);
  return policy.sensitiveKeys.some(
    (candidate) => normalizeKey(candidate) === normalized,
  );
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[\s_-]/g, "");
}

function sortedIds(matched: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...matched].sort());
}
