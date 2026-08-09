import {
  CoreDomainError,
  computeEventCapabilities,
  indexSession,
  resolveVisibleEvents,
  type SessionIndex,
} from "@chronos/core";
import {
  PROTOCOL_SCHEMA_VERSION,
  isLogicalSequence,
  type ApiPage,
  type ApiResource,
  type Branch,
  type Checkpoint,
  type Event,
  type EventSummary,
  type JsonValue,
  type LogicalSequence,
  type Session,
} from "@chronos/protocol";
import { StorageError, type ChronosRepository } from "@chronos/storage";
import {
  DEFAULT_REDACTION_POLICY,
  redactJson,
  redactText,
} from "@chronos/adapters";

import { ApiError, apiError } from "./errors.js";
import type { RequestContext, Route } from "./router.js";
import {
  appendedNotice,
  type EventBroadcaster,
  type StreamResult,
} from "./stream.js";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

export interface SessionOverview {
  readonly session: Session;
  readonly branches: readonly Branch[];
}

/**
 * The read surface over stored sessions.
 *
 * Handlers translate storage and domain failures into status codes and never
 * surface an internal message: a caller learns that a branch is unknown, not
 * how the query that looked for it was shaped.
 */
export function readRoutes(repository: ChronosRepository): readonly Route[] {
  return Object.freeze([
    {
      method: "GET" as const,
      path: "/sessions",
      handler: () => {
        const sessions = guard(() => repository.listSessions());
        return { body: page(sessions, sessions.length) };
      },
    },
    {
      method: "GET" as const,
      path: "/sessions/:sessionId",
      handler: (context: RequestContext) => {
        const sessionId = requiredParam(context, "sessionId");
        const session = guard(() => repository.getSession(sessionId));
        if (session === undefined) apiError("not_found", "No such session");
        const overview: SessionOverview = {
          session,
          branches: guard(() => repository.listBranches(sessionId)),
        };
        return { body: resource(overview) };
      },
    },
    {
      method: "GET" as const,
      path: "/branches/:branchId/events",
      handler: (context: RequestContext) => {
        const branchId = requiredBranch(repository, context);
        const { fromSeq, limit } = pageQuery(context);
        const items = guard(() =>
          repository.listEventSummaries(branchId, { fromSeq, limit }),
        );
        const total = guard(() => repository.countEvents(branchId));
        return { body: page(items, total, nextSeq(items, limit)) };
      },
    },
    {
      method: "GET" as const,
      path: "/branches/:branchId/checkpoints",
      handler: (context: RequestContext) => {
        const branchId = requiredBranch(repository, context);
        const items: readonly Checkpoint[] = guard(() =>
          repository.listCheckpoints(branchId),
        );
        return { body: page(items, items.length) };
      },
    },
    {
      method: "GET" as const,
      path: "/events/:eventId",
      handler: (context: RequestContext) => {
        const eventId = requiredParam(context, "eventId");
        const event: Event | undefined = guard(() =>
          repository.getEvent(eventId),
        );
        if (event === undefined) apiError("not_found", "No such event");
        return { body: resource(event) };
      },
    },
    {
      /*
       * The effective transcript for a branch, which is inherited parent
       * history plus what the branch owns. Lineage lives in the domain core,
       * so this route indexes the session rather than resolving it in SQL.
       */
      method: "GET" as const,
      path: "/branches/:branchId/timeline",
      handler: (context: RequestContext) => {
        const branchId = requiredParam(context, "branchId");
        const branch = guard(() => repository.getBranch(branchId));
        if (branch === undefined) apiError("not_found", "No such branch");
        const index = indexFor(repository, branch.sessionId);
        const { fromSeq, limit } = pageQuery(context);
        const through = optionalSequence(context, "through");
        const visible = guard(() =>
          resolveVisibleEvents(index, branchId, through).map(toSummary),
        );
        const window = visible.filter((item) => item.seq >= fromSeq);
        const items = window.slice(0, limit);
        return { body: page(items, visible.length, nextSeq(items, limit)) };
      },
    },
    {
      method: "GET" as const,
      path: "/branches/:branchId/events/:seq/capabilities",
      handler: (context: RequestContext) => {
        const branchId = requiredParam(context, "branchId");
        const branch = guard(() => repository.getBranch(branchId));
        if (branch === undefined) apiError("not_found", "No such branch");
        const seq = requiredSequence(context, "seq");
        const index = indexFor(repository, branch.sessionId);
        return {
          body: resource(
            guard(() => computeEventCapabilities(index, branchId, seq)),
          ),
        };
      },
    },
  ]);
}

