# Observed provider saved-session JSONL

Chronos v0.1 reads two exact, locally observed saved-session formats. These are implementation observations, not public provider contracts or claims of broader compatibility. Fixtures are synthetic and sanitized; all transcript text, credentials, IDs, and path values in them are fictional, and encrypted reasoning is represented only by an inert placeholder.

| Format   | Accepted source version                              | Observed provenance                                  |
| -------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `codex`  | `session_meta.payload.cli_version = 0.146.0-alpha.3` | `~/.codex/sessions/YYYY/MM/DD/rollout-...UUID.jsonl` |
| `claude` | every root record has `version = 2.1.225`            | `~/.claude/projects/<encoded-project>/<uuid>.jsonl`  |

Use `chronos import FILE --format codex` or `--format claude`. Missing and unknown versions fail the entire import. `--format chronos` reads Chronos's documented format and remains the default for backward compatibility.

Codex normalizes `event_msg.user_message`, assistant `response_item.message` text, function/custom tool calls and outputs, and explicit errors/system messages. The duplicate `event_msg.agent_message` surface is ignored. Reasoning, encrypted content, world state, turn context, token accounting, and settings are omitted.

Claude normalizes string user instructions, assistant text/tool-use blocks, user tool-result blocks, and explicit system/errors. Thinking/signatures, file-history snapshots and deltas, titles, colors, modes, and permission metadata are omitted. File order and resolved `parentUuid` links must describe one linear root history. Sidechains, unresolved parents, and nonlinear roots fail rather than being represented as invented branches.

Provider imports emit diagnostics for unknown record kinds. They never perform I/O or execute recorded tools. Canonical redaction remains best-effort and is not a security boundary. Raw retention is rejected in v0.1 because the encrypted restricted raw store does not exist yet.
