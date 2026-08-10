# Changelog

All notable changes to Chronos are documented here. This project follows
[Semantic Versioning](https://semver.org/); until `1.0.0`, minor versions may
still include breaking changes to the storage schema, protocol, or CLI. This
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] — Persisted delta reconstruction

### Added

- **Persisted delta reconstruction:** a `Delta` protocol record, canonical
  `ManifestDiff` serialize/parse/apply in `@chronos/snapshots`, storage
  schema v3 (`delta` table), Chronos JSONL `delta` records, import
  persistence, capability computation that emits `checkpoint_plus_deltas`
  when every intervening mutating boundary has a delta, and branch/launch
  restore that materializes the final manifest from a checkpoint plus the
  ordered delta chain.
- **Live delta capture:** `chronos record` still writes a full baseline
  checkpoint, then stores a content-addressed `ManifestDiff` delta (not
  another full checkpoint) at every successful post-tool boundary.

## [0.1.0] — v0.1 completion

The first complete, reproducible slice: import an observed transcript or
record a live one, inspect and branch it locally or in the browser, and
explicitly launch a fresh agent into the reconstructed workspace. See
`ARCHITECTURE.md`'s "v0.1 completion contract" for the full scope and its
explicit non-goals.

### Added

- **Observed adapters** (`chronos import`): exact-version importers for
  Codex `0.146.0-alpha.3` and Claude Code `2.1.225` saved sessions, plus
  Chronos's own documented JSONL format. Unknown or missing source versions
  fail the import; unsupported record kinds are diagnosed, never silently
  dropped or invented.
- **Capture/record coordinator** (`chronos record`): wraps the verified
  noninteractive `codex exec --json` / `claude --print --output-format
stream-json` commands with a durable baseline checkpoint and a checkpoint
  after every completed tool-result batch. Provider executable resolution
  and identity pinning close a PATH-alias/TOCTOU class of risk; default
  snapshot limits are enforced during the capture walk, not only after it.
- **Explicit launch** (`chronos launch`): hands a branch's verified,
  reconstructed workspace to a real Codex or Claude Code process. Requires
  `--confirm` after printing the full plan; renders quoted, untrusted replay
  history into a capped, explicitly-labeled context file; runs the launched
  process under a minimal explicit environment allowlist.
- **Branching** (`chronos branch`): forks a session at any event with
  reconstructable workspace state into a new, isolated, verified directory,
  and appends the new instruction — without ever running the history it
  branched from.
- **Local API and live web timeline** (`chronos serve`): a loopback,
  per-run-token-authenticated HTTP API and SSE event stream, and a
  dependency-free browser timeline that scrubs recorded history, shows
  branchability per event, composes new branches, and now reflects live
  appends over the authenticated stream — including reconnect-with-backoff
  and bounded rendering for a large or actively-growing history.
- **Inspection** (`chronos inspect`): lists sessions, a session's branch
  lineage, a branch's timeline (with inherited history and branchability
  marked), and one event's full canonical payload from the terminal.
- **Product acceptance tests** (`apps/e2e`): a real, assembled flow across
  the built CLI, server, and web client together — fixture import through
  inspect, and fake-provider record through serve, live SSE refresh,
  branch, and confirmed launch — plus a source-install smoke test
  (`npm run smoke`) and one reproducible `npm run verify:v0.1`.
- Ubuntu/Windows/macOS CI, `SECURITY.md`, and `CONTRIBUTING.md`.

### Scope notes

- Raw provider retention is disabled; the encrypted restricted raw store it
  depends on does not exist yet.
- Reconstruction is exact-checkpoint only in v0.1; persisted delta artifacts
  (`checkpoint_plus_deltas` with a nonempty delta list) are not implemented.
- Chronos does not detect a concurrent external writer during capture; this
  is reported as a limitation, not hidden.
- npm publication is out of scope for v0.1; install from source.
