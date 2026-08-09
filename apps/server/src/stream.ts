import type { ServerResponse } from "node:http";

import {
  PROTOCOL_SCHEMA_VERSION,
  type ProtocolSchemaVersion,
} from "@chronos/protocol";

/**
 * What the server broadcasts when history grows.
 *
 * Only identifiers travel on the stream. A client that cares fetches the
 * canonical record over the authenticated API, so the event stream never
 * becomes a second, weaker copy of the transcript that could drift from it.
 */
export interface AppendedNotice {
  readonly schemaVersion: ProtocolSchemaVersion;
  readonly sessionId: string;
  readonly branchId: string;
  readonly eventIds: readonly string[];
}

export function appendedNotice(
  sessionId: string,
  branchId: string,
  eventIds: readonly string[],
): AppendedNotice {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    sessionId,
    branchId,
    eventIds: Object.freeze([...eventIds]),
  };
}

export type Listener = (notice: AppendedNotice) => void;

/** Fan-out to the clients watching one session. */
export class EventBroadcaster {
  #listeners = new Map<string, Set<Listener>>();

  /** Returns the function that stops the subscription. */
  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  }

  /**
   * Deliver to every current subscriber. A listener that throws is dropped
   * rather than allowed to break the append that triggered the broadcast.
   */
  publish(notice: AppendedNotice): void {
    const listeners = this.#listeners.get(notice.sessionId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(notice);
      } catch {
        listeners.delete(listener);
      }
    }
  }

  subscriberCount(sessionId: string): number {
    return this.#listeners.get(sessionId)?.size ?? 0;
  }
}

export interface SseWriter {
  send(event: string, data: unknown): void;
  /** A comment line; it keeps proxies and idle sockets from timing out. */
  comment(text: string): void;
  close(): void;
}

/** A route that streams instead of answering with a body. */
export interface StreamResult {
  readonly kind: "sse";
  /** Called once with the writer; returns the cleanup for when it ends. */
  readonly open: (writer: SseWriter) => () => void;
}

export function isStreamResult(value: unknown): value is StreamResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "sse"
  );
}

export function createSseWriter(response: ServerResponse): SseWriter {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
    // No access-control-allow-origin: a stream is as sensitive as a read.
    vary: "Origin",
  });
  // Tell a reconnecting client how long to wait, so it does not spin.
  response.write("retry: 2000\n\n");
  return {
    send(event, data) {
      if (response.writableEnded) return;
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (response.writableEnded) return;
      response.write(`: ${text}\n\n`);
    },
    close() {
      if (!response.writableEnded) response.end();
    },
  };
}