/*
 * Each request that needs lineage rebuilds the index for its session. That is
 * honest but not free; when a session outgrows it, the fix is a cache keyed by
 * the session's last appended event id, not lineage logic duplicated in SQL.
 */
function indexFor(
  repository: ChronosRepository,
  sessionId: string,
): SessionIndex {
  const graph = guard(() => repository.loadSessionGraph(sessionId));
  return guard(() => indexSession(graph));
}

function toSummary(event: Event): EventSummary {
  return {
    id: event.id,
    branchId: event.branchId,
    seq: event.seq,
    kind: event.kind,
    occurredAt: event.occurredAt,
    summary: event.summary,
    hasRawEnvelope: event.rawEnvelope !== undefined,
  };
}

/** @internal Shared by the route modules. */
export function resource<Data>(data: Data): ApiResource<Data> {
  return { schemaVersion: PROTOCOL_SCHEMA_VERSION, data };
}

function page<Item>(
  items: readonly Item[],
  total: number,
  next?: LogicalSequence,
): ApiPage<Item> {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    items,
    total,
    ...(next === undefined ? {} : { nextSeq: next }),
  };
}

function nextSeq(
  items: readonly { readonly seq: LogicalSequence }[],
  limit: number,
): LogicalSequence | undefined {
  if (items.length < limit) return undefined;
  const last = items.at(-1);
  if (last === undefined) return undefined;
  const candidate = last.seq + 1;
  return isLogicalSequence(candidate) ? candidate : undefined;
}

function pageQuery(context: RequestContext): {
  fromSeq: LogicalSequence;
  limit: number;
} {
  const rawFrom = context.query.get("fromSeq");
  const rawLimit = context.query.get("limit");
  const fromSeq = rawFrom === null ? 1 : Number(rawFrom);
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (!isLogicalSequence(fromSeq)) {
    apiError("bad_request", "fromSeq must be a 1-based integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    apiError(
      "bad_request",
      `limit must be between 1 and ${String(MAX_PAGE_SIZE)}`,
    );
  }
  return { fromSeq, limit };
}

/** @internal */
export function requiredParam(context: RequestContext, name: string): string {
  const value = context.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    apiError("bad_request", `${name} is required`);
  }
  return value;
}

function requiredBranch(
  repository: ChronosRepository,
  context: RequestContext,
): string {
  const branchId = requiredParam(context, "branchId");
  if (guard(() => repository.getBranch(branchId)) === undefined) {
    apiError("not_found", "No such branch");
  }
  return branchId;
}

function requiredSequence(
  context: RequestContext,
  name: string,
): LogicalSequence {
  const value = Number(requiredParam(context, name));
  if (!isLogicalSequence(value)) {
    apiError("bad_request", `${name} must be a 1-based integer`);
  }
  return value;
}

function optionalSequence(
  context: RequestContext,
  name: string,
): LogicalSequence | undefined {
  const raw = context.query.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!isLogicalSequence(value)) {
    apiError("bad_request", `${name} must be a 1-based integer`);
  }
  return value;
}

