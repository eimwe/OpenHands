/**
 * Browser-side LLM client for the mock chat simulator. Talks to any
 * OpenAI-compatible `/chat/completions` endpoint (Mistral by default) and
 * streams the reply.
 *
 * Effective settings, highest priority first:
 *   1. values saved from the ⚙ LLM panel (localStorage)
 *   2. `.env`: VITE_LLM_BASE_URL, VITE_LLM_MODEL
 *   3. built-in fallbacks in `llm-defaults.ts`
 *
 * The API key is never taken from a `VITE_` variable: by default it stays on
 * the dev server (MOCK_LLM_API_KEY in `.env`) and is attached by the
 * `/llm-proxy` route in vite.config.ts. A key typed into the panel is sent
 * straight from the browser instead. Demo only.
 */
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LLM_PROXY_PATH,
} from "./llm-defaults";

export interface LlmConfig {
  /** Full provider URL up to (not including) `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const LLM_CONFIG_STORAGE_KEY = "oh-mock-llm";

const fromEnv = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/** Defaults the panel can override: the `.env` value, else the built-in one. */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: normalizeUrl(
    fromEnv(import.meta.env.VITE_LLM_BASE_URL) || DEFAULT_LLM_BASE_URL,
  ),
  apiKey: "",
  model: fromEnv(import.meta.env.VITE_LLM_MODEL) || DEFAULT_LLM_MODEL,
};

/**
 * What the panel has saved. An empty/missing field means "not overridden", so
 * a later change to `.env` still takes effect for that field.
 */
function readOverrides(): Partial<LlmConfig> {
  try {
    const raw = window.localStorage.getItem(LLM_CONFIG_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<LlmConfig>) : {};
  } catch {
    return {};
  }
}

/** The base URL must be a full URL; short paths like "/mistral/v1" are not. */
export const isFullUrl = (value: string): boolean =>
  /^https?:\/\/\S+$/i.test(value.trim());

export function readLlmConfig(): LlmConfig {
  const overrides = readOverrides();
  // Ignore a saved URL that isn't a full URL (e.g. one saved by an older
  // version of this demo) instead of calling a route that no longer exists.
  const savedBaseUrl = overrides.baseUrl?.trim() ?? "";
  return {
    baseUrl: normalizeUrl(
      isFullUrl(savedBaseUrl) ? savedBaseUrl : DEFAULT_LLM_CONFIG.baseUrl,
    ),
    apiKey: overrides.apiKey?.trim() ?? "",
    model: overrides.model?.trim() || DEFAULT_LLM_CONFIG.model,
  };
}

/**
 * Saves the panel's values as overrides. Fields equal to the current default
 * are stored empty, so they keep following `.env` instead of freezing today's
 * value.
 */
export function saveLlmConfig(config: LlmConfig): void {
  const baseUrl = normalizeUrl(config.baseUrl);
  const model = config.model.trim();
  const overrides: LlmConfig = {
    baseUrl: baseUrl === DEFAULT_LLM_CONFIG.baseUrl ? "" : baseUrl,
    apiKey: config.apiKey.trim(),
    model: model === DEFAULT_LLM_CONFIG.model ? "" : model,
  };
  window.localStorage.setItem(
    LLM_CONFIG_STORAGE_KEY,
    JSON.stringify(overrides),
  );
}

export function clearLlmConfig(): void {
  window.localStorage.removeItem(LLM_CONFIG_STORAGE_KEY);
}

/**
 * The `.env` endpoint with no panel key goes through the dev-server proxy,
 * which adds MOCK_LLM_API_KEY and avoids CORS. Anything else (a different URL,
 * or a key typed into the panel) is called directly from the browser.
 */
function resolveEndpoint(config: LlmConfig): string {
  const useProxy =
    !config.apiKey && config.baseUrl === DEFAULT_LLM_CONFIG.baseUrl;
  return useProxy
    ? `${LLM_PROXY_PATH}/chat/completions`
    : `${config.baseUrl}/chat/completions`;
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
 * status and body).
 */
export async function streamChatCompletion(
  messages: LlmChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const config = readLlmConfig();
  const endpoint = resolveEndpoint(config);

  const request = () =>
    fetch(endpoint, {
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
    const hint =
      response.status === 401 || response.status === 403
        ? " — check MOCK_LLM_API_KEY in .env (restart the dev server) or the key in the LLM panel"
        : "";
    throw new Error(`LLM request failed (${response.status})${hint}: ${body}`);
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
