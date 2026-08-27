# pi-extensions

Personal [Pi](https://github.com/earendil-works/pi-mono) extensions shared across clients.

## Extensions

### `luna-fast`

Adds `service_tier: "priority"` to eligible ChatGPT-authenticated GPT-5.6 Luna requests.

```text
/luna-fast on
/luna-fast off
/luna-fast status
```

The machine-local setting remains in `~/.pi/agent/extensions/luna-fast.json` and is not stored in this repository.

### `notify`

Sends a native notification when Pi finishes an agent turn and waits for input.

```text
/notify-toggle [on|off|status]
/notify-test [message]
/notify-min [seconds|off|status]
```

Settings are stored in `~/.pi/agent/notify-settings.json`. The default is enabled with no minimum turn duration. Debug output is written to `~/.pi/agent/notify-debug.log`. macOS uses `terminal-notifier` when available and falls back to `osascript`; Windows uses a toast notification; Kitty and other terminals use terminal notification escape sequences.

### `ollama-auto-models`

Discovers models from a local Ollama server at startup, registers them as the `ollama` provider, and refreshes them with:

```text
/ollama-refresh
```

The server is read from `OLLAMA_BASE_URL` or `OLLAMA_HOST` and defaults to `http://localhost:11434`. The extension also supports these environment variables:

- `PI_OLLAMA_DISCOVERY_TIMEOUT_MS` — discovery timeout; default `1500`.
- `PI_OLLAMA_CONTEXT_WINDOW` — registered context window; default `32768`.
- `PI_OLLAMA_MAX_TOKENS` — registered maximum output tokens; default `8192`.
- `PI_OLLAMA_TOOLS` — comma-separated active tools for Ollama models; default `read,edit,write,bash`.
- `PI_OLLAMA_LEAN_TOOLS` — set to `0`, `false`, `off`, or `no` to disable tool filtering.
- `PI_OLLAMA_THINKING` — thinking level override; default `keep` (inherit).

Ollama discovery is best-effort. A running Ollama service is not required for Pi to start.

### `openai-usage`

Shows OpenAI Codex OAuth rate-limit windows in the Pi status area and refreshes them after agent turns and model changes.

```text
/openai-usage
```

The extension reads the `openai-codex` provider credential from Pi. Run `/login openai-codex` if the credential is unavailable. It queries the ChatGPT usage endpoint every 60 seconds while an OpenAI Codex model is active. It does not display usage for other providers.

Machine-local settings and credentials for all extensions remain outside this repository. They are not stored here.

## Install

Local development checkout:

```bash
pi install ~/Documents/Coding/pi-extensions
```

Another client:

```bash
pi install git:git@github.com:jtabke/pi-extensions
```

After changing installed extensions, restart Pi.
