# Chronos architecture

> Local-first, open-source time-travel debugging for AI coding-agent sessions.

## Product contract

Chronos imports an agent session and lets a user scrub to any recorded event. When that event has reconstructable captured filesystem state, Chronos restores it (subject to exclusions) in isolation and starts a child branch with a new instruction.

`chronos wrap` / `chronos rollback` add a lighter path: snapshot an arbitrary command as a turn (baseline + post-turn deltas) and optionally rewrite the live workspace in place to an earlier turn, still without touching excluded paths and without replaying tool calls.

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

| Module               | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `packages/core`      | Domain types, invariants, branch/replay planning; no I/O  |
| `packages/protocol`  | Versioned schemas shared by API, CLI, and UI              |
| `packages/storage`   | SQLite migrations and repositories                        |
| `packages/adapters`  | Provider-specific import/export behind one interface      |
| `packages/snapshots` | Ignore-aware manifests, blobs, capture, restore           |
| `packages/branching` | The one branch workflow: plan, restore, settle, instruct  |
| `apps/server`        | Loopback HTTP API and SSE event stream                    |
| `apps/web`           | Virtualized transcript, scrubber, branch composer         |
| `apps/cli`           | Import, record, inspect, serve, branch, and launch        |
| `apps/e2e`           | Product acceptance across the CLI, server, and web client |

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
2. **Capture/scrub:** live recording starts with a baseline checkpoint and conservatively captures at each provider-record boundary that completes one or more tool actions. The baseline is a durable full manifest; each successful post-tool boundary stores a content-addressed `ManifestDiff` delta instead of another full checkpoint. The UI pages summaries and lazily shows details plus the effective restore sequence. Branching reconstructs from an exact checkpoint, or from a checkpoint plus an ordered chain of persisted deltas when intervening mutating boundaries have recorded artifacts. Transcript replay never changes files.
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
5. **Snapshots/capture:** safe content-addressed manifests, baseline full-checkpoint plus intervening serialized `ManifestDiff` deltas, restore, limits.
6. **API:** authenticated sessions/events/checkpoints/branch endpoints plus SSE.
7. **Web:** paged virtual timeline, replayability status, scrubber, details, branch composer.
8. **CLI:** import/record/inspect/serve/branch/launch commands and launch-plan output.
9. **End to end:** import -> scrub -> restore -> child instruction scenario.
10. **Release:** CI, threat model, contributor/security reporting docs, versioned formats.

### Delivered Web slice

`apps/web` now provides a dependency-free, same-origin timeline instrument over the authenticated API: session/branch selection, paged visible history, transcript scrubbing, lazy event payload and capability inspection, and a branch composer that remains disabled at non-reconstructable events. `chronos serve` hosts those inert assets publicly from the protected loopback origin and prints a tokenized browser URL; the token moves to session storage immediately, while every record endpoint remains authenticated. Live SSE refresh now consumes the session stream through a hand-rolled fetch-body reader (`apps/web/src/stream.ts`), because `EventSource` cannot carry the bearer header every other route requires.

## Phase checklist

For every phase: read the dependency's official/local docs; copy documented APIs and signatures; add focused tests; run format, lint, typecheck, and tests; grep for phase anti-patterns; review the diff; then commit and push. Never invent provider formats, auto-run imported actions, mutate parent history, or write snapshots into the inspected repository.

## Early decisions

- Browser UI served locally beats desktop packaging until the workflow is proven.
- SQLite is an implementation detail behind repositories; domain logic stays pure.
- The first importer is Chronos JSONL because no provider fixture/spec exists yet.
- Snapshot hashes use SHA-256; manifests deduplicate blobs and make restoration content-verifiable under declared path, file-mode, symlink, normalization, and timestamp semantics.
- REST + SSE keeps inspection simple; bidirectional streaming is unnecessary for MVP.

## v0.1 completion contract

Chronos v0.1 is complete when a local user can import an observed Codex or Claude Code transcript, inspect it in the CLI or browser, record a noninteractive agent stream with a baseline checkpoint and conservative post-tool checkpoints, scrub to any event whose workspace is reconstructable, create an isolated child branch, and explicitly launch a fresh agent with bounded canonical replay context in that workspace. Interactive TUI recording, provider-native resume/fork, and out-of-band filesystem writes are out of scope: neither observed CLI supports arbitrary-turn native forks. Persisted delta reconstruction (import, live record, capability, branch/launch restore) is implemented after v0.1; occasional full-checkpoint compaction for long delta chains remains optional.

Completion slices, each independently verified and committed:

