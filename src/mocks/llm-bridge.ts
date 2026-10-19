/**
 * Browser-side LLM client for the mock chat simulator. Talks to any
 * OpenAI-compatible `/chat/completions` endpoint (Mistral by default) and
 * streams the reply. Settings live in localStorage and are edited through the
 * small panel in `llm-config-panel.ts`.
 *
 * Demo only: the API key is stored in the browser and sent from the browser.
 */

export interface LlmConfig {
  /** Base URL up to (not including) `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const LLM_CONFIG_STORAGE_KEY = "oh-mock-llm";

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  // Same-origin path handled by the Vite dev-server proxy (vite.config.ts),
  // which adds the key from MISTRAL_API_KEY in .env. Set a full URL such as
  // https://api.mistral.ai/v1 plus a key in the panel to call the API directly.
  baseUrl: "/mistral/v1",
  apiKey: "",
  model: "ministral-3b-2512",
};

export function readLlmConfig(): LlmConfig {
  try {
    const raw = window.localStorage.getItem(LLM_CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return {
      baseUrl: parsed.baseUrl?.trim() || DEFAULT_LLM_CONFIG.baseUrl,
      apiKey: parsed.apiKey?.trim() ?? "",
      model: parsed.model?.trim() || DEFAULT_LLM_CONFIG.model,
    };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

export function writeLlmConfig(config: LlmConfig): void {
  window.localStorage.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

/** Mistral may return `content` as a string or as an array of text chunks. */
function deltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : ((part as { text?: string }).text ?? ""),
      )
      .join("");
  }
  return "";
}

/**
 * Streams a chat completion. Calls `onDelta` for every text increment and
 * resolves with the full text. Throws on HTTP errors (message includes the
 * status and body) and on a missing API key.
 */
export async function streamChatCompletion(
  messages: LlmChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const config = readLlmConfig();
  // A relative base URL means the dev-server proxy supplies the key.
  const viaProxy = config.baseUrl.startsWith("/");
  if (!viaProxy && !config.apiKey) {
    throw new Error(
      'No LLM API key set. Add MISTRAL_API_KEY to .env (and restart), or click the "LLM" button (bottom-left) and enter a key.',
    );
  }

  const request = () =>
    fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
      }),
      signal,
    });

  // The free Mistral tier rate-limits aggressively (HTTP 429). Retry a few
  // times, honouring Retry-After when present, before surfacing the error.
  let response = await request();
  for (let attempt = 1; attempt <= 3 && response.status === 429; attempt += 1) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * attempt;

    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });

    response = await request();
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  // SSE: lines of `data: {json}` terminated by `data: [DONE]`.

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") return full;
        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: unknown } }[];
          };
          const text = deltaText(chunk.choices?.[0]?.delta?.content);
          if (text) {
            full += text;
            onDelta(text);
          }
        } catch {
          /* ignore keep-alives / partial lines */
        }
      }
    }
  }
  return full;
}
