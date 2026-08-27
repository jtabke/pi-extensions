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