1. **Observed adapters:** add `chronos import FILE --format chronos|codex|claude` with exact-version Codex `0.146.0-alpha.3` and Claude Code `2.1.225` importers from provenance-documented sanitized fixtures. Require the observed source-version field, reject unknown/missing versions, normalize visible instructions/messages/tool calls/results only, and never import thinking, encrypted reasoning, provider file-history metadata, or duplicate event surfaces. v0.1 disables raw retention until an encrypted raw store exists.

   Delivered: pure, bounded saved-session parsers now implement that exact-version contract and the CLI selector. Codex duplicate agent-message surfaces and hidden/context records are omitted; Claude imports only a fully resolved linear root and rejects sidechains or ambiguous parentage. Synthetic fixtures and `docs/formats/provider-jsonl.md` document provenance and intentional omissions. Unknown record kinds produce diagnostics, and CLI raw retention is disabled until encrypted storage exists.

2. **Capture/record coordinator:** add `chronos record --agent codex|claude --workspace PATH --instruction-file FILE` around the verified noninteractive JSON-stream commands. Copy the instruction to excluded `.chronos/` storage and pass only a fixed, option-safe prompt after `--`; never interpolate user text into argv. Before provider launch, durably store a baseline manifest and atomically append its system event/checkpoint or abort. At each provider-record boundary containing completed tool results, durably store the next full manifest, then atomically append the final normalized result batch and checkpoint; on capture failure atomically append the batch plus a safe error without a checkpoint. Report exclusions, restrict Chronos-home permissions where the host supports POSIX mode bits (Windows relies on its filesystem ACLs), and make no claim about concurrent/external writers. Reject live API `tool_call`, `tool_result`, and `filesystem_change` writes that bypass this coordinator; capability logic treats every uncheckpointed tool result as a mutating boundary. v0.1 capability/UI/docs expose only exact state or a prior checkpoint with zero intervening mutating boundaries; inferred delta evidence is disabled.

   Delivered: the CLI now launches the exact-version noninteractive provider commands with `shell: false`, resolves one canonical absolute regular executable for both version probe and recording, pins and rechecks its filesystem identity, rejects Windows shell-script shims, applies backpressure through a raw-byte-bounded JSONL splitter, and records a durable baseline plus full post-tool manifests. Instruction input is a bounded same-descriptor regular-file read with no-follow/stability checks on POSIX and repeated reparse/identity checks on Windows. Provider session, turn/result terminal, call, and visible-item identity is single-use; exactly one validated successful terminal is required for readiness, declared failure settles failed, and later records are rejected. Exact allowlists reject unknown potentially mutating surfaces and mark workspace state unknown, while stream, spawn, and cancellation failures terminate the child with a bounded grace period and append a safe terminal error. A failure after an unmatched tool call explicitly marks workspace state unknown and remains non-branchable. Each provider record creates at most one checkpoint, at the final boundary of its normalized result batch, atomically landing the complete batch with either a filesystem-change checkpoint or a safe capture error; a failed final transaction leaves none of that batch behind. Final event sequence advancement occurs only after commit, so a ready-settlement rollback can append one contiguous safe failure and settle failed. Recorded roots stay `preparing` until provider termination, stream validation, and terminal persistence succeed; failed recordings remain inspectable but non-ready. Storage schema v2 preserves the historical v1 trigger and migrates it to admit only provider-recording roots while they are preparing. Reserved `.chronos/` paths are excluded case-insensitively, bypass API writes are refused, and capability checks treat uncheckpointed tool results as dirty without accepting inferred delta evidence. Snapshot capture uses same-descriptor no-follow/stability checks on POSIX and repeated reparse/identity/containment checks on Windows; content-store boundaries compare canonical roots (case-insensitively on Windows), including missing suffixes beneath a canonical ancestor. The content-store root and workspace root are both pinned to one canonical filesystem identity before capture, closing symlink/junction aliasing between the two checks that would otherwise use different spellings of the same location. The capturing executable's filesystem identity is pinned once and rechecked before, during, and after each provider spawn, so an in-place rewrite of the resolved binary between checks cannot substitute a different program. Default snapshot limits (files, per-file bytes, and total bytes) are resolved once and enforced while the walk is still in progress, so a workspace that would exceed them is rejected before the excess files are opened, read, hashed, or written into the content store, rather than only after a full capture already paid that cost. Node's lack of a Windows no-reparse/open-at primitive leaves a documented hostile reparse-swap residual.

