/**
 * Minimal LLM settings for the mock-mode demo: a floating "LLM" button that
 * opens a three-field form (base URL, API key, model). Saved values override
 * the `.env` / built-in defaults (see `llm-bridge.ts`); "Reset" drops the
 * overrides. Plain DOM on purpose — it must not depend on the app's React tree
 * or backend settings.
 */
import {
  clearLlmConfig,
  DEFAULT_LLM_CONFIG,
  isFullUrl,
  readLlmConfig,
  saveLlmConfig,
} from "./llm-bridge";

const ROOT_ID = "oh-mock-llm-panel";

interface FieldOptions {
  value: string;
  placeholder: string;
  hint?: string;
  type?: string;
  autocomplete?: AutoFill;
}

/** Builds a labelled input (with an optional hint) and returns its parts. */
function createField(
  label: string,
  options: FieldOptions,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement("input");
  input.value = options.value;
  input.placeholder = options.placeholder;
  if (options.type) input.type = options.type;
  if (options.autocomplete) input.autocomplete = options.autocomplete;
  input.style.cssText =
    "padding:6px 8px;border-radius:6px;border:1px solid #444;background:#111;color:#eee;font-size:13px";

  const wrap = document.createElement("label");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:4px;font-size:12px;color:#aaa";
  wrap.textContent = label;
  wrap.appendChild(input);

  if (options.hint) {
    const hint = document.createElement("span");
    hint.textContent = options.hint;
    hint.style.cssText = "font-size:11px;color:#777;word-break:break-all";
    wrap.appendChild(hint);
  }
  return { wrap, input };
}

function buildPanel(): HTMLElement {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText =
    "position:fixed;left:12px;bottom:12px;z-index:2147483647;font-family:system-ui,sans-serif";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "⚙ LLM";
  button.style.cssText =
    "padding:6px 12px;border-radius:999px;border:1px solid #555;background:#222;color:#eee;cursor:pointer;font-size:12px";

  const form = document.createElement("div");
  form.style.cssText =
    "display:none;flex-direction:column;gap:10px;width:300px;margin-bottom:8px;padding:12px;border-radius:10px;border:1px solid #444;background:#1c1c1c;box-shadow:0 8px 24px rgba(0,0,0,.5)";

  const config = readLlmConfig();
  const baseUrl = createField("Base URL (full provider URL)", {
    value: config.baseUrl,
    placeholder: DEFAULT_LLM_CONFIG.baseUrl,
    hint: `Default (.env or built-in): ${DEFAULT_LLM_CONFIG.baseUrl}`,
  });
  const apiKey = createField("API key (optional)", {
    value: config.apiKey,
    placeholder: "empty = MOCK_LLM_API_KEY from .env",
    hint: "Sent straight from this browser. Leave empty to use the key kept on the dev server.",
    type: "password",
    autocomplete: "off",
  });
  const model = createField("Model", {
    value: config.model,
    placeholder: DEFAULT_LLM_CONFIG.model,
    hint: `Default (.env or built-in): ${DEFAULT_LLM_CONFIG.model}`,
  });

  const status = document.createElement("div");
  status.style.cssText = "font-size:12px;color:#8bc48b;min-height:14px";

  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px";

  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.style.cssText =
    "padding:6px 10px;border-radius:6px;border:0;background:#c9b974;color:#111;cursor:pointer;font-weight:600";
  save.onclick = () => {
    if (baseUrl.input.value && !isFullUrl(baseUrl.input.value)) {
      status.textContent =
        "Base URL must be a full URL, e.g. https://api.mistral.ai/v1";
      return;
    }
    saveLlmConfig({
      baseUrl: baseUrl.input.value || DEFAULT_LLM_CONFIG.baseUrl,
      apiKey: apiKey.input.value,
      model: model.input.value || DEFAULT_LLM_CONFIG.model,
    });
    status.textContent = "Saved. Applies to the next message.";
  };

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset to defaults";
  reset.style.cssText =
    "padding:6px 10px;border-radius:6px;border:1px solid #555;background:transparent;color:#ccc;cursor:pointer";
  reset.onclick = () => {
    clearLlmConfig();
    baseUrl.input.value = DEFAULT_LLM_CONFIG.baseUrl;
    apiKey.input.value = "";
    model.input.value = DEFAULT_LLM_CONFIG.model;
    status.textContent = "Overrides cleared.";
  };

  buttons.append(save, reset);
  form.append(baseUrl.wrap, apiKey.wrap, model.wrap, buttons, status);

  button.onclick = () => {
    form.style.display = form.style.display === "none" ? "flex" : "none";
  };

  root.append(form, button);
  return root;
}

/**
 * Mounts the panel after React has hydrated `document`, so hydration never sees
 * (and discards) the foreign node.
 */
export function installLlmConfigPanel(): void {
  if (typeof document === "undefined") return;
  const mount = () => {
    if (document.getElementById(ROOT_ID)) return;
    document.body.appendChild(buildPanel());
  };
  window.setTimeout(mount, 1500);
}
