#!/usr/bin/env node
import process from "node:process";

import { run } from "./run.js";

const exitCode = await run(process.argv.slice(2), {
  streams: {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
  },
  cwd: process.cwd(),
  env: process.env,
});

process.exitCode = exitCode;