3. **Explicit launch:** add `chronos launch --agent codex|claude --branch ID` for a ready branch with a verified restored workspace. Safely create a no-symlink, non-overwriting `.chronos/` directory and render redacted `ReplayItem` records as explicitly quoted, untrusted history into a unique replay file, capped at 64 KiB (including deterministic single-record truncation) while preserving the first instruction and newest chronological records. Require confirmation showing the resolved allowlisted executable, `cwd`, context path, and fixed argv semantics. Spawn with `shell: false`, signal/exit propagation, and an environment allowlist containing PATH, HOME/USERPROFILE, TEMP/TMP, terminal variables, Windows `SystemRoot`/`WINDIR`/`ComSpec`/`PATHEXT`/`APPDATA`/`LOCALAPPDATA`, and explicit `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` when present. The fixed prompt says never execute historical commands; HTTP/Web never auto-launch. Cross-platform tests must prove the child can invoke a basic subprocess, not only that the fake executable starts.

   Delivered: `chronos launch` only accepts a `ready` child branch (a session's root has no reconstructed workspace to launch into) and re-derives its exact reconstruction checkpoint from the current session graph through the same `computeEventCapabilities` the branch workflow uses, so there is one source of truth for which manifest a branch's workspace answers to. Before anything is written it re-walks the on-disk workspace with the same capture used everywhere else and refuses to proceed unless the recomputed manifest ref matches the checkpoint's exactly, catching both external tampering and a missing/deleted workspace. The resolved provider executable goes through the same PATH-resolution and canonical-identity pinning `record` uses (now shared, not duplicated), rechecked immediately before, during, and after spawn. `ReplayItem` history is rendered into a `.chronos/replay-<uuid>.txt` file where every historical line is an explicit blockquote, which keeps quoted content from forging a fake section header; when the file would exceed 64 KiB the first instruction and the newest contiguous run of records are kept, one gap is reported by count, and any single oversized record is truncated at a UTF-8-safe boundary with a fixed marker, deterministically and reproducibly for the same input. The fixed prompt sent as the sole argv payload after `--` never contains user text, only a pointer to that file. Nothing is spawned until `--confirm` is passed; the plan printed before it names the resolved executable, `cwd`, replay file path, and full argv verbatim. The real spawn inherits stdio (an interactive session, not a captured stream), sets `shell: false`, and runs with an explicit environment allowlist built fresh from `process.env`, not inherited wholesale. Abort forwards `SIGTERM` with the same bounded `SIGKILL` grace period as `record`; a nonzero child exit is surfaced as a Chronos failure without inventing a code Chronos never promised. Tests cover a real `child_process` spawn (argv with shell-metacharacter-bearing arguments and a space-bearing `cwd` arrive unmangled, proving `shell: false` rather than trusting the flag) and a real SIGTERM-resistant grace-period kill, not only an injected fake executor.

4. **Live Web timeline:** consume authenticated SSE with a fetch stream, refetch canonical records after append notices, bound rendered timeline rows, preserve selection, and expose connection state accessibly. Test abort, reconnect, malformed frames, and large histories; production capability handling must never enable unsupported nonempty-delta reconstruction.

   Delivered: `apps/web/src/stream.ts` reads the session stream by hand off a `fetch` response's raw byte body — `EventSource` cannot carry the bearer header every other route requires — decoding, buffering, and splitting on the wire's blank-line frame boundary itself. A frame missing an `event:`/`data:` line, an `appended` payload that fails JSON parsing, or one that parses but does not have the exact `{schemaVersion, sessionId, branchId, eventIds: string[]}` shape is silently skipped rather than thrown, so one bad frame never drops the connection or the frames after it; a single frame is bounded at 64 KiB to cap what a misbehaving server could make the browser buffer. A dropped connection — the body ending cleanly, a fetch rejection, a non-ok response — reconnects with linear backoff capped at 30s, reported through the same `onStateChange` callback the UI uses for its `LIVE`/`CONNECTING`/`RECONNECTING`/`OFFLINE` badge (an `aria-live="polite"` region, so the state reaches assistive tech the same moment it reaches the eye); the loop only stops for good when its `AbortSignal` fires, and never issues another connection attempt afterward. `ChronosTimeline` refetches only the events after the last one it already has (`getTimelineSince`, not the whole history again) when a notice names its current branch, appends them, and never moves the scrubber or the selected event: a live update lands behind whatever the user is looking at, not on top of it. Rendering itself is capped at 500 rows (`boundRenderedRows`) so a long-running or large-history branch does not turn every append into a full-history DOM rebuild; the scrubber and event lookup still range over the complete in-memory history regardless of what is painted. Capability rendering already accepts both `exact` and `checkpoint_plus_deltas` reconstructions; once core marks a target branchable through a delta chain, the web badge and branch composer enable on that same status. Tests exercise the frame reader directly with real `ReadableStream` bodies (no DOM, no browser): malformed frames interleaved with valid ones, a clean end-of-stream reconnect, a fetch rejection treated as a reconnect not a crash, an abort that stops all further connection attempts, and 2000 frames delivered across arbitrarily split byte chunks arriving in order.

5. **Product E2E:** split acceptance into (a) exact-version provider fixture import -> CLI inspect and (b) fake-provider record/capture -> serve -> browser SSE refresh/scrub -> restore/branch -> confirmed launch, all under a temporary home/workspace. Assert command-builder compatibility, snapshot transaction/failure behavior, argv, `shell: false`, `cwd`, 64 KiB context ordering/instruction delivery, `.env` and `.chronos/` exclusion, token removal, and inert historical commands.

   Delivered: a new `apps/e2e` workspace depends on the real built `@chronos/cli`, `@chronos/server`, and `@chronos/web` packages together, so it exercises the actual product surface, not a re-implementation of it. `test/import-inspect.test.mjs` imports both exact-version fixtures through the real CLI and reads them back through `chronos inspect`, asserting the diagnosed-omission and no-checkpoint messaging a user actually sees. `test/record-serve-branch-launch.test.mjs` records a fake Codex tool call that writes a real file next to a real `.env` secret, confirms the checkpoint manifest and every restored workspace exclude both `.env` and `.chronos/`, starts a real server against that same home, and drives it with the real `ChronosApiClient`: token-rejection and token-never-persisted-to-disk checks, a scrub of the recorded timeline, a live SSE subscription that receives a real append notice and refetches only what is new, a real `createBranch` call that reconstructs an isolated workspace, and a confirmed `chronos launch` whose resolved plan is asserted against the pure `buildLaunchCommand` output for those exact real inputs rather than a hand-written expectation — command-builder compatibility proven by construction, not duplication. The launch replay file is read back to confirm 64 KiB compliance, that the new instruction is delivered as the task, that the branch point's first inherited instruction survives context ordering, and that the recorded tool call reads only as quoted, blockquoted history. A second test reuses the checkpoint-transaction-failure technique to prove a failed capture leaves a dirty, non-branchable, `failed` recording end to end through the CLI, not only inside `record`'s own unit tests.

6. **Open-source release:** add Ubuntu/Windows/macOS CI, security/threat-model and contribution docs, accurate setup/CLI usage, a changelog, bump the private source-distributed monorepo/CLI to `0.1.0`, add a source-install smoke test, and provide one reproducible `verify:v0.1` command including browser E2E. npm publication is out of scope for v0.1.

   Delivered: `.github/workflows/ci.yml` runs format/lint/build/typecheck/test/smoke on a matrix of Ubuntu, Windows, and macOS. `SECURITY.md` states the threat model in force — local single-user trust, loopback-only binding with a never-persisted per-run token, best-effort redaction explicitly disclaimed as not a security boundary, the documented Windows reparse-swap residual — points at each enforcement's source file, and gives a private GitHub Security Advisory as the reporting channel. `CONTRIBUTING.md` documents setup, the local commands `verify:v0.1` runs in order, this repo's actual test conventions (real filesystem/process over mocks, adversarial tests for security-relevant code), and the architectural invariants a change may not violate. `README.md` now has accurate source-install and per-command usage instead of placeholder text; every command shown was run to confirm its output, including `npm link --workspace apps/cli` actually producing a working `chronos` binary on `PATH`. Every workspace package and the CLI's own reported version moved from `0.0.0` to `0.1.0` together, including their inter-package dependency pins, without breaking workspace resolution. `scripts/smoke-install.mjs` (`npm run smoke`) spawns the built `chronos` binary as a real child process — not an in-process import — and proves `--version`, `--help`, an unknown-command usage error, and one real import-then-inspect round trip all work from what a fresh source install actually produces; it is the one check nothing else in the suite performs, since every other test imports the built package rather than executing it. `npm run verify:v0.1` chains format check, lint, build, typecheck, the full test suite (including `apps/e2e`, which is this project's browser-E2E surrogate: it drives the real `ChronosApiClient`/`openEventStream` code a browser loads, against a real running server, without a browser-automation dependency this dependency-minimal project does not otherwise carry), and the smoke test, in one reproducible command; CI runs the same steps individually for clearer per-stage failure reporting.

Guards: do not infer checkpoints from provider file-history metadata, claim compatibility beyond observed versions, put bearer tokens in committed fixtures/screenshots, expose the server beyond loopback, weaken Host/Origin checks for tests, store `.chronos/` replay artifacts in snapshots, or describe best-effort redaction as a security boundary.
