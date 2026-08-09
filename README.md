# Chronos

Chronos is an open-source time-travel debugger for AI coding-agent sessions.
Import a session, scrub to a reconstructable point in its transcript, and branch
from there with a new instruction instead of starting over.

Chronos is local-first and currently under active development. The MVP covers
transcript/tool-event replay and isolated filesystem restoration; it does not
rewind process memory, hidden provider state, or external side effects.

## Development

Requires Node.js 22 and npm 10 or newer.

```sh
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The npm workspace boundaries mirror the system map in [ARCHITECTURE.md](ARCHITECTURE.md):
applications live in `apps/`, while reusable domain and infrastructure modules
live in `packages/`. Workspace entry points are intentionally empty until their
delivery phase begins.

## License

[MIT](LICENSE)
