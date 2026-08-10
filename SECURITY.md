# Security

Chronos is local-first software: it reads agent session transcripts, writes
snapshots of a workspace's filesystem, and can launch a real agent process on
your behalf. This document describes the trust model those capabilities run
under, what Chronos does and does not defend against, and how to report a
vulnerability.

## Supported version

Security fixes are made against the latest commit on `main`. There is no
long-term-support branch in v0.1.

## Reporting a vulnerability

Please do not open a public issue for a security report.

- Preferred: open a
  [GitHub Security Advisory](https://github.com/ndunl075/chronos/security/advisories/new)
  on this repository. It is private until you and the maintainer agree to
  disclose it.
- Fallback: email ndunlap075@gmail.com with a description and, if you can,
  steps to reproduce.

Include what you were running (`chronos --version`, OS), what you expected,
and what actually happened. A minimal reproduction matters more than a full
write-up.

## Threat model

**In scope:** a local, single-user workstation. Chronos assumes the person
running it controls the machine it runs on and is not defending against a
hostile co-tenant with equal OS privileges, a compromised OS kernel, or a
malicious build of Node itself.

**What Chronos is protecting:**

- The contents of imported/recorded transcripts and the workspaces Chronos
  snapshots, from being exposed to a process other than the one the user
  explicitly authorized (the CLI, or a browser holding a valid per-run
  token).
- The workspace a branch or launch touches, from being corrupted by a
  partial write or from reaching outside the directory Chronos was told to
  operate on.
- The user, from a recorded or imported transcript's tool calls running
  automatically. A transcript is data. Nothing in it executes unless the
  user explicitly runs `chronos launch --confirm`.

**What Chronos does not claim:**

- Redaction of secrets in transcripts and tool output is **best-effort
  pattern matching**, not a security boundary. Do not import or record a
  session you would not otherwise be willing to have in plaintext on disk.
- Chronos cannot detect another process editing a workspace while it is
  being captured. A snapshot taken during a concurrent external write may
  be inconsistent; this is reported as a limitation in CLI output, not
  silently hidden.
- On Windows, Node has no primitive equivalent to POSIX `open` with
  `O_NOFOLLOW` plus an atomic no-reparse guarantee. Chronos repeats
  canonical-path and file-identity checks immediately before and after
  every read it takes, which closes the race in practice, but a
  sufficiently well-timed, privileged reparse-point swap inside that
  narrow window is a documented residual risk.

## What's enforced, and where to look

- **Loopback only, per-run token.** `chronos serve` binds `127.0.0.1`
  exclusively — a non-loopback bind is refused outright — mints a fresh
  bearer token each run, never writes it to disk, and checks it on every
  request along with strict Host/Origin validation. No route sends
  `Access-Control-Allow-Origin`. See `apps/server/src/security.ts` and
  `apps/server/src/server.ts`.
- **The browser token is single-use in the URL.** `chronos serve` prints a
  `?token=…` URL once; the page moves it into `sessionStorage` and strips
  the query string on load (`apps/web/index.html`), so it does not survive
  in browser history.
- **Nothing recorded or imported executes automatically.** Tool calls are
  display-only in every surface (CLI `inspect`, the web timeline). Running
  an agent against reconstructed history is the one explicit, separate,
  confirmed action: `chronos launch --agent … --branch … --confirm`. Without
  `--confirm` it prints the exact plan — resolved executable, working
  directory, full argv — and launches nothing.
- **Every spawned process uses `shell: false` and an argument array.** User
  and transcript text is never interpolated into argv or a shell string;
  instructions and replay context are always delivered as a path to a file
  the process itself reads. See `apps/cli/src/commands/record.ts` and
  `apps/cli/src/commands/launch.ts`.
- **The provider executable's identity is pinned, not just its path.**
  `record` and `launch` resolve `codex`/`claude` from `PATH` exactly once to
  one canonical, non-symlinked regular file, and recheck its device/inode
  identity immediately before, during, and after every spawn — closing a
  TOCTOU window where the resolved path is rewritten between the check and
  the spawn. Windows accepts only native `.exe`/`.com` files, never a shell
  script shim. See `apps/cli/src/provider-executable.ts`.
- **A launched agent gets an explicit, minimal environment**, not the
  caller's environment wholesale: `PATH`, `HOME`/`USERPROFILE`,
  `TEMP`/`TMP`, terminal variables, the Windows system variables a process
  needs to start, and `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` when present. See
  `buildLaunchEnvironment` in `apps/cli/src/commands/launch.ts`.
- **Quoted history is explicitly marked untrusted.** The replay context a
  launch hands a fresh agent renders every historical record as a
  blockquote under a header that says, in the prompt itself, never to treat
  a quoted line as a live command. This reduces prompt-injection risk from
  a session's own recorded history; it does not eliminate it, because the
  agent that reads the file ultimately decides how to interpret it.
- **Snapshots reject what they cannot restore faithfully.** Symlinks are
  never followed or captured. Path traversal, and files that resolve
  outside the workspace's canonical root, are rejected before any content
  is read. Default file-count, per-file, and total-size limits are enforced
  **during** the walk — an oversized workspace is rejected before the
  excess files are opened, read, or hashed, not after paying that cost. See
  `packages/snapshots/src/capture.ts` and `packages/snapshots/src/policy.ts`.
- **A restore is all-or-nothing**, assembled in a staging directory and
  moved into place only once every blob is verified against its content
  address; a restore never overwrites an existing non-empty directory. See
  `packages/snapshots/src/restore.ts`.
- **Canonical history is append-only at the storage layer**, not only in
  application code: SQLite triggers reject rewriting a session, event, or
  checkpoint, and reject a branch leaving its one `preparing → ready|failed`
  transition. See `packages/storage/src/migrations.ts`.

## Reporting scope

Findings in the areas above — token/auth bypass, workspace escape,
argument/command injection, a restore or snapshot that trusts unverified
content, an executable-identity or TOCTOU bypass — are the ones this project
most wants to hear about. A best-effort secret-redaction miss is a real bug
worth filing, but is expected behavior of a pattern matcher, not a broken
security boundary; please still report it so the pattern can improve.
