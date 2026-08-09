import { ContentStore } from "@chronos/snapshots";
import { ServerConfigError, startServer } from "@chronos/server";
import { ChronosRepository, openStorage } from "@chronos/storage";
import { fileURLToPath } from "node:url";

import { stringFlag, type CommandSpec, type ParsedArgs } from "../args.js";
import { failure, usageError } from "../errors.js";
import { ensureHome } from "../home.js";
import type { CommandContext } from "./import.js";

const WEB_ROOT = fileURLToPath(new URL("../../../web/", import.meta.url));

export const serveSpec: CommandSpec = {
  name: "serve",
  summary:
    "Serve the local API and event stream on loopback. The per-run token is printed once and never stored.",
  positionals: [],
  flags: {
    port: {
      type: "string",
      description: "Port to bind (default 0, an unused one)",
    },
    home: { type: "string", description: "Chronos home directory" },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
};

/**
 * Run the API until the process is asked to stop.
 *
 * The token is minted per run and printed rather than persisted: it lives as
 * long as the server does, so closing the terminal ends the credential too.
 * Anything that can read this output can drive the API, which is the same
 * trust boundary as the database file itself.
 */
export async function runServe(
  args: ParsedArgs,
  context: CommandContext,
): Promise<void> {
  const port = portFlag(args);
  const home = ensureHome(context.home);
  const storage = openStorage({ path: home.databasePath });

  try {
    const repository = new ChronosRepository(storage);
    const store = new ContentStore({ root: home.storeRoot });
    const server = await start(
      repository,
      store,
      home.workspacesRoot,
      WEB_ROOT,
      port,
    );
    const browserUrl = `${server.url}/?token=${encodeURIComponent(server.token)}`;

    context.reporter.line(`Chronos is serving ${server.url}`);
    context.reporter.line(`  token      ${server.token}`);
    context.reporter.line(`  database   ${home.databasePath}`);
    context.reporter.line(`  workspaces ${home.workspacesRoot}`);
    context.reporter.line(`  browser    ${browserUrl}`);
    context.reporter.line();
    context.reporter.line(
      "Send the token as: Authorization: Bearer <token>. Press Ctrl+C to stop.",
    );
    context.reporter.result({
      url: server.url,
      host: server.host,
      port: server.port,
      token: server.token,
      browserUrl,
      databasePath: home.databasePath,
      workspacesRoot: home.workspacesRoot,
    });

    await stopped(context.signal);
    context.reporter.line("Stopping.");
    await server.close();
  } finally {
    storage.close();
  }
}

async function start(
  repository: ChronosRepository,
  store: ContentStore,
  workspacesRoot: string,
  webRoot: string,
  port: number | undefined,
): ReturnType<typeof startServer> {
  try {
    return await startServer({
      repository,
      branching: { store, workspacesRoot },
      web: { root: webRoot },
      ...(port === undefined ? {} : { port }),
    });
  } catch (error) {
    if (error instanceof ServerConfigError) failure(error.message);
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    if (code === "EADDRINUSE") {
      failure(
        `Port ${String(port)} is already in use`,
        "Omit --port to let the operating system pick a free one",
      );
    }
    if (code === "EACCES") {
      failure(`Port ${String(port)} cannot be bound by this user`);
    }
    throw error;
  }
}

/**
 * Wait for the caller's stop signal. Without one the server would run until
 * the process is killed, which is what a bare `chronos serve` should do.
 */
function stopped(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function portFlag(args: ParsedArgs): number | undefined {
  const raw = stringFlag(args, "port");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    usageError("--port must be an integer between 0 and 65535");
  }
  return value;
}
