/**
 * In-browser chat simulator ("fake agent-server") for the frontend-only demo.
 *
 * It replaces just enough of the agent-server contract for the chat UI and the
 * existing "Branch from here" feature to work with NO backend:
 *
 *   - an event TREE per conversation (each event has `parent_id`; the active
 *     branch is `path_to_root(leaf)`), mirroring the real server's model
 *   - POST /api/conversations                      create (+ optional first message)
 *   - POST /api/conversations/:id/events           user message -> LLM turn
 *   - GET  /api/conversations/:id/events/search    active branch history
 *   - GET  /api/conversations/:id/events/:eventId  single event (with parent_id)
 *   - POST /api/conversations/:id/fork             `from_event_id` copies history
 *   - WS   /sockets/session/:id                    live frames (durable/delta/…)
 *
 * The "agent" is a plain chat LLM reached from the browser (see llm-bridge.ts).
 * Conversations that are NOT created here (the static fixtures) fall through to
 * the other mock handlers untouched.
 */
import { http, HttpResponse, ws } from "msw";
import {
  getMockConversation,
  patchMockConversation,
  registerMockConversation,
  type MockConversation,
} from "./conversation-handlers";
import { streamChatCompletion, type LlmChatMessage } from "./llm-bridge";

// ---------------------------------------------------------------------------
// Event tree store
// ---------------------------------------------------------------------------

interface SimEvent {
  id: string;
  parent_id: string | null;
  timestamp: string;
  source: "user" | "agent";
  kind: "MessageEvent";
  llm_message: {
    role: "user" | "assistant";
    content: { type: "text"; text: string }[];
  };
  activated_skills: string[];
  extended_content: never[];
}

interface SimConversation {
  /** Append-only log of every event ever added (all branches). */
  events: SimEvent[];
  /** Active HEAD; `path_to_root(leaf)` is what the chat shows. */
  leaf: string | null;
}

const STORAGE_KEY = "oh-mock-chat-sim-v1";
const SYSTEM_PROMPT =
  "You are a helpful assistant in a demo of conversation branching. Answer concisely.";

const sims = new Map<string, SimConversation>();

let lastTimestamp = 0;
function nowIso(): string {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp).toISOString();
}

function pathToRoot(sim: SimConversation, eventId: string | null): SimEvent[] {
  const byId = new Map(sim.events.map((event) => [event.id, event]));
  const path: SimEvent[] = [];
  let current = eventId ? byId.get(eventId) : undefined;
  while (current) {
    path.push(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path.reverse();
}

function persist(): void {
  try {
    const conversations: Record<string, SimConversation> = {};
    const infos: MockConversation[] = [];
    sims.forEach((sim, id) => {
      conversations[id] = sim;
      const info = getMockConversation(id);
      if (info) infos.push({ ...info, execution_status: "idle" });
    });
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ conversations, infos }),
    );
  } catch {
    /* quota / serialization — demo state just won't survive a reload */
  }
}

function restore(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      conversations?: Record<string, SimConversation>;
      infos?: MockConversation[];
    };
    Object.entries(parsed.conversations ?? {}).forEach(([id, sim]) => {
      sims.set(id, sim);
      sim.events.forEach((event) => {
        lastTimestamp = Math.max(lastTimestamp, Date.parse(event.timestamp));
      });
    });
    (parsed.infos ?? []).forEach((info) => registerMockConversation(info));
  } catch {
    /* corrupt state — start fresh */
  }
}
restore();

function createEvent(
  sim: SimConversation,
  source: "user" | "agent",
  text: string,
  id: string = crypto.randomUUID(),
): SimEvent {
  const event: SimEvent = {
    id,
    parent_id: sim.leaf,
    timestamp: nowIso(),
    source,
    kind: "MessageEvent",
    llm_message: {
      role: source === "user" ? "user" : "assistant",
      content: [{ type: "text", text }],
    },
    activated_skills: [],
    extended_content: [],
  };
  sim.events.push(event);
  // The simulator's store is deliberately mutable: `sim` is the live record in
  // `sims`, and HEAD must advance in place.
  // eslint-disable-next-line no-param-reassign
  sim.leaf = event.id;
  return event;
}

/** The real server omits `parent_id` from search results; mimic that. */
function withoutParent(event: SimEvent): Omit<SimEvent, "parent_id"> {
  const { parent_id: _parent, ...rest } = event;
  return rest;
}

function eventText(event: SimEvent): string {
  return event.llm_message.content.map((part) => part.text).join("");
}

