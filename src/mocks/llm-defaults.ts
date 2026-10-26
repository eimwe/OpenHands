/**
 * Built-in fallbacks for the mock-mode LLM bridge. Pure constants with no
 * browser APIs, so both the browser code (`llm-bridge.ts`) and `vite.config.ts`
 * can import them and stay in sync.
 *
 * Effective value, highest priority first:
 *   1. the ⚙ LLM panel (saved in localStorage)
 *   2. `.env`: VITE_LLM_BASE_URL / VITE_LLM_MODEL
 *   3. these constants
 */

/** Full provider URL, up to (not including) `/chat/completions`. */
export const DEFAULT_LLM_BASE_URL = "https://api.mistral.ai/v1";

export const DEFAULT_LLM_MODEL = "ministral-3b-2512";

/** Dev-server route that forwards to the `.env` base URL and adds the key. */
export const LLM_PROXY_PATH = "/llm-proxy";
