import { apiError } from "./errors.js";
import type { StreamResult } from "./stream.js";

export type HttpMethod = "GET" | "POST";

export interface RequestContext {
  readonly method: HttpMethod;
  readonly path: string;
  /** Values captured from `:name` segments, already URL-decoded. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** Parsed JSON request body, or undefined when the request had none. */
  readonly body: unknown;
}

export interface JsonResult {
  readonly status?: number;
  readonly body: unknown;
}

/** Bytes with a declared type, for the few responses that are not JSON. */
export interface FileResult {
  readonly kind: "file";
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A handler answers with a body or bytes, or takes over the connection. */
export type HandlerResult = JsonResult | FileResult | StreamResult;

export function isFileResult(value: unknown): value is FileResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "file"
  );
}

export type RouteHandler = (
  context: RequestContext,
) => HandlerResult | Promise<HandlerResult>;

export interface Route {
  readonly method: HttpMethod;
  /**
   * A path of literal segments, `:name` parameters, and an optional final
   * `*` capturing the rest of the path into the `*` parameter.
   */
  readonly path: string;
  readonly handler: RouteHandler;
  /**
   * Reachable without a bearer token. Only the page assets are: a browser
   * navigating to a URL cannot send an Authorization header, and the assets
   * carry no session data. Everything else stays behind the token.
   */
  readonly public?: boolean;
}

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
  readonly public: boolean;
}

export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Readonly<Record<string, string>>;
  readonly public: boolean;
}

/**
 * A table of exact routes. There is no wildcard fallback and no automatic
 * static file handling: a request that matches nothing is a 404, and the API
 * surface is exactly what is listed here.
 */
export class Router {
  #routes: readonly CompiledRoute[];

  constructor(routes: readonly Route[]) {
    this.#routes = Object.freeze(
      routes.map((route) => {
        if (!route.path.startsWith("/")) {
          throw new Error(`A route path must start with "/": ${route.path}`);
        }
        return Object.freeze({
          method: route.method,
          segments: Object.freeze(route.path.split("/").slice(1)),
          handler: route.handler,
          public: route.public === true,
        });
      }),
    );
    Object.freeze(this);
  }

  /** Resolve a request, distinguishing "no such path" from "wrong method". */
  resolve(method: string, pathname: string): RouteMatch {
    const segments = pathname.split("/").slice(1);
    let pathMatched = false;
    for (const route of this.#routes) {
      const params = match(route.segments, segments);
      if (params === undefined) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      return { handler: route.handler, params, public: route.public };
    }
    if (pathMatched) {
      apiError("method_not_allowed", "That method is not allowed on this path");
    }
    apiError("not_found", "No such resource");
  }
}

function match(
  pattern: readonly string[],
  actual: readonly string[],
): Readonly<Record<string, string>> | undefined {
  const wildcard = pattern.at(-1) === "*";
  if (wildcard) {
    if (actual.length < pattern.length) return undefined;
  } else if (pattern.length !== actual.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    if (expected === "*") {
      const rest = actual.slice(index);
      try {
        params["*"] = rest.map((part) => decodeURIComponent(part)).join("/");
      } catch {
        return undefined;
      }
      break;
    }
    const found = actual[index]!;
    if (expected.startsWith(":")) {
      if (found.length === 0) return undefined;
      let decoded: string;
      try {
        decoded = decodeURIComponent(found);
      } catch {
        return undefined;
      }
      params[expected.slice(1)] = decoded;
      continue;
    }
    if (expected !== found) return undefined;
  }
  return Object.freeze(params);
}
