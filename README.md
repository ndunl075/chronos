<p align="center">
  <img src="logo.png" alt="Chronos" width="220" />
</p>

# Chronos

Chronos is an open-source time-travel debugger for AI coding-agent sessions.
Import a transcript or record one live, scrub to any point with reconstructable
filesystem state, and branch from there with a new instruction — into an
isolated workspace, running nothing until you explicitly say so.

Chronos is local-first: everything lives under `$CHRONOS_HOME` (default
`~/.chronos`), the server only ever binds `127.0.0.1`, and nothing recorded or
imported executes on its own. v0.1 covers transcript/tool-event replay and
isolated filesystem restoration; it does not rewind process memory, hidden
provider state, or external side effects. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full product contract and
[SECURITY.md](SECURITY.md) for the trust model this runs under.

## Install (from source)

npm publication is out of scope for v0.1 — install from a checkout.

```sh
git clone https://github.com/ndunl075/chronos.git
cd chronos
npm install
npm run build
```

`apps/cli/dist/main.js` is the `chronos` entry point. Run it directly, or
link it onto your `PATH`:

```sh
node apps/cli/dist/main.js --help

# or, to get a `chronos` command:
npm link --workspace apps/cli
chronos --help
```

## Usage

Every command accepts `--home DIR` (default `$CHRONOS_HOME`, or `~/.chronos`)
and `--json` (print the machine-readable result instead of prose).

### Import an observed transcript

```sh
chronos import path/to/session.jsonl --format codex   # or claude, or chronos
```

Codex `0.146.0-alpha.3` and Claude Code `2.1.225` saved sessions are the two
exact, observed formats v0.1 reads; Chronos's own format is documented in
[docs/formats/chronos-jsonl.md](docs/formats/chronos-jsonl.md). An unknown or
missing source version fails the import rather than guessing.

### Record a live session

```sh
chronos record --agent codex --workspace ./my-project --instruction-file task.txt
```

Wraps the installed, exact-version Codex or Claude Code CLI's noninteractive
JSON-stream mode, with a durable baseline snapshot and a checkpoint after
every completed tool-result batch. See
[docs/formats/provider-jsonl.md](docs/formats/provider-jsonl.md) for exactly
what this does and does not capture.

### Inspect what you have

```sh
chronos inspect                                  # list sessions
chronos inspect <session>                        # a session's branches
chronos inspect --branch <branch>                # a branch's timeline
chronos inspect --event <event>                  # one event, in full
```

### Serve the local API and browser timeline

```sh
chronos serve
```

Prints a one-time, tokenized browser URL. The server binds loopback only and
mints a fresh bearer token every run; nothing is written to disk beyond what
you already imported or recorded.

### Branch from a reconstructable event

```sh
chronos branch <session> --at <sequence> --instruction "try a different fix"
```

Restores an isolated copy of the workspace as it existed at that point and
records the new instruction. Nothing here runs anything.

### Launch a fresh agent into a branch

```sh
chronos launch --agent codex --branch <branch>              # prints the plan
chronos launch --agent codex --branch <branch> --confirm    # actually launches it
```

Without `--confirm`, only the plan — resolved executable, working directory,
full argv — is printed. The branch's workspace is re-verified against what
Chronos reconstructed before anything runs.

## Development

Requires Node.js 22.13.0+ and npm 10+. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

```sh
npm install
npm run verify:v0.1   # format:check, lint, build, typecheck, test, smoke
```

The npm workspace boundaries mirror the system map in
[ARCHITECTURE.md](ARCHITECTURE.md): applications live in `apps/`, reusable
domain and infrastructure modules live in `packages/`.

## Project status

See [CHANGELOG.md](CHANGELOG.md) for what shipped in `0.2.0` and
[ROADMAP.md](ROADMAP.md) for what's next.

## License

[MIT](LICENSE)
