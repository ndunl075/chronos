# Roadmap

`v0.1.0` is complete against the contract in
[ARCHITECTURE.md](ARCHITECTURE.md#v01-completion-contract). This document
scopes what comes after it. Everything below was already named as
out-of-scope or a known limitation somewhere in the codebase or its docs —
this collects those threads into one place rather than inventing new scope.
Nothing here is scheduled; it's ordered by rough sequencing logic (what the
next thing depends on), not by commitment or priority.

## Next up

**Encrypted raw retention.** Every import and record path already has a
`--retain-raw` / raw-envelope shape wired through the protocol
(`RawEnvelopeReference`) and refuses it outright in v0.1 specifically
because "the encrypted restricted raw store does not exist yet." Building
that store — at-rest encryption, a key-management story that doesn't just
move the secret problem somewhere else, per-session deletion, and explicit
exclusion from any future export path — is the blocking piece; the
call sites that reject `--retain-raw` today already know exactly where to
plug it in.

## After that

**Delta checkpoint compaction during long recordings.** Persisted delta
reconstruction is complete for import, live record, capability computation,
and branch/launch restore: baseline remains a full checkpoint, and every
successful post-tool boundary writes a content-addressed `ManifestDiff`
delta. Long sessions therefore grow an ordered apply chain. Occasional
full-checkpoint compaction (rewrite a fresh CP, reset the chain) is an
optimization for restore cost, not correctness.

**Concurrent/external-writer detection during capture.** Documented today as
a limitation Chronos reports rather than hides ("This does not freeze the
provider process or detect another process writing the workspace
concurrently"). Closing this needs either OS-level file-watching during the
capture walk or a stricter before/after whole-tree comparison, and a design
call on what Chronos does when it detects a race — fail the capture, or
still record it as explicitly suspect.

**Live view for an in-progress recording.** Today `chronos serve`'s SSE
stream only broadcasts events appended through the server's own write route
— a separate, concurrently-running `chronos record` process writes straight
to SQLite and has no broadcaster to publish through, so a browser can watch
a _finished_ recording live-refresh via commentary appends, but not a
recording still in flight. Bridging that needs either running record and
serve in one process (sharing a broadcaster) or a storage-level change
notification `chronos serve` can subscribe to.

**The Windows reparse-swap residual.** Documented in `SECURITY.md` and
`docs/formats/provider-jsonl.md`: Node has no primitive equivalent to POSIX
`open(..., O_NOFOLLOW)` composed atomically with a no-reparse guarantee, so
the repeated-check pattern this codebase uses everywhere on Windows closes
the race in practice but not in principle. Fully closing it needs either an
upstream Node capability that doesn't exist yet or a native addon, and is
worth revisiting whenever Node's `fs` primitives change.

## Larger, more speculative

**Interactive TUI recording.** v0.1 records only the noninteractive JSON
stream modes (`codex exec --json`, `claude --print --output-format
stream-json`) because those are the only modes with a well-defined,
parseable event grammar. Recording an interactive session would mean either
screen-scraping a TUI or the provider exposing a structured event stream
from its interactive mode — a provider-side dependency Chronos does not
control.

**Provider-native resume/fork.** Chronos's branch/restore model is its own;
it does not integrate with Codex's or Claude Code's own session resume
mechanics. Neither observed CLI supports forking from an arbitrary turn
natively today, which is exactly why Chronos's checkpoint/restore model
exists instead. Worth revisiting if that changes upstream.

**npm publication.** Explicitly out of scope for v0.1 ("install from
source" is the whole `README.md` story right now). Needs: a decision on
which packages actually need to be public versus internal-only workspace
dependencies, a real semver commitment once `0.1.0` stops being brand new,
and CI wiring for it — deliberately not done alongside CI's test/build/lint
matrix, since publish credentials are a different trust boundary than a
verify job.

## Not on this list on purpose

Anything not named here or elsewhere in `ARCHITECTURE.md`/`SECURITY.md` as a
known limitation is either already done or hasn't been scoped yet — this
document is a map of named gaps, not a backlog of every possible feature.
