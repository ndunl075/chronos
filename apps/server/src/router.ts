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

/** A handler answers with a body, or takes over the connection to stream. */
export type HandlerResult = JsonResult | StreamResult;

export type RouteHandler = (
  context: RequestContext,
) => HandlerResult | Promise<HandlerResult>;

export interface Route {
  readonly method: HttpMethod;
  /** A path with literal segments and `:name` parameters. */
  readonly path: string;
  readonly handler: RouteHandler;
}

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Readonly<Record<string, string>>;
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
      return { handler: route.handler, params };
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
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
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
