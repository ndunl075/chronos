import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import { apiError } from "./errors.js";
import type { FileResult, RequestContext, Route } from "./router.js";

export interface WebAssetOptions {
  /** Directory holding index.html and the built page assets. */
  readonly root: string;
}

/*
 * Only these types are served, and nothing outside the configured directory.
 * An allowlist is the difference between a page server and an arbitrary file
 * reader pointed at a user's home directory.
 */
const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
});

/*
 * The page is framed by nothing and loads nothing it did not ship with. The
 * inline allowances are for the bootstrap script and the stylesheet the page
 * injects; record data never reaches HTML, it is written with textContent.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Serve the browser UI from the API's own origin.
 *
 * These routes are public, because a browser navigating to a URL cannot send
 * an Authorization header. That is safe only because the assets are inert:
 * they carry no session data, and every record still requires the token. The
 * Host and Origin checks apply here exactly as they do to the API, so a
 * rebound hostname is refused before a file is ever read.
 */
export function webRoutes(options: WebAssetOptions): readonly Route[] {
  const root = realpathSync(resolve(options.root));
  const serve = (context: RequestContext): FileResult =>
    file(root, context.params["*"] ?? "index.html");
  return Object.freeze([
    { method: "GET" as const, path: "/", handler: serve, public: true },
    { method: "GET" as const, path: "/*", handler: serve, public: true },
  ]);
}

function file(root: string, requested: string): FileResult {
  const relative = requested.length === 0 ? "index.html" : requested;
  const segments = relative.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    apiError("not_found", "No such resource");
  }

  const target = resolve(root, ...segments);
  // Containment is checked after resolution, so no encoding of `..` survives.
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    apiError("not_found", "No such resource");
  }
  const contentType = MEDIA_TYPES[extname(target).toLowerCase()];
  if (contentType === undefined) {
    apiError("not_found", "No such resource");
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    apiError("not_found", "No such resource");
  }

  // Lexical containment is not enough when an intermediate directory is a
  // symlink. Resolve the actual file and check it against the actual root.
  const actual = realpathSync(target);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    apiError("not_found", "No such resource");
  }

  return {
    kind: "file",
    contentType,
    body: new Uint8Array(readFileSync(actual)),
    headers: {
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "referrer-policy": "no-referrer",
    },
  };
}
