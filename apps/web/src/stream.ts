/**
 * Live session updates over a fetch-consumed SSE body.
 *
 * `EventSource` cannot send an `Authorization` header, and every Chronos
 * route but the static assets requires the per-run bearer token, so the
 * stream is read the same way `ChronosApiClient` reads everything else: an
 * authenticated `fetch`, here read incrementally instead of buffered whole.
 * Nothing here touches the DOM, which is what keeps it testable in plain
 * Node without a browser.
 */

export type StreamConnectionState =
  "connecting" | "open" | "reconnecting" | "closed";

/** What the server broadcasts when a branch's history grows. */
export interface StreamNotice {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly branchId: string;
  readonly eventIds: readonly string[];
}

export interface StreamHandlers {
  readonly onAppended: (notice: StreamNotice) => void;
  readonly onStateChange?: (state: StreamConnectionState) => void;
}

/** Only the shape of `fetch` a stream reader needs: a cancellable byte body. */
export type StreamFetch = (
  input: string,
  init: Readonly<{
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }>,
) => Promise<
  Readonly<{
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array> | null;
  }>
>;

export interface OpenEventStreamOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly fetch?: StreamFetch;
  /** Base backoff between reconnect attempts; grows linearly, capped at 30s. */
  readonly reconnectDelayMs?: number;
}

/** One SSE frame's worth of buffered, unparsed text can hold at most this. */
const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Subscribe to a session's live stream until `signal` aborts.
 *
 * A dropped connection — network blip, server restart, a deliberately
 * malformed frame, the stream simply ending — reconnects with linear
 * backoff rather than surfacing an error the caller has to remember to
 * retry. Every transition is reported through `onStateChange`; this
 * function itself never throws into its caller.
 */
export function openEventStream(
  options: OpenEventStreamOptions,
  handlers: StreamHandlers,
  signal: AbortSignal,
): void {
  void run(options, handlers, signal);
}

async function run(
  options: OpenEventStreamOptions,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const fetchImpl = options.fetch ?? defaultStreamFetch;
  const url = `${normalizeStreamBaseUrl(options.baseUrl)}/sessions/${encodeURIComponent(options.sessionId)}/stream`;
  const baseDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  let attempt = 0;

  while (!signal.aborted) {
    handlers.onStateChange?.(attempt === 0 ? "connecting" : "reconnecting");
    try {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${options.token}` },
        signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`Chronos stream failed (${String(response.status)})`);
      }
      attempt = 0;
      handlers.onStateChange?.("open");
      await consume(response.body, handlers, signal);
      // The body ended without the signal aborting: the server closed the
      // connection cleanly. Reconnect exactly as if it had dropped.
    } catch {
      // Any failure here — fetch rejection, a non-ok response, a frame over
      // the size limit — is handled identically: fall through to reconnect.
    }
    if (signal.aborted) break;
    attempt += 1;
    await sleep(Math.min(baseDelay * attempt, MAX_RECONNECT_DELAY_MS), signal);
  }
  handlers.onStateChange?.("closed");
}

async function consume(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > MAX_FRAME_BYTES) {
        throw new Error("Chronos stream frame exceeded the size limit");
      }
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        dispatchFrame(buffered.slice(0, boundary), handlers);
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** A malformed frame is skipped, never thrown: one bad frame must not drop the rest. */
function dispatchFrame(raw: string, handlers: StreamHandlers): void {
  const lines = raw.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (eventLine === undefined || dataLine === undefined) return;
  if (eventLine.slice("event: ".length).trim() !== "appended") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLine.slice("data: ".length)) as unknown;
  } catch {
    return;
  }
  const notice = asStreamNotice(parsed);
  if (notice !== undefined) handlers.onAppended(notice);
}

function asStreamNotice(value: unknown): StreamNotice | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const eventIds = record["eventIds"];
  if (
    typeof record["schemaVersion"] !== "number" ||
    typeof record["sessionId"] !== "string" ||
    typeof record["branchId"] !== "string" ||
    !Array.isArray(eventIds) ||
    !eventIds.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: record["schemaVersion"],
    sessionId: record["sessionId"],
    branchId: record["branchId"],
    eventIds: Object.freeze([...eventIds]),
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const defaultStreamFetch: StreamFetch = async (input, init) => {
  const response = await fetch(input, init);
  return { ok: response.ok, status: response.status, body: response.body };
};

function normalizeStreamBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
