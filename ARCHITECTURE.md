# Chronos architecture

> Local-first, open-source time-travel debugging for AI coding-agent sessions.

## Product contract

Chronos imports an agent session and lets a user scrub to any recorded event. When that event has reconstructable captured filesystem state, Chronos restores it (subject to exclusions) in isolation and starts a child branch with a new instruction.

**MVP means:** transcript/tool-event replay plus filesystem restoration. It does not claim to rewind process memory, hidden provider state, or external side effects.

## Principles

- Immutable history: append events; never rewrite ancestry.
- Portable core: provider resume IDs are optional accelerators, not truth.
- Safe branching: restore into a new directory and never replay tool calls automatically.
- Faithful import: keep versioned, redacted normalized data; raw envelopes are optional.
- Local by default: SQLite + content-addressed snapshots; server binds loopback.
- Cheap context: page event summaries and load large payloads only on demand.

## System map

```text
agent logs -> adapter -> core model -> SQLite
workspace  -> snapshotter -> content store
                           |
CLI -> localhost API/SSE -> timeline UI
                           |
                     branch planner -> isolated restore -> adapter launch plan
```

| Module               | Responsibility                                           |
| -------------------- | -------------------------------------------------------- |
| `packages/core`      | Domain types, invariants, branch/replay planning; no I/O |
| `packages/protocol`  | Versioned schemas shared by API, CLI, and UI             |
| `packages/storage`   | SQLite migrations and repositories                       |
| `packages/adapters`  | Provider-specific import/export behind one interface     |
| `packages/snapshots` | Ignore-aware manifests, blobs, capture, restore          |
| `packages/branching` | The one branch workflow: plan, restore, settle, instruct |
| `apps/server`        | Loopback HTTP API and SSE event stream                   |
| `apps/web`           | Virtualized transcript, scrubber, branch composer        |
| `apps/cli`           | Import, record, inspect, serve, branch, and launch       |

## Canonical records

```ts
type Session = { id: string; source: string; createdAt: string };
type Branch = {
  id: string;
  sessionId: string;
  parentId?: string;
  forkSeq?: number;
  state: "preparing" | "ready" | "failed";
};
type Event = {
  id: string;
  branchId: string;
  seq: number;
  kind: EventKind;
  occurredAt: string;
  summary: string;
  payload: unknown;
  rawRef?: string;
};
type Checkpoint = {
  id: string;
  branchId: string;
  eventSeq: number;
  manifestRef: string;
};
type LaunchPlan = {
  workspacePath: string;
  context: ReplayItem[];
  instruction: string;
};
```

`seq` is a 1-based logical session coordinate. `(branchId, seq)` is unique; a child at parent sequence N resolves parent history through N (recursively), then owns events N+1 onward. Payloads and optional raw envelopes carry schema versions. Lineage tests cover nested forks.

## Key flows

1. **Import:** adapter parses a documented source -> validates/redacts normalized events -> optionally stores an encrypted raw envelope -> links source-provided snapshots/patches. Events without reconstructable state are visibly non-branchable.
2. **Capture/scrub:** live recording starts with a baseline checkpoint and conservatively snapshots after every completed tool action. The UI pages summaries and lazily shows details plus the effective restore sequence. v0.1 branches only when the latest verified checkpoint reaches the target without an intervening mutation; persisted delta artifacts are post-v0.1. Transcript replay never changes files.
3. **Branch:** insert `preparing` lineage -> restore to a staging directory -> verify manifest -> atomically rename -> transactionally append the new instruction and mark `ready`. Failure marks the branch `failed`; retry uses a fresh staging path and cleanup is idempotent. Creating a branch never runs imported commands; launching the new instruction needs separate confirmation.
4. **Live view:** server appends events transactionally and broadcasts event IDs over SSE; clients fetch canonical records.

## Safety and invariants

