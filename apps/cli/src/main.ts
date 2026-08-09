#!/usr/bin/env node
import process from "node:process";

import { run } from "./run.js";

// Ctrl+C and a supervisor's TERM both mean "stop cleanly", not "die now".
const stopping = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stopping.abort());
}

const exitCode = await run(process.argv.slice(2), {
  streams: {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
  },
  cwd: process.cwd(),
  env: process.env,
  signal: stopping.signal,
});

process.exitCode = exitCode;
