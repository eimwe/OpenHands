import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
import { CHAT_SIM_HANDLERS, CHAT_SIM_WS_HANDLERS } from "./chat-sim-handlers";
import { installLlmConfigPanel } from "./llm-config-panel";
import { seedMockLlmProfileForDemo } from "./settings-handlers";

seedMockLlmProfileForDemo();

// The chat simulator is browser-only (it needs WebSocket + localStorage), so it
// is added here rather than to `handlers`, which the Vitest node server shares.
// It goes first so it wins for the conversations it owns and falls through for
// everything else.
export const worker = setupWorker(
  ...CHAT_SIM_HANDLERS,
  ...CHAT_SIM_WS_HANDLERS,
  ...handlers,
);

installLlmConfigPanel();