- Honor provider ignore rules plus explicit include/exclude policy; exclude `.git`, generated dependency/build output, sockets, and configured secret patterns. Secret detection is best-effort.
- Hash blobs, cap snapshot/file sizes, validate paths, and reject traversal/symlinks escaping the root.
- Imported commands are display-only. Execution requires a separate explicit launch confirmation.
- Redact canonical data before persistence/export. Raw retention is disabled by default; when enabled it is encrypted in a separate restricted store, excluded from exports, and deletable per session.
- Snapshot restore is all-or-nothing into a new empty directory.
- Bind to `127.0.0.1` with a per-run bearer token, strict Host/Origin checks, and CORS denied by default. Remote exposure requires explicit TLS/auth configuration.

## Delivery phases

Each verified vertical feature slice gets a meaningful commit and push; a phase may need several slices.

1. **Workspace:** Node 22, npm workspaces, TypeScript, lint/typecheck/test gates, MIT `LICENSE`.
2. **Protocol/core:** versioned schemas; immutable records, lineage traversal, replay/branch planning, tests.
3. **Storage:** SQLite schema, migrations, state transitions, repositories, integration tests.
4. **Import:** documented Chronos JSONL and fixtures; real adapters only from observed formats.
5. **Snapshots/capture:** safe content-addressed manifests, exact-checkpoint capture cadence, restore, limits; serialized deltas are post-v0.1.
6. **API:** authenticated sessions/events/checkpoints/branch endpoints plus SSE.
7. **Web:** paged virtual timeline, replayability status, scrubber, details, branch composer.
8. **CLI:** import/record/inspect/serve/branch/launch commands and launch-plan output.
9. **End to end:** import -> scrub -> restore -> child instruction scenario.
10. **Release:** CI, threat model, contributor/security reporting docs, versioned formats.

### Delivered Web slice

`apps/web` now provides a dependency-free, same-origin timeline instrument over the authenticated API: session/branch selection, paged visible history, transcript scrubbing, lazy event payload and capability inspection, and a branch composer that remains disabled at non-reconstructable events. `chronos serve` hosts those inert assets publicly from the protected loopback origin and prints a tokenized browser URL; the token moves to session storage immediately, while every record endpoint remains authenticated. Live SSE refresh remains future integration work.

## Phase checklist

For every phase: read the dependency's official/local docs; copy documented APIs and signatures; add focused tests; run format, lint, typecheck, and tests; grep for phase anti-patterns; review the diff; then commit and push. Never invent provider formats, auto-run imported actions, mutate parent history, or write snapshots into the inspected repository.

## Early decisions

- Browser UI served locally beats desktop packaging until the workflow is proven.
- SQLite is an implementation detail behind repositories; domain logic stays pure.
- The first importer is Chronos JSONL because no provider fixture/spec exists yet.
- Snapshot hashes use SHA-256; manifests deduplicate blobs and make restoration content-verifiable under declared path, file-mode, symlink, normalization, and timestamp semantics.
- REST + SSE keeps inspection simple; bidirectional streaming is unnecessary for MVP.

## v0.1 completion contract

Chronos v0.1 is complete when a local user can import an observed Codex or Claude Code transcript, inspect it in the CLI or browser, record a noninteractive agent stream with a baseline checkpoint and conservative post-tool checkpoints, scrub to any event whose workspace is reconstructable, create an isolated child branch, and explicitly launch a fresh agent with bounded canonical replay context in that workspace. Interactive TUI recording, provider-native resume/fork, out-of-band filesystem writes, and serialized delta artifacts are out of scope: neither observed CLI supports arbitrary-turn native forks.

Completion slices, each independently verified and committed:

