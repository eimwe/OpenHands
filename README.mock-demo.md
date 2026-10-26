# Mock chat demo (frontend only)

The agent-server is faked in the browser; chat goes to an OpenAI-compatible LLM (Mistral by default). Chats are stored in the browser's `localStorage`. Needs Node 24+.

## Dev server

```bash
npm install
```

Add to `.env` (restart the server after any change):

```bash
VITE_LLM_BASE_URL="https://api.mistral.ai/v1"  # optional, full provider URL
VITE_LLM_MODEL="ministral-3b-2512"             # optional
MOCK_LLM_API_KEY="<your key>"                  # stays on the dev server, never sent to the browser
```

```bash
npm run dev:mock   # http://localhost:3001
```

First run: on "Add a backend" choose **Agent-server → Local**, Host `http://127.0.0.1:3001`, any API key, then **Connect**.

## Static build

```bash
npm ci
```

Add to `.env`:

```bash
VITE_LLM_BASE_URL="https://api.mistral.ai/v1"
VITE_LLM_MODEL="ministral-3b-2512"
```

```bash
npm run build:mock
npx sirv-cli build/ --single   # or any static host that falls back to index.html
```

- Serve over **HTTPS** (or localhost); the mock API needs a service worker.
- There is no proxy in a static build, so each user must open **⚙ LLM** (bottom-left), paste their API key and **Save** once.
- Serving from a subpath: set `VITE_BASE_PATH` before building.

## ⚙ LLM panel

Saved values override `.env`, which overrides the built-in defaults. **Reset to defaults** clears the overrides. The base URL must be a full URL.
