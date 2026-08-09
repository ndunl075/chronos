import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import { apiError } from "./errors.js";

/** Hostnames that resolve to this machine and nowhere else. */
const LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.includes(normalized) || normalized === "::1";
}

/** A fresh secret for one run. It is never persisted and never logged. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function bearerToken(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1];
}

/** Constant-time comparison, so a wrong token leaks nothing about the right one. */
export function tokensMatch(
  provided: string | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string") return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Accept only a Host header naming this loopback server on this port.
 *
 * Without this check, any web page could point a hostname it controls at
 * 127.0.0.1 and have the browser send authenticated-looking requests to a
 * server that was never meant to be reachable from the web. The port has to
 * match too, since a rebinding attack picks its own.
 */
export function isAllowedHost(
  header: string | undefined,
  port: number,
): boolean {
  if (typeof header !== "string") return false;
  const separator = header.lastIndexOf(":");
  const hostPart = separator === -1 ? header : header.slice(0, separator);
  const portPart = separator === -1 ? "" : header.slice(separator + 1);
  if (portPart !== String(port)) return false;
  return isLoopbackHost(hostPart);
}

/**
 * A cross-origin request is refused outright, and no CORS header is ever sent
 * back, so a browser will not hand a response to another origin either.
 */
export function isAllowedOrigin(
  header: string | undefined,
  port: number,
): boolean {
  if (header === undefined) return true;
  if (header === "null") return false;
  let url: URL;
  try {
    url = new URL(header);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.port !== String(port)) return false;
  return isLoopbackHost(url.hostname);
}

/**
 * Refuse a request that could not have come from this machine's own client.
 * This applies to every request, including the ones that carry no token.
 */
export function assertTrustedOrigin(
  headers: Readonly<Record<string, string | undefined>>,
  port: number,
): void {
  if (!isAllowedHost(headers["host"], port)) {
    apiError("forbidden", "The request was not addressed to this server");
  }
  if (!isAllowedOrigin(headers["origin"], port)) {
    apiError("forbidden", "Cross-origin requests are not accepted");
  }
}

export function assertToken(
  headers: Readonly<Record<string, string | undefined>>,
  token: string,
): void {
  if (!tokensMatch(bearerToken(headers["authorization"]), token)) {
    apiError("unauthorized", "A valid bearer token is required");
  }
}

/** Refuse anything that is not a fully trusted, authenticated request. */
export function assertTrustedRequest(
  headers: Readonly<Record<string, string | undefined>>,
  port: number,
  token: string,
): void {
  assertTrustedOrigin(headers, port);
  assertToken(headers, token);
}
