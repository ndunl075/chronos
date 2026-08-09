import {
  ChronosApiClient,
  eventTone,
  nearestEvent,
  type TimelineApi,
  type TimelineEvent,
} from "../src/index.js";

const api: TimelineApi = new ChronosApiClient({
  baseUrl: "http://127.0.0.1:4242",
  token: "per-run-token",
});

const event: TimelineEvent = {
  id: "event-1",
  branchId: "root",
  seq: 1,
  kind: "assistant_message",
  occurredAt: "2026-08-09T00:00:00Z",
  summary: "Ready",
  hasRawEnvelope: false,
};

void api;
void eventTone(event.kind);
void nearestEvent([event], event.seq);

// @ts-expect-error Provider-specific event kinds do not cross the Web boundary.
eventTone("claude_tool_use");
