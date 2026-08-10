import {
  openEventStream,
  type StreamConnectionState,
  type StreamFetch,
  type StreamHandlers,
  type StreamNotice,
} from "./stream.js";

export {
  openEventStream,
  type StreamConnectionState,
  type StreamFetch,
  type StreamHandlers,
  type StreamNotice,
} from "./stream.js";

export type EventKind =
  | "instruction"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "filesystem_change"
  | "checkpoint"
  | "system"
  | "error";

export interface SessionSummary {
  readonly id: string;
  readonly source: string;
  readonly createdAt: string;
}

export interface BranchSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly state: "preparing" | "ready" | "failed";
  readonly parentId?: string;
  readonly forkSeq?: number;
}

export interface TimelineEvent {
  readonly id: string;
  readonly branchId: string;
  readonly seq: number;
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly summary: string;
  readonly hasRawEnvelope: boolean;
}

export interface EventDetail extends TimelineEvent {
  readonly payload: unknown;
}

export interface EventCapabilities {
  readonly eventId: string;
  readonly replayability:
    | { readonly status: "replayable" }
    | { readonly status: "unavailable"; readonly reason: string };
  readonly branchability:
    | {
        readonly status: "branchable";
        readonly reconstruction: {
          readonly kind: "exact" | "checkpoint_plus_deltas";
          readonly checkpointEventSeq: number;
          readonly effectiveRestoreSeq: number;
        };
      }
    | { readonly status: "unavailable"; readonly reason: string };
}

export interface SessionOverview {
  readonly session: SessionSummary;
  readonly branches: readonly BranchSummary[];
}

export interface BranchResult {
  readonly branch: BranchSummary;
  readonly launchPlan: { readonly workspacePath: string };
}

export interface TimelineApi {
  listSessions(): Promise<readonly SessionSummary[]>;
  getSession(sessionId: string): Promise<SessionOverview>;
  getTimeline(branchId: string): Promise<readonly TimelineEvent[]>;
  /** Only events from `fromSeq` on; what a live refresh fetches instead of everything. */
  getTimelineSince(
    branchId: string,
    fromSeq: number,
  ): Promise<readonly TimelineEvent[]>;
  getEvent(eventId: string): Promise<EventDetail>;
  getCapabilities(branchId: string, seq: number): Promise<EventCapabilities>;
  createBranch(
    sessionId: string,
    input: {
      readonly parentBranchId: string;
      readonly forkSeq: number;
      readonly instruction: string;
    },
  ): Promise<BranchResult>;
  /** Subscribe to a session's live stream until `signal` aborts. */
  openStream(
    sessionId: string,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): void;
}

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

interface ApiPage<T> {
  readonly schemaVersion: number;
  readonly items: readonly T[];
  readonly nextSeq?: number;
}

interface ApiResource<T> {
  readonly schemaVersion: number;
  readonly data: T;
}

export class ChronosApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChronosApiError";
  }
}

/** Same-origin client for the authenticated loopback API. */
export class ChronosApiClient implements TimelineApi {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #streamFetch: StreamFetch | undefined;

  constructor(options: {
    readonly baseUrl: string;
    readonly token: string;
    readonly fetch?: FetchLike;
    /** Test seam for the live stream's raw byte-body fetch. */
    readonly streamFetch?: StreamFetch;
  }) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = options.token.trim();
    this.#fetch = options.fetch ?? fetch;
    this.#streamFetch = options.streamFetch;
    if (this.#token.length === 0) throw new Error("A server token is required");
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return (await this.#request<ApiPage<SessionSummary>>("/sessions")).items;
  }

  async getSession(sessionId: string): Promise<SessionOverview> {
    return (
      await this.#request<ApiResource<SessionOverview>>(
        `/sessions/${encodeURIComponent(sessionId)}`,
      )
    ).data;
  }

  async getTimeline(branchId: string): Promise<readonly TimelineEvent[]> {
    return this.getTimelineSince(branchId, 1);
  }

