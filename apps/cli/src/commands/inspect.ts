import { existsSync } from "node:fs";

import {
  computeEventCapabilities,
  indexSession,
  resolveVisibleEvents,
  type SessionIndex,
} from "@chronos/core";
import {
  isLogicalSequence,
  type Branch,
  type EventCapabilities,
  type LogicalSequence,
} from "@chronos/protocol";
import {
  ChronosRepository,
  openStorage,
  type ChronosStorage,
} from "@chronos/storage";

import { stringFlag, type CommandSpec, type ParsedArgs } from "../args.js";
import { failure, usageError } from "../errors.js";
import type { ChronosHome } from "../home.js";
import { table } from "../output.js";
import type { CommandContext } from "./import.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export const inspectSpec: CommandSpec = {
  name: "inspect",
  summary:
    "Show what has been imported: sessions, a session's branches, a branch timeline, or one event.",
  positionals: [
    {
      name: "session",
      required: false,
      description: "Session to describe; omit to list all sessions",
    },
  ],
  flags: {
    branch: { type: "string", description: "Show this branch's timeline" },
    event: { type: "string", description: "Show one event in full" },
    from: { type: "string", description: "First sequence to show (default 1)" },
    limit: {
      type: "string",
      description: `Rows to show, at most ${String(MAX_LIMIT)} (default ${String(DEFAULT_LIMIT)})`,
    },
    home: { type: "string", description: "Chronos home directory" },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
};

export function runInspect(args: ParsedArgs, context: CommandContext): void {
  const storage = open(context.home);
  try {
    const repository = new ChronosRepository(storage);
    const sessionId = args.positionals[0];
    const branchId = stringFlag(args, "branch");
    const eventId = stringFlag(args, "event");

    if (eventId !== undefined) {
      if (branchId !== undefined) {
        usageError("--event and --branch describe different things");
      }
      showEvent(repository, eventId, context);
      return;
    }
    if (branchId !== undefined) {
      showTimeline(repository, branchId, args, context);
      return;
    }
    if (sessionId !== undefined) {
      showSession(repository, sessionId, context);
      return;
    }
    listSessions(repository, context);
  } finally {
    storage.close();
  }
}

function listSessions(
  repository: ChronosRepository,
  context: CommandContext,
): void {
  const sessions = repository.listSessions();
  const rows = sessions.map((session) => {
    const branches = repository.listBranches(session.id);
    return {
      id: session.id,
      source: session.source,
      createdAt: session.createdAt,
      branches: branches.length,
      events: branches.reduce(
        (total, branch) => total + repository.countEvents(branch.id),
        0,
      ),
    };
  });

  if (rows.length === 0) {
    context.reporter.line("No sessions have been imported yet.");
    context.reporter.line('Run "chronos import <file.jsonl>" to add one.');
  } else {
    for (const line of table([
      ["SESSION", "SOURCE", "CREATED", "BRANCHES", "EVENTS"],
      ...rows.map((row) => [
        row.id,
        row.source,
        row.createdAt,
        String(row.branches),
        String(row.events),
      ]),
    ])) {
      context.reporter.line(line);
    }
  }
  context.reporter.result({ sessions: rows });
}

function showSession(
  repository: ChronosRepository,
  sessionId: string,
  context: CommandContext,
): void {
  const session = repository.getSession(sessionId);
  if (session === undefined) {
    failure(
      `No such session: ${sessionId}`,
      'Run "chronos inspect" to list the sessions you have',
    );
  }
  const branches = repository.listBranches(sessionId).map((branch) => ({
    id: branch.id,
    state: branch.state,
    parentId: parentOf(branch),
    forkSeq: forkOf(branch),
    ownedEvents: repository.countEvents(branch.id),
    checkpoints: repository.listCheckpoints(branch.id).length,
  }));

  context.reporter.line(`Session ${session.id}`);
  context.reporter.line(`  source   ${session.source}`);
  context.reporter.line(`  created  ${session.createdAt}`);
  context.reporter.line();
  for (const line of table([
    ["BRANCH", "STATE", "FORKED FROM", "OWNED", "CHECKPOINTS"],
    ...branches.map((branch) => [
      branch.id,
      branch.state,
      branch.parentId === undefined
        ? "(root)"
        : `${branch.parentId}@${String(branch.forkSeq)}`,
      String(branch.ownedEvents),
      String(branch.checkpoints),
    ]),
  ])) {
    context.reporter.line(line);
  }
  context.reporter.result({ session, branches });
}

