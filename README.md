# pi-extensions

Personal [Pi](https://github.com/earendil-works/pi-mono) extensions shared across clients.

## Extensions

### `fast`

Adds `service_tier: "priority"` to enabled ChatGPT-authenticated OpenAI Codex requests. Enable Fast mode for whichever supported model is currently selected:

```text
/fast
/fast off
/fast status
```

Control Luna explicitly through the same command:

```text
/fast luna
/fast luna off
/fast luna status
```

Enable Fast mode as the default for every supported native `pi-subagents` workflow child:

```text
/fast subagents on
/fast subagents off
/fast subagents status
```

The subagent toggle adds `fast: true` to workflow launches that do not already set `fast`. Individual launches can still opt out with `fast: false`. Fast mode supports only the native OpenAI Codex models allowed by `pi-subagents`; external runners and unsupported models fail through its normal validation.

Fast mode settings are stored in `~/.pi/agent/extensions/fast.json`. On startup, the extension migrates the former `luna-fast.json` file automatically. The old `{ "enabled": boolean }` format remains compatible and controls Luna only. Models from other providers and non-ChatGPT authentication do not support this extension's parent-session Fast mode. The machine-local setting is not stored in this repository.

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