  async getTimelineSince(
    branchId: string,
    fromSeq: number,
  ): Promise<readonly TimelineEvent[]> {
    const all: TimelineEvent[] = [];
    let cursor = fromSeq;
    for (;;) {
      const page = await this.#request<ApiPage<TimelineEvent>>(
        `/branches/${encodeURIComponent(branchId)}/timeline?fromSeq=${String(cursor)}&limit=500`,
      );
      all.push(...page.items);
      if (page.nextSeq === undefined) return Object.freeze(all);
      cursor = page.nextSeq;
    }
  }

  openStream(
    sessionId: string,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): void {
    openEventStream(
      {
        baseUrl: this.#baseUrl,
        token: this.#token,
        sessionId,
        ...(this.#streamFetch === undefined
          ? {}
          : { fetch: this.#streamFetch }),
      },
      handlers,
      signal,
    );
  }

  async getEvent(eventId: string): Promise<EventDetail> {
    return (
      await this.#request<ApiResource<EventDetail>>(
        `/events/${encodeURIComponent(eventId)}`,
      )
    ).data;
  }

  async getCapabilities(
    branchId: string,
    seq: number,
  ): Promise<EventCapabilities> {
    return (
      await this.#request<ApiResource<EventCapabilities>>(
        `/branches/${encodeURIComponent(branchId)}/events/${String(seq)}/capabilities`,
      )
    ).data;
  }

  async createBranch(
    sessionId: string,
    input: {
      readonly parentBranchId: string;
      readonly forkSeq: number;
      readonly instruction: string;
    },
  ): Promise<BranchResult> {
    return (
      await this.#request<ApiResource<BranchResult>>(
        `/sessions/${encodeURIComponent(sessionId)}/branches`,
        { method: "POST", body: JSON.stringify(input) },
      )
    ).data;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        readErrorMessage(body) ??
        `Chronos request failed (${String(response.status)})`;
      throw new ChronosApiError(response.status, message);
    }
    return body as T;
  }
}

export function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//u.test(normalized)) {
    throw new Error("Server URL must start with http:// or https://");
  }
  return normalized;
}

export function nearestEvent(
  events: readonly TimelineEvent[],
  targetSeq: number,
): TimelineEvent | undefined {
  if (events.length === 0) return undefined;
  let nearest = events[0]!;
  for (const event of events) {
    if (Math.abs(event.seq - targetSeq) < Math.abs(nearest.seq - targetSeq)) {
      nearest = event;
    }
  }
  return nearest;
}

export function eventTone(
  kind: EventKind,
): "agent" | "human" | "machine" | "fault" {
  if (kind === "instruction") return "human";
  if (kind === "assistant_message") return "agent";
  if (kind === "error") return "fault";
  return "machine";
}

/** Chronos's default cap on individually rendered timeline rows. */
export const DEFAULT_MAX_RENDERED_ROWS = 500;

/**
 * Cap how many rows a large history actually renders as DOM nodes.
 *
 * The scrubber and event lookup still work over the full array; this only
 * bounds what gets painted, keeping the newest rows (the ones a live session
 * is actively growing) always visible.
 */
export function boundRenderedRows<T>(
  events: readonly T[],
  max: number = DEFAULT_MAX_RENDERED_ROWS,
): Readonly<{ visible: readonly T[]; hiddenCount: number }> {
  if (events.length <= max) {
    return Object.freeze({ visible: events, hiddenCount: 0 });
  }
  return Object.freeze({
    visible: Object.freeze(events.slice(events.length - max)),
    hiddenCount: events.length - max,
  });
}

export function mountChronos(root: HTMLElement, api: TimelineApi): () => void {
  const app = new ChronosTimeline(root, api);
  void app.start();
  return () => app.destroy();
}

