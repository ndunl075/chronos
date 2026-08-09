import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Buffer } from "node:buffer";

import { PROTOCOL_SCHEMA_VERSION, type ServerInfo } from "@chronos/protocol";

import { ApiError, apiError, toApiError } from "./errors.js";
import { Router, type HttpMethod, type Route } from "./router.js";
import {
  assertTrustedRequest,
  generateToken,
  isLoopbackHost,
} from "./security.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_URL_LENGTH = 2048;
const SUPPORTED_METHODS: readonly string[] = Object.freeze(["GET", "POST"]);

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

export interface ServerOptions {
  /** Loopback only. Defaults to 127.0.0.1. */
  readonly host?: string;
  /** Defaults to 0, which asks the operating system for a free port. */
  readonly port?: number;
  /** Defaults to a fresh per-run token. */
  readonly token?: string;
  /** Largest accepted request body. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number;
  readonly routes?: readonly Route[];
}

export interface ChronosServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** The bearer token every request must present. Print it; never log it. */
  readonly token: string;
  close(): Promise<void>;
}

/**
 * Start the local API.
 *
 * The server binds to loopback, mints a token for the run, refuses any
 * request that is not addressed to it, and sends no CORS headers at all. A
 * non-loopback bind is refused outright rather than quietly exposing an
 * unauthenticated-by-design surface: remote access needs TLS and an auth
 * story this build does not have.
 */
export async function startServer(
  options: ServerOptions = {},
): Promise<ChronosServer> {
  const host = options.host ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new ServerConfigError(
      "Chronos binds to loopback only; remote exposure needs TLS and authentication that this build does not implement",
    );
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ServerConfigError("port must be an integer between 0 and 65535");
  }
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new ServerConfigError("maxRequestBytes must be a positive integer");
  }
  const token = options.token ?? generateToken();
  if (typeof token !== "string" || token.length < 16) {
    throw new ServerConfigError(
      "A bearer token must be at least 16 characters",
    );
  }

  const state: { port: number } = { port: 0 };
  const router = new Router([
    ...infoRoutes(() => state.port, host),
    ...(options.routes ?? []),
  ]);
  const server = createServer((request, response) => {
    void handle(request, response, {
      router,
      token,
      maxRequestBytes,
      port: () => state.port,
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await listen(server, host, port);
  state.port = boundPort(server);
  return Object.freeze({
    host,
    port: state.port,
    url: `http://${host}:${String(state.port)}`,
    token,
    close: () => close(server),
  });
}

function infoRoutes(port: () => number, host: string): readonly Route[] {
  return [
    {
      method: "GET",
      path: "/info",
      handler: () => {
        const info: ServerInfo = {
          schemaVersion: PROTOCOL_SCHEMA_VERSION,
          name: "chronos",
          protocolVersion: PROTOCOL_SCHEMA_VERSION,
          bind: `${host}:${String(port())}`,
        };
        return { body: info };
      },
    },
  ];
}

interface HandlerState {
  readonly router: Router;
  readonly token: string;
  readonly maxRequestBytes: number;
  readonly port: () => number;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  state: HandlerState,
): Promise<void> {
  try {
    assertTrustedRequest(
      request.headers as Readonly<Record<string, string | undefined>>,
      state.port(),
      state.token,
    );
    const target = request.url ?? "";
    if (target.length > DEFAULT_MAX_URL_LENGTH) {
      apiError("bad_request", "The request target is too long");
    }
    const method = request.method ?? "";
    if (!SUPPORTED_METHODS.includes(method)) {
      apiError("method_not_allowed", "That method is not supported");
    }
    const url = new URL(target, "http://chronos.invalid");
    const match = state.router.resolve(method, url.pathname);
    const body =
      method === "POST"
        ? await readJsonBody(request, state.maxRequestBytes)
        : undefined;
    const result = await match.handler({
      method: method as HttpMethod,
      path: url.pathname,
      params: match.params,
      query: url.searchParams,
      body,
    });
    send(response, result.status ?? 200, result.body, request);
  } catch (error) {
    const apiFailure = toApiError(error);
    send(response, apiFailure.status, apiFailure.body(), request);
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxRequestBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > maxRequestBytes) {
      // Stop reading, but let the response reach the client before the
      // connection is torn down; a destroyed socket looks like a crash.
      request.pause();
      apiError("payload_too_large", "The request body is too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  if (
    typeof contentType !== "string" ||
    !contentType
      .split(";")[0]!
      .trim()
      .toLowerCase()
      .startsWith("application/json")
  ) {
    apiError("unsupported_media_type", "The request body must be JSON");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return apiError("bad_request", "The request body is not valid JSON");
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  request?: IncomingMessage,
): void {
  if (response.writableEnded) return;
  const payload = Buffer.from(`${JSON.stringify(body ?? null)}\n`, "utf8");
  // A request the server stopped reading cannot be followed by another one on
  // the same connection, so it is answered and then closed.
  const abandoned = request !== undefined && !request.readableEnded;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    // Canonical records change; a cached copy of one would be a stale replay.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // No access-control-allow-origin: cross-origin reads stay denied.
    vary: "Origin",
    ...(abandoned ? { connection: "close" } : {}),
  });
  response.end(payload, () => {
    if (abandoned) request.destroy();
  });
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new ServerConfigError("The server did not bind to a TCP port");
  }
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

export { ApiError };