1. **Observed adapters:** add `chronos import FILE --format chronos|codex|claude` with exact-version Codex `0.146.0-alpha.3` and Claude Code `2.1.225` importers from provenance-documented sanitized fixtures. Require the observed source-version field, reject unknown/missing versions, normalize visible instructions/messages/tool calls/results only, and never import thinking, encrypted reasoning, provider file-history metadata, or duplicate event surfaces. v0.1 disables raw retention until an encrypted raw store exists.

   Delivered: pure, bounded saved-session parsers now implement that exact-version contract and the CLI selector. Codex duplicate agent-message surfaces and hidden/context records are omitted; Claude imports only a fully resolved linear root and rejects sidechains or ambiguous parentage. Synthetic fixtures and `docs/formats/provider-jsonl.md` document provenance and intentional omissions. Unknown record kinds produce diagnostics, and CLI raw retention is disabled until encrypted storage exists.

2. **Capture/record coordinator:** add `chronos record --agent codex|claude --workspace PATH --instruction-file FILE` around the verified noninteractive JSON-stream commands. Copy the instruction to excluded `.chronos/` storage and pass only a fixed, option-safe prompt after `--`; never interpolate user text into argv. Before provider launch, durably store a baseline manifest and atomically append its system event/checkpoint or abort. At each completed tool result, durably store the next full manifest, then atomically append the result and checkpoint; on capture failure atomically append the result plus a safe error without a checkpoint. Report exclusions, restrict Chronos-home permissions, and make no claim about concurrent/external writers. Reject live API `tool_call`, `tool_result`, and `filesystem_change` writes that bypass this coordinator; capability logic treats every uncheckpointed tool result as a mutating boundary. v0.1 capability/UI/docs expose only exact state or a prior checkpoint with zero intervening mutating boundaries; inferred delta evidence is disabled.
3. **Explicit launch:** add `chronos launch --agent codex|claude --branch ID` for a ready branch with a verified restored workspace. Safely create a no-symlink, non-overwriting `.chronos/` directory and render redacted `ReplayItem` records as explicitly quoted, untrusted history into a unique replay file, capped at 64 KiB (including deterministic single-record truncation) while preserving the first instruction and newest chronological records. Require confirmation showing the resolved allowlisted executable, `cwd`, context path, and fixed argv semantics. Spawn with `shell: false`, signal/exit propagation, and an environment allowlist containing PATH, HOME/USERPROFILE, TEMP/TMP, terminal variables, Windows `SystemRoot`/`WINDIR`/`ComSpec`/`PATHEXT`/`APPDATA`/`LOCALAPPDATA`, and explicit `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` when present. The fixed prompt says never execute historical commands; HTTP/Web never auto-launch. Cross-platform tests must prove the child can invoke a basic subprocess, not only that the fake executable starts.
4. **Live Web timeline:** consume authenticated SSE with a fetch stream, refetch canonical records after append notices, bound rendered timeline rows, preserve selection, and expose connection state accessibly. Test abort, reconnect, malformed frames, and large histories; production capability handling must never enable unsupported nonempty-delta reconstruction.
5. **Product E2E:** split acceptance into (a) exact-version provider fixture import -> CLI inspect and (b) fake-provider record/capture -> serve -> browser SSE refresh/scrub -> restore/branch -> confirmed launch, all under a temporary home/workspace. Assert command-builder compatibility, snapshot transaction/failure behavior, argv, `shell: false`, `cwd`, 64 KiB context ordering/instruction delivery, `.env` and `.chronos/` exclusion, token removal, and inert historical commands.
6. **Open-source release:** add Ubuntu/Windows/macOS CI, security/threat-model and contribution docs, accurate setup/CLI usage, a changelog, bump the private source-distributed monorepo/CLI to `0.1.0`, add a source-install smoke test, and provide one reproducible `verify:v0.1` command including browser E2E. npm publication is out of scope for v0.1.

Guards: do not infer checkpoints from provider file-history metadata, claim compatibility beyond observed versions, put bearer tokens in committed fixtures/screenshots, expose the server beyond loopback, weaken Host/Origin checks for tests, store `.chronos/` replay artifacts in snapshots, or describe best-effort redaction as a security boundary.