class ChronosTimeline {
  readonly #root: HTMLElement;
  readonly #api: TimelineApi;
  readonly #abort = new AbortController();
  #session?: SessionOverview;
  #branchId?: string;
  #events: readonly TimelineEvent[] = [];
  #selected?: TimelineEvent;
  #streamAbort?: AbortController;

  constructor(root: HTMLElement, api: TimelineApi) {
    this.#root = root;
    this.#api = api;
    injectStyles();
    this.#root.classList.add("chronos-root");
    this.#root.innerHTML = shellMarkup;
    this.#setConnectionState("closed");
    this.#listen();
  }

  async start(): Promise<void> {
    this.#setStatus("Reading the archive…");
    try {
      const sessions = await this.#api.listSessions();
      const select = this.#query<HTMLSelectElement>("[data-sessions]");
      select.replaceChildren(
        ...sessions.map((session) =>
          option(session.id, `${session.source} · ${shortId(session.id)}`),
        ),
      );
      if (sessions[0] === undefined) {
        this.#setStatus("No sessions yet. Import one from the CLI.");
        return;
      }
      await this.#loadSession(sessions[0].id);
    } catch (error) {
      this.#showError(error);
    }
  }

  destroy(): void {
    this.#abort.abort();
    this.#root.replaceChildren();
  }