// ---------------------------------------------------------------------------
// Live sockets
// ---------------------------------------------------------------------------

type SocketClient = { send: (data: string) => void };
const clients = new Map<string, Set<SocketClient>>();

function broadcast(conversationId: string, frame: unknown): void {
  const payload = JSON.stringify(frame);
  clients.get(conversationId)?.forEach((client) => {
    try {
      client.send(payload);
    } catch {
      /* socket already closed */
    }
  });
}

function broadcastDurable(
  conversationId: string,
  sim: SimConversation,
  event: SimEvent,
): void {
  broadcast(conversationId, {
    type: "durable",
    seq: sim.events.indexOf(event),
    event: withoutParent(event),
  });
}

function broadcastStatus(conversationId: string, status: string): void {
  broadcast(conversationId, {
    type: "transient",
    event: {
      id: crypto.randomUUID(),
      timestamp: nowIso(),
      source: "environment",
      kind: "ConversationStateUpdateEvent",
      key: "execution_status",
      value: status,
    },
  });
  patchMockConversation(conversationId, {
    execution_status: status as MockConversation["execution_status"],
    updated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// One agent turn: history of the ACTIVE BRANCH -> LLM -> streamed reply
// ---------------------------------------------------------------------------

const running = new Set<string>();

async function runTurn(conversationId: string): Promise<void> {
  const sim = sims.get(conversationId);
  if (!sim || running.has(conversationId)) return;
  running.add(conversationId);
  broadcastStatus(conversationId, "running");

  const itemId = crypto.randomUUID();
  const messages: LlmChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...pathToRoot(sim, sim.leaf).map(
      (event): LlmChatMessage => ({
        role: event.source === "user" ? "user" : "assistant",
        content: eventText(event),
      }),
    ),
  ];

  try {
    broadcast(conversationId, { type: "item_started", item_id: itemId });
    let order = 0;
    const reply = await streamChatCompletion(messages, (text) => {
      broadcast(conversationId, {
        type: "delta",
        item_id: itemId,
        order: order++,
        kind: "text",
        content: text,
      });
    });

    // The durable event reuses the slot's id, which retires the streaming slot.
    const event = createEvent(sim, "agent", reply || "(empty reply)", itemId);
    persist();
    broadcastDurable(conversationId, sim, event);
  } catch (error) {
    broadcast(conversationId, {
      type: "item_aborted",
      item_id: itemId,
      reason: "error",
    });
    broadcast(conversationId, {
      type: "error",
      code: "llm_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running.delete(conversationId);
    broadcastStatus(conversationId, "idle");
  }
}

function submitUserMessage(conversationId: string, text: string): void {
  const sim = sims.get(conversationId);
  if (!sim) return;
  const event = createEvent(sim, "user", text);

  // Title a fresh conversation after its first message (forks keep their own).
  const info = getMockConversation(conversationId);
  if (info && (!info.title || info.title === "New Conversation")) {
    patchMockConversation(conversationId, {
      title: text.length > 48 ? `${text.slice(0, 48)}…` : text,
    });
  }

  persist();
  broadcastDurable(conversationId, sim, event);
  void runTurn(conversationId);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

function newConversationInfo(
  id: string,
  title: string,
  tags?: Record<string, string> | null,
): MockConversation {
  const timestamp = new Date().toISOString();
  return {
    id,
    title,
    created_at: timestamp,
    updated_at: timestamp,
    execution_status: "idle",
    workspace: { working_dir: "/workspace/project" },
    ...(tags ? { tags } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP handlers (listed BEFORE the static conversation handlers; for ids this
// simulator does not own they return nothing, so MSW falls through).
// ---------------------------------------------------------------------------

export const CHAT_SIM_HANDLERS = [
  http.post("*/api/conversations", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      conversation_id?: string | null;
      initial_message?: { content?: unknown } | null;
      tags?: Record<string, string> | null;
    } | null;

    const id = body?.conversation_id || crypto.randomUUID();
    sims.set(id, { events: [], leaf: null });
    const info = registerMockConversation(
      newConversationInfo(id, "New Conversation", body?.tags),
    );
    persist();

    const firstMessage = textFromContent(body?.initial_message?.content);
    if (firstMessage) {
      // Give the page a moment to open its socket before events start flowing.
      setTimeout(() => submitUserMessage(id, firstMessage), 400);
    }
    return HttpResponse.json(info, { status: 201 });
  }),

  http.get("*/api/conversations/:conversationId/events/count", ({ params }) => {
    const sim = sims.get(String(params.conversationId));
    if (!sim) return undefined;
    return HttpResponse.json(pathToRoot(sim, sim.leaf).length);
  }),

  http.get(
    "*/api/conversations/:conversationId/events/search",
    ({ params, request }) => {
      const sim = sims.get(String(params.conversationId));
      if (!sim) return undefined;

      const search = new URL(request.url).searchParams;
      const limit = Number(search.get("limit") ?? "100");
      const lt = search.get("timestamp__lt");
      const gte = search.get("timestamp__gte");

      let items = pathToRoot(sim, sim.leaf);
      if (lt) items = items.filter((event) => event.timestamp < lt);
      if (gte) items = items.filter((event) => event.timestamp >= gte);
      if (search.get("sort_order") === "TIMESTAMP_DESC") items.reverse();

      return HttpResponse.json({
        items: items.slice(0, limit).map(withoutParent),
        next_page_id: null,
      });
    },
  ),

  // Single event: includes `parent_id`, which "Branch from here" on a user
  // message (edit mode) needs to find the fork point.
  http.get(
    "*/api/conversations/:conversationId/events/:eventId",
    ({ params }) => {
      const sim = sims.get(String(params.conversationId));
      if (!sim) return undefined;
      const event = sim.events.find((e) => e.id === String(params.eventId));
      return event
        ? HttpResponse.json(event)
        : HttpResponse.json(null, { status: 404 });
    },
  ),

  http.post(
    "*/api/conversations/:conversationId/events",
    async ({ params, request }) => {
      const id = String(params.conversationId);
      if (!sims.has(id)) return undefined;
      const body = (await request.json().catch(() => ({}))) as {
        content?: unknown;
      } | null;
      const text = textFromContent(body?.content);
      if (text) submitUserMessage(id, text);
      return HttpResponse.json({ success: true });
    },
  ),

  http.post(
    "*/api/conversations/:conversationId/fork",
    async ({ params, request }) => {
      const sourceId = String(params.conversationId);
      const source = sims.get(sourceId);
      if (!source) return undefined;

      const body = (await request.json().catch(() => ({}))) as {
        id?: string | null;
        title?: string | null;
        tags?: Record<string, string> | null;
        from_event_id?: string | null;
      } | null;

      // Same contract as the real endpoint: copy only the branch up to and
      // including `from_event_id` and put HEAD there; no id = whole log.
      const fromId = body?.from_event_id ?? null;
      if (fromId && !source.events.some((event) => event.id === fromId)) {
        return HttpResponse.json(
          { detail: `Unknown from_event_id: ${fromId}` },
          { status: 404 },
        );
      }
      const copied = fromId
        ? pathToRoot(source, fromId)
        : pathToRoot(source, source.leaf);

      const forkId = body?.id || crypto.randomUUID();
      const fork: SimConversation = {
        events: copied.map((event) => ({ ...event })),
        leaf: copied.length ? copied[copied.length - 1].id : null,
      };
      sims.set(forkId, fork);

      const sourceTitle = getMockConversation(sourceId)?.title;
      const info = registerMockConversation(
        newConversationInfo(
          forkId,
          body?.title || (sourceTitle ? `${sourceTitle} (branch)` : "Branch"),
          body?.tags,
        ),
      );
      persist();

      // The UI checks `leaf_event_id` to know the cut point was honoured.
      return HttpResponse.json(
        { ...info, leaf_event_id: fork.leaf },
        { status: 201 },
      );
    },
  ),
];

// ---------------------------------------------------------------------------
// WebSocket: /sockets/session/:conversationId
// ---------------------------------------------------------------------------

const sessionSocket = ws.link("*/sockets/session/:conversationId");

export const CHAT_SIM_WS_HANDLERS = [
  sessionSocket.addEventListener("connection", ({ client, params }) => {
    const id = String(params.conversationId);
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id)!.add(client);
    client.addEventListener("close", () => clients.get(id)?.delete(client));

    // With an open socket the chat UI sends user messages HERE (as JSON
    // `{role, content, run}`), not via POST /events. The first frame it sends
    // is `{type: "auth", session_api_key}`, which we ignore.
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as {
          type?: string;
          content?: unknown;
        };
        if (message.type === "auth") return;
        const text = textFromContent(message.content);
        if (text) submitUserMessage(id, text);
      } catch {
        /* not JSON — ignore */
      }
    });

    // History is served over HTTP; the socket only carries live frames.
    client.send(
      JSON.stringify({ type: "sync", from_seq: null, through_seq: null }),
    );
  }),
];