/** Translate the layers below into status codes a client can act on. */
/** @internal Translate the layers below into status codes. */
export function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof StorageError) {
      if (error.code === "UNKNOWN_RECORD")
        apiError("not_found", "No such record");
      if (error.code === "INVALID_PAGE" || error.code === "INVALID_RECORD") {
        apiError("bad_request", "The request names something unusable");
      }
      if (error.code === "INVALID_STATE_TRANSITION") {
        apiError("conflict", "That record has already settled");
      }
      if (error.code === "DUPLICATE_RECORD") {
        apiError("conflict", "That record already exists");
      }
      if (error.code === "CONSTRAINT_VIOLATION") {
        // A write that history refuses is the caller disagreeing with what is
        // already stored, not a server fault.
        apiError("conflict", "That write conflicts with the stored history");
      }
      throw error;
    }
    if (error instanceof CoreDomainError) {
      if (error.code === "UNKNOWN_BRANCH" || error.code === "UNKNOWN_EVENT") {
        apiError("not_found", "No such record");
      }
      if (error.code === "INVALID_TARGET") {
        apiError("bad_request", "That coordinate is outside the branch");
      }
      if (error.code === "NOT_BRANCHABLE") {
        apiError("conflict", "That event cannot reconstruct workspace state");
      }
      throw error;
    }
    throw error;
  }
}

const MAX_APPEND_BATCH = 500;

/**
 * The write and live-view surface.
 *
 * An append lands in one transaction and only then broadcasts. Subscribers
 * receive event identifiers and fetch the canonical records themselves, so
 * the stream can never disagree with what is stored.
 */
export function writeRoutes(
  repository: ChronosRepository,
  broadcaster: EventBroadcaster,
): readonly Route[] {
  return Object.freeze([
    {
      method: "POST" as const,
      path: "/branches/:branchId/events",
      handler: (context: RequestContext) => {
        const branchId = requiredParam(context, "branchId");
        const branch = guard(() => repository.getBranch(branchId));
        if (branch === undefined) apiError("not_found", "No such branch");
        const events = appendBody(context, branchId);
        const appended = guard(() => repository.appendEvents(events));
        broadcaster.publish(
          appendedNotice(
            branch.sessionId,
            branchId,
            appended.map((item) => item.id),
          ),
        );
        return {
          status: 201,
          body: page(appended.map(toSummary), appended.length),
        };
      },
    },
    {
      method: "GET" as const,
      path: "/sessions/:sessionId/stream",
      handler: (context: RequestContext): StreamResult => {
        const sessionId = requiredParam(context, "sessionId");
        if (guard(() => repository.getSession(sessionId)) === undefined) {
          apiError("not_found", "No such session");
        }
        return {
          kind: "sse",
          open: (writer) => {
            writer.send("open", {
              schemaVersion: PROTOCOL_SCHEMA_VERSION,
              sessionId,
            });
            return broadcaster.subscribe(sessionId, (notice) => {
              writer.send("appended", notice);
            });
          },
        };
      },
    },
  ]);
}

/**
 * Validate an append request and redact it.
 *
 * Redaction happens here rather than in storage because this is the boundary
 * where data that was never under Chronos control arrives; a live agent posts
 * whatever its tools produced, including whatever those tools printed.
 */
function appendBody(
  context: RequestContext,
  branchId: string,
): readonly Event[] {
  const body = context.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    apiError("bad_request", "The request body must be an object");
  }
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) {
    apiError("bad_request", "events must be a non-empty array");
  }
  if (events.length > MAX_APPEND_BATCH) {
    apiError("payload_too_large", "Too many events in one append");
  }
  return events.map((candidate) => {
    if (candidate === null || typeof candidate !== "object") {
      apiError("bad_request", "Each event must be an object");
    }
    const record = candidate as Record<string, unknown>;
    if (record["branchId"] !== branchId) {
      apiError("bad_request", "An event must name the branch it is posted to");
    }
    const payload = record["payload"];
    if (
      payload === null ||
      typeof payload !== "object" ||
      !("data" in (payload as object))
    ) {
      apiError("bad_request", "Each event needs a canonical payload envelope");
    }
    const envelope = payload as { schemaVersion?: unknown; data: JsonValue };
    const summary =
      typeof record["summary"] === "string" ? record["summary"] : "";
    return {
      ...record,
      summary: redactText(summary, DEFAULT_REDACTION_POLICY).value,
      payload: {
        ...envelope,
        data: redactJson(envelope.data, DEFAULT_REDACTION_POLICY).value,
      },
    } as unknown as Event;
  });
}