  #listen(): void {
    const signal = this.#abort.signal;
    this.#query<HTMLSelectElement>("[data-sessions]").addEventListener(
      "change",
      (event) =>
        void this.#loadSession(
          (event.currentTarget as HTMLSelectElement).value,
        ),
      { signal },
    );
    this.#query<HTMLSelectElement>("[data-branches]").addEventListener(
      "change",
      (event) =>
        void this.#loadBranch((event.currentTarget as HTMLSelectElement).value),
      { signal },
    );
    this.#query<HTMLInputElement>("[data-scrubber]").addEventListener(
      "input",
      (event) => {
        const selected = nearestEvent(
          this.#events,
          Number((event.currentTarget as HTMLInputElement).value),
        );
        if (selected !== undefined) void this.#selectEvent(selected);
      },
      { signal },
    );
    this.#query<HTMLFormElement>("[data-branch-form]").addEventListener(
      "submit",
      (event) => void this.#createBranch(event),
      { signal },
    );
  }

  async #loadSession(sessionId: string): Promise<void> {
    this.#setStatus("Resolving branch lineage…");
    try {
      this.#session = await this.#api.getSession(sessionId);
      this.#subscribeStream(sessionId);
      const branches = this.#session.branches;
      const select = this.#query<HTMLSelectElement>("[data-branches]");
      select.replaceChildren(
        ...branches.map((branch) =>
          option(
            branch.id,
            `${branch.parentId === undefined ? "root" : "fork"} · ${shortId(branch.id)}`,
          ),
        ),
      );
      const ready = branches.find((branch) => branch.state === "ready");
      if (ready === undefined) {
        this.#setStatus("This session has no ready branches.");
        return;
      }
      select.value = ready.id;
      await this.#loadBranch(ready.id);
    } catch (error) {
      this.#showError(error);
    }
  }

  /**
   * Follow one session's live stream for as long as it stays selected.
   *
   * Switching sessions (or destroying the app) replaces or drops the
   * subscription; nothing here ever holds a stream open past its session's
   * relevance, and a dropped connection reconnects on its own.
   */
  #subscribeStream(sessionId: string): void {
    this.#streamAbort?.abort();
    if (this.#abort.signal.aborted) return;
    const controller = new AbortController();
    this.#streamAbort = controller;
    this.#abort.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
    this.#api.openStream(
      sessionId,
      {
        onAppended: (notice) => void this.#handleAppended(notice),
        onStateChange: (state) => this.#setConnectionState(state),
      },
      controller.signal,
    );
  }

  /**
   * Fetch only what a broadcast says is new and append it, in place.
   *
   * A live refresh never moves the scrubber or the selected event: a user
   * mid-review of an older record must not be yanked to the tip just because
   * new history landed behind them.
   */
  async #handleAppended(notice: StreamNotice): Promise<void> {
    if (this.#branchId === undefined || notice.branchId !== this.#branchId) {
      return;
    }
    const branchId = this.#branchId;
    const fromSeq = (this.#events.at(-1)?.seq ?? 0) + 1;
    try {
      const fresh = await this.#api.getTimelineSince(branchId, fromSeq);
      if (fresh.length === 0 || this.#branchId !== branchId) return;
      this.#events = Object.freeze([...this.#events, ...fresh]);
      this.#renderTimeline();
      const scrubber = this.#query<HTMLInputElement>("[data-scrubber]");
      scrubber.max = String(this.#events.at(-1)?.seq ?? 1);
      scrubber.disabled = this.#events.length === 0;
    } catch (error) {
      this.#showError(error);
    }
  }

  #setConnectionState(state: StreamConnectionState): void {
    const badge = this.#query<HTMLElement>("[data-connection]");
    badge.dataset["state"] = state;
    badge.textContent =
      state === "open"
        ? "LIVE"
        : state === "connecting"
          ? "CONNECTING"
          : state === "reconnecting"
            ? "RECONNECTING"
            : "OFFLINE";
  }

  async #loadBranch(branchId: string): Promise<void> {
    this.#branchId = branchId;
    this.#setStatus("Materializing visible history…");
    try {
      this.#events = await this.#api.getTimeline(branchId);
      this.#renderTimeline();
      const scrubber = this.#query<HTMLInputElement>("[data-scrubber]");
      scrubber.min = String(this.#events[0]?.seq ?? 1);
      scrubber.max = String(this.#events.at(-1)?.seq ?? 1);
      scrubber.disabled = this.#events.length === 0;
      const last = this.#events.at(-1);
      if (last !== undefined) {
        scrubber.value = String(last.seq);
        await this.#selectEvent(last);
      } else {
        this.#setStatus("This branch has no recorded events.");
      }
    } catch (error) {
      this.#showError(error);
    }
  }

  #renderTimeline(): void {
    const timeline = this.#query<HTMLElement>("[data-timeline]");
    const bounded = boundRenderedRows(this.#events);
    timeline.replaceChildren(
      ...(bounded.hiddenCount === 0 ? [] : [this.#hiddenRowsNotice(bounded)]),
      ...bounded.visible.map((event) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `event event--${eventTone(event.kind)}`;
        button.dataset["eventId"] = event.id;
        button.innerHTML = `<span class="event__seq"></span><span class="event__body"><span class="event__kind"></span><span class="event__summary"></span></span>`;
        button.querySelector<HTMLElement>(".event__seq")!.textContent = String(
          event.seq,
        ).padStart(3, "0");
        button.querySelector<HTMLElement>(".event__kind")!.textContent =
          event.kind.replaceAll("_", " ");
        button.querySelector<HTMLElement>(".event__summary")!.textContent =
          event.summary;
        button.classList.toggle(
          "is-selected",
          this.#selected !== undefined && event.id === this.#selected.id,
        );
        button.addEventListener("click", () => void this.#selectEvent(event), {
          signal: this.#abort.signal,
        });
        return button;
      }),
    );
    this.#query<HTMLElement>("[data-event-count]").textContent =
      `${String(this.#events.length)} EVENTS`;
  }

  #hiddenRowsNotice(
    bounded: ReturnType<typeof boundRenderedRows<TimelineEvent>>,
  ): HTMLElement {
    const notice = document.createElement("div");
    notice.className = "timeline-truncated";
    notice.textContent = `⋯ ${String(bounded.hiddenCount)} earlier event${bounded.hiddenCount === 1 ? "" : "s"} not rendered · scrub to reach them`;
    return notice;
  }

  async #selectEvent(event: TimelineEvent): Promise<void> {
    this.#selected = event;
    for (const item of this.#root.querySelectorAll(".event")) {
      item.classList.toggle(
        "is-selected",
        (item as HTMLElement).dataset["eventId"] === event.id,
      );
    }
    this.#query<HTMLInputElement>("[data-scrubber]").value = String(event.seq);
    this.#query<HTMLElement>("[data-coordinate]").textContent =
      `T+${String(event.seq).padStart(3, "0")}`;
    this.#query<HTMLElement>("[data-detail-title]").textContent = event.summary;
    this.#setStatus("Inspecting canonical record…");
    try {
      const [detail, capabilities] = await Promise.all([
        this.#api.getEvent(event.id),
        this.#api.getCapabilities(event.branchId, event.seq),
      ]);
      this.#query<HTMLElement>("[data-payload]").textContent = JSON.stringify(
        detail.payload,
        null,
        2,
      );
      this.#renderCapabilities(capabilities);
      this.#setStatus(
        `Stopped at event ${String(event.seq)} · ${event.kind.replaceAll("_", " ")}`,
      );
    } catch (error) {
      this.#showError(error);
    }
  }

  #renderCapabilities(capabilities: EventCapabilities): void {
    const replay = this.#query<HTMLElement>("[data-replayability]");
    replay.textContent =
      capabilities.replayability.status === "replayable"
        ? "REPLAYABLE"
        : capabilities.replayability.reason.replaceAll("_", " ");
    replay.dataset["state"] = capabilities.replayability.status;
    const branch = this.#query<HTMLElement>("[data-branchability]");
    const isReady = capabilities.branchability.status === "branchable";
    branch.textContent = isReady
      ? `RESTORE @ ${String(capabilities.branchability.reconstruction.effectiveRestoreSeq)}`
      : capabilities.branchability.reason.replaceAll("_", " ");
    branch.dataset["state"] = isReady ? "branchable" : "unavailable";
    const submit = this.#query<HTMLButtonElement>("[data-branch-submit]");
    submit.disabled = !isReady;
    submit.title = isReady
      ? "Create an isolated child branch"
      : "This event has no reconstructable workspace state";
  }

  async #createBranch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (
      this.#session === undefined ||
      this.#branchId === undefined ||
      this.#selected === undefined
    )
      return;
    const instruction =
      this.#query<HTMLTextAreaElement>("[data-instruction]").value.trim();
    if (instruction.length === 0) return;
    const submit = this.#query<HTMLButtonElement>("[data-branch-submit]");
    submit.disabled = true;
    this.#setStatus("Reconstructing an isolated workspace…");
    try {
      const result = await this.#api.createBranch(this.#session.session.id, {
        parentBranchId: this.#branchId,
        forkSeq: this.#selected.seq,
        instruction,
      });
      this.#query<HTMLElement>("[data-branch-result]").textContent =
        `Branch ${shortId(result.branch.id)} ready · workspace reconstructed`;
      this.#query<HTMLTextAreaElement>("[data-instruction]").value = "";
      this.#setStatus(
        "Branch created. Launch remains a separate explicit action.",
      );
    } catch (error) {
      this.#showError(error);
      submit.disabled = false;
    }
  }

  #setStatus(message: string): void {
    this.#query<HTMLElement>("[data-status]").textContent = message;
  }

  #showError(error: unknown): void {
    this.#setStatus(
      error instanceof Error
        ? error.message
        : "Chronos could not complete that request",
    );
  }

  #query<ElementType extends Element>(selector: string): ElementType {
    const match = this.#root.querySelector<ElementType>(selector);
    if (match === null) throw new Error(`Chronos UI is missing ${selector}`);
    return match;
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 7)}…`;
}

function readErrorMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  stylesInjected = true;
}

const shellMarkup = `
  <main class="chronos-shell">
    <header class="masthead">
      <div><span class="eyebrow">SESSION INSTRUMENT / LOCAL</span><h1>CHR<span>O</span>NOS</h1></div>
      <div class="status-block">
        <p class="status" data-status aria-live="polite">Initializing…</p>
        <span class="conn" data-connection role="status" aria-live="polite">OFFLINE</span>
      </div>
      <div class="coordinate" data-coordinate>T+000</div>
    </header>
    <section class="controls" aria-label="Timeline controls">
      <label>SESSION<select data-sessions aria-label="Session"></select></label>
      <label>BRANCH<select data-branches aria-label="Branch"></select></label>
      <label class="scrub">TEMPORAL POSITION<input data-scrubber type="range" min="1" max="1" value="1" disabled></label>
      <span class="event-count" data-event-count>0 EVENTS</span>
    </section>
    <div class="workspace">
      <section class="timeline-panel"><div class="rail-label">VISIBLE HISTORY</div><div class="timeline" data-timeline></div></section>
      <aside class="inspector">
        <span class="eyebrow">SELECTED RECORD</span><h2 data-detail-title>No event selected</h2>
        <div class="capabilities"><span data-replayability>UNKNOWN</span><span data-branchability>NO CHECKPOINT</span></div>
        <pre data-payload>{}</pre>
        <form class="branch-form" data-branch-form>
          <label>NEW INSTRUCTION<textarea data-instruction rows="4" placeholder="Branch from this moment…" required></textarea></label>
          <button data-branch-submit disabled>RECONSTRUCT + BRANCH <span>↗</span></button>
          <p data-branch-result>Branching never replays recorded tool calls.</p>
        </form>
      </aside>
    </div>
  </main>`;

const styles = `
  :root { color-scheme: dark; --ink:#080907; --paper:#e7e1d3; --acid:#d7ff35; --rust:#ff6b3d; --dim:#77796f; --line:#292b25; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ink); color:var(--paper); }
  .chronos-root { min-height:100vh; background:radial-gradient(circle at 74% -10%, #22271a 0, transparent 38%), repeating-linear-gradient(90deg, transparent 0 79px, rgba(255,255,255,.025) 80px), var(--ink); font-family:"Aptos Narrow","Franklin Gothic Medium",sans-serif; }
  .chronos-shell { min-height:100vh; padding:28px clamp(18px,4vw,64px) 48px; }
  .masthead { display:grid; grid-template-columns:1fr minmax(240px,440px) auto; gap:28px; align-items:end; border-bottom:1px solid var(--paper); padding-bottom:18px; }
  .eyebrow,.rail-label,label,.event__kind,.event-count { font:700 10px/1.2 "Cascadia Mono","Lucida Console",monospace; letter-spacing:.14em; }
  h1 { margin:5px 0 -8px; font:400 clamp(54px,9vw,116px)/.8 Georgia,serif; letter-spacing:-.09em; } h1 span { color:var(--acid); font-style:italic; }
  .status-block { display:grid; gap:8px; align-content:end; }
  .status { color:#b5b5aa; margin:0; max-width:42ch; font:14px/1.45 Georgia,serif; }
  .conn { justify-self:start; border:1px solid var(--line); padding:4px 8px; color:var(--dim); font:700 9px "Cascadia Mono",monospace; letter-spacing:.12em; }
  .conn[data-state=open] { color:var(--acid); border-color:#657520; }
  .conn[data-state=connecting],.conn[data-state=reconnecting] { color:var(--rust); border-color:#8a4126; }
  .coordinate { color:var(--acid); font:700 clamp(25px,4vw,52px)/1 "Cascadia Mono",monospace; letter-spacing:-.06em; }
  .controls { min-height:76px; display:grid; grid-template-columns:minmax(150px,220px) minmax(150px,220px) 1fr auto; gap:22px; align-items:center; border-bottom:1px solid var(--line); }
  label { color:var(--dim); display:grid; gap:7px; }
  select,textarea { width:100%; border:0; border-bottom:1px solid #464940; background:transparent; color:var(--paper); padding:4px 0 8px; font:15px Georgia,serif; } option { background:#11130f; }
  input[type=range] { accent-color:var(--acid); width:100%; }
  .workspace { display:grid; grid-template-columns:minmax(360px,1.5fr) minmax(300px,.8fr); min-height:620px; }
  .timeline-panel { display:grid; grid-template-columns:44px 1fr; border-right:1px solid var(--line); padding:30px 34px 0 0; }
  .rail-label { color:var(--dim); writing-mode:vertical-rl; transform:rotate(180deg); }
  .timeline { position:relative; display:grid; align-content:start; gap:2px; padding-left:27px; max-height:68vh; overflow:auto; }
  .timeline::before { content:""; position:absolute; left:5px; top:10px; bottom:10px; width:1px; background:var(--line); }
  .timeline-truncated { color:var(--dim); font:11px/1.4 "Cascadia Mono",monospace; padding:10px 12px; border-bottom:1px solid #1d1f1a; }
  .event { --tone:var(--dim); position:relative; display:grid; grid-template-columns:52px 1fr; gap:18px; text-align:left; color:inherit; background:transparent; border:0; border-bottom:1px solid #1d1f1a; padding:15px 12px; cursor:pointer; transition:background .18s ease, transform .18s ease; }
  .event::before { content:""; position:absolute; left:-26px; top:23px; width:9px; height:9px; border:1px solid var(--tone); border-radius:50%; background:var(--ink); }
  .event:hover { background:#151711; transform:translateX(4px); }.event.is-selected { background:var(--paper); color:var(--ink); }.event.is-selected::before { background:var(--acid); box-shadow:0 0 0 5px rgba(215,255,53,.16); }
  .event--human { --tone:var(--acid); }.event--agent { --tone:#f2efe5; }.event--fault { --tone:var(--rust); }
  .event__seq { color:var(--tone); font:700 13px "Cascadia Mono",monospace; }.is-selected .event__seq { color:#4c530d; }
  .event__body { display:grid; gap:5px; }.event__kind { color:var(--tone); }.is-selected .event__kind { color:#4c530d; }.event__summary { font:16px/1.3 Georgia,serif; }
  .inspector { padding:34px 0 0 38px; position:sticky; top:0; align-self:start; }
  .inspector h2 { margin:10px 0 20px; font:italic 32px/1.05 Georgia,serif; max-width:15ch; }
  .capabilities { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }.capabilities span { border:1px solid var(--line); padding:7px 9px; color:var(--dim); font:700 9px "Cascadia Mono",monospace; letter-spacing:.08em; }.capabilities [data-state=branchable],.capabilities [data-state=replayable] { color:var(--acid); border-color:#657520; }
  pre { min-height:160px; max-height:240px; overflow:auto; border:1px solid var(--line); background:#050604; color:#aaa99f; padding:15px; white-space:pre-wrap; font:11px/1.55 "Cascadia Mono",monospace; }
  .branch-form { margin-top:28px; border-top:1px solid var(--paper); padding-top:22px; }.branch-form textarea { resize:vertical; line-height:1.45; }
  .branch-form button { width:100%; margin-top:14px; display:flex; justify-content:space-between; border:0; background:var(--acid); color:var(--ink); padding:15px 16px; font:800 11px "Cascadia Mono",monospace; letter-spacing:.1em; cursor:pointer; }.branch-form button:disabled { background:#25271f; color:#686a60; cursor:not-allowed; }.branch-form p { color:var(--dim); font:11px/1.4 Georgia,serif; }
  @media (max-width:860px) { .masthead { grid-template-columns:1fr auto; }.status-block { grid-column:1/-1; grid-row:2; }.controls { grid-template-columns:1fr 1fr; padding:14px 0; }.scrub { grid-column:1/-1; }.workspace { grid-template-columns:1fr; }.timeline-panel { border-right:0; padding-right:0; }.inspector { padding-left:44px; }.timeline { max-height:55vh; } }
  @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition:none!important; } }
`;