function showTimeline(
  repository: ChronosRepository,
  branchId: string,
  args: ParsedArgs,
  context: CommandContext,
): void {
  const branch = repository.getBranch(branchId);
  if (branch === undefined) failure(`No such branch: ${branchId}`);
  const index = indexFor(repository, branch.sessionId);
  const from = sequenceFlag(args, "from") ?? 1;
  const limit = limitFlag(args);

  const visible = resolveVisibleEvents(index, branchId);
  const page = visible.filter((event) => event.seq >= from).slice(0, limit);
  const rows = page.map((event) => {
    const capabilities = computeEventCapabilities(index, branchId, event.seq);
    return {
      seq: event.seq,
      id: event.id,
      kind: event.kind,
      inherited: event.branchId !== branchId,
      summary: event.summary,
      branchable: capabilities.branchability.status === "branchable",
      /** Present when the event cannot be branched from, so the UI can say why. */
      reason: reasonOf(capabilities),
    };
  });

  context.reporter.line(
    `Branch ${branchId} (${String(visible.length)} events visible)`,
  );
  context.reporter.line();
  for (const line of table([
    ["SEQ", "", "KIND", "SUMMARY"],
    ...rows.map((row) => [
      String(row.seq),
      row.branchable ? "*" : " ",
      row.inherited ? `${row.kind} (inherited)` : row.kind,
      truncate(row.summary, 60),
    ]),
  ])) {
    context.reporter.line(line);
  }
  if (rows.length < visible.length - (from - 1)) {
    context.reporter.line();
    context.reporter.line(
      `Showing ${String(rows.length)} of ${String(visible.length)}; continue with --from ${String(from + rows.length)}`,
    );
  }
  context.reporter.line();
  context.reporter.line("* marks an event a branch can be created from.");
  context.reporter.result({ branchId, visible: visible.length, events: rows });
}

function showEvent(
  repository: ChronosRepository,
  eventId: string,
  context: CommandContext,
): void {
  const event = repository.getEvent(eventId);
  if (event === undefined) failure(`No such event: ${eventId}`);

  context.reporter.line(`Event ${event.id}`);
  context.reporter.line(`  branch    ${event.branchId}`);
  context.reporter.line(`  sequence  ${String(event.seq)}`);
  context.reporter.line(`  kind      ${event.kind}`);
  context.reporter.line(`  occurred  ${event.occurredAt}`);
  context.reporter.line(`  summary   ${event.summary}`);
  context.reporter.line();
  context.reporter.line("Payload:");
  context.reporter.line(JSON.stringify(event.payload.data, null, 2));
  if (event.rawEnvelope !== undefined) {
    context.reporter.line();
    context.reporter.line(
      `Raw data is retained separately under ${event.rawEnvelope.ref}.`,
    );
  }
  if (event.kind === "tool_call") {
    context.reporter.line();
    context.reporter.line(
      "This is a recorded command. Chronos displays it and never runs it.",
    );
  }
  context.reporter.result({ event });
}

function indexFor(
  repository: ChronosRepository,
  sessionId: string,
): SessionIndex {
  return indexSession(repository.loadSessionGraph(sessionId));
}

function reasonOf(capabilities: EventCapabilities): string | undefined {
  return capabilities.branchability.status === "branchable"
    ? undefined
    : capabilities.branchability.reason;
}

function parentOf(branch: Branch): string | undefined {
  return Object.hasOwn(branch, "parentId")
    ? (branch as Extract<Branch, { parentId: string }>).parentId
    : undefined;
}

function forkOf(branch: Branch): number | undefined {
  return Object.hasOwn(branch, "forkSeq")
    ? (branch as Extract<Branch, { forkSeq: LogicalSequence }>).forkSeq
    : undefined;
}

function open(home: ChronosHome): ChronosStorage {
  if (!existsSync(home.databasePath)) {
    failure(
      `No Chronos database at ${home.databasePath}`,
      'Run "chronos import <file.jsonl>" to create one',
    );
  }
  return openStorage({ path: home.databasePath });
}

function sequenceFlag(
  args: ParsedArgs,
  name: string,
): LogicalSequence | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!isLogicalSequence(value)) {
    usageError(`--${name} must be a 1-based integer`);
  }
  return value;
}

function limitFlag(args: ParsedArgs): number {
  const raw = stringFlag(args, "limit");
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    usageError(`--limit must be between 1 and ${String(MAX_LIMIT)}`);
  }
  return value;
}

function truncate(text: string, width: number): string {
  const flattened = text.replaceAll(/\s+/gu, " ").trim();
  return flattened.length <= width
    ? flattened
    : `${flattened.slice(0, width - 1)}�`;
}
