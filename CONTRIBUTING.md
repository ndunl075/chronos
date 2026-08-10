# Contributing to Chronos

Thanks for looking at Chronos. This document is the short version of how the
project works day to day; [ARCHITECTURE.md](ARCHITECTURE.md) is the long
version — read it first for anything beyond a small fix, since it records the
invariants a change is expected to preserve.

## Setup

Requires Node.js 22.13.0+ and npm 10+.

```sh
git clone https://github.com/ndunl075/chronos.git
cd chronos
npm install
npm run build
```

Chronos is an npm workspaces monorepo: reusable domain/infrastructure code
lives in `packages/*`, and the things that ship — the CLI, the loopback
server, the browser timeline, and the product acceptance tests — live in
`apps/*`. `ARCHITECTURE.md`'s module table maps each directory to what it
owns.

## Running things locally

```sh
npm run format:check   # prettier --check
npm run lint            # eslint
npm run typecheck       # tsc --noEmit, source and tests
npm test                # builds, then runs every workspace's tests
npm run smoke            # builds, then a real source-install smoke test
npm run verify:v0.1      # all of the above, in order — what CI runs
```

Run a single workspace's tests while iterating:

```sh
npm test --workspace apps/cli
```

To try the CLI itself against a scratch home directory:

```sh
CHRONOS_HOME=/tmp/chronos-dev node apps/cli/dist/main.js --help
```

## Before you open a PR

1. Read the relevant section of `ARCHITECTURE.md` and any docs it points to
   (`docs/formats/*.md`) before changing behavior those describe.
2. Add or extend tests for the change. This project does not merge
   untested behavior changes; see "What a good test looks like" below.
3. Run `npm run verify:v0.1` and make sure it's clean.
4. Re-read your own diff before asking someone else to. Most review
   comments are things a second look would have caught.

## What a good test looks like here

Skim any `*.test.mjs` file before writing a new one — the existing style is
the guide, not this document. A few things that are true throughout this
codebase and worth keeping true:

- **Prefer a real filesystem/process over a mock of one.** Tests use real
  temp directories (`mkdtempSync`), a real SQLite connection
  (`IN_MEMORY_PATH` or a temp file), and — for the CLI's provider spawns —
  either a real `child_process` or an injected function with the exact
  shape the real one has. A test that only proves a mock was called is not
  proving the real thing works.
- **Assert on the failure mode, not just the happy path.** Most files in
  this repo pair a success test with at least one adjacent failure test:
  a transaction that fails partway through, a malformed frame, a path that
  tries to escape its root.
- **Security-relevant code gets an adversarial test, not just a unit test.**
  If you touch snapshot capture, executable resolution, path containment,
  or process spawning, add a test that tries to defeat the guarantee (a
  symlink, a TOCTOU rewrite, a traversal path), not only one that exercises
  the intended path.

## Commit and PR conventions

- Commit messages follow `type(scope): summary` in the imperative mood
  (`feat(cli): launch a fresh agent into a branch's verified workspace`),
  matching this repo's existing history — `git log --oneline` is the best
  reference. The body explains _why_, and calls out anything a reviewer
  would otherwise have to dig for (a safeguard added, a behavior
  deliberately not changed, a residual risk documented).
- Each meaningful, independently-verified change is its own commit rather
  than one large one — see `ARCHITECTURE.md`'s "Delivery phases" for the
  granularity this project works at.
- Branch off `main` rather than committing to it directly.

## Ground rules from the architecture

These are load-bearing, not stylistic — a change that violates one needs a
different design, not a suppressed lint rule:

- Never invent a provider transcript format. Codex and Claude Code adapters
  are written only from observed, fixture-backed saved-session files; a
  new provider surface fails closed (with a diagnostic) rather than being
  guessed at.
- Never auto-run an imported or recorded tool call, and never auto-launch
  from the server or the web UI. Execution is always the CLI's
  `chronos launch --confirm`, after showing the user the exact plan.
- Never rewrite canonical history. Sessions, events, and checkpoints are
  append-only, enforced by storage triggers, not only in application code.
- Never write a snapshot or restored workspace into the repository or
  workspace being inspected — a content store and an inspected workspace
  must live outside one another.

## Reporting a security issue

See [SECURITY.md](SECURITY.md) — please don't open a public issue for a
vulnerability.
