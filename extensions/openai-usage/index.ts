import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readCodexRateLimits } from "./codex-rate-limits.js";

const CODEX_PROVIDER = "openai-codex";
const STATUS_KEY = "openai-usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

type Credentials = {
  accessToken: string;
  accountId: string;
};

type UsageWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  limit_window_minutes?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
};

type RateLimitBucket = {
  primary_window?: unknown;
  secondary_window?: unknown;
};

type UsageResponse = {
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
};

type DisplayWindow = {
  label: string;
  remainingPercent: number;
  resetAfterSeconds?: number;
  durationSeconds: number;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function decodeAccountId(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    const claims = asRecord(asRecord(decoded)?.[OPENAI_AUTH_CLAIM]);
    const accountId = claims?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCredentials(rawCredential: string): Credentials | undefined {
  const raw = rawCredential.trim();
  if (!raw) return undefined;

  try {
    const parsed = asRecord(JSON.parse(raw));
    const accessToken = parsed?.access ?? parsed?.token;
    if (typeof accessToken === "string") {
      const accountId =
        parsed?.accountId ?? parsed?.account_id ?? decodeAccountId(accessToken);
      if (typeof accountId === "string" && accountId.length > 0) {
        return { accessToken, accountId };
      }
    }
  } catch {
    // Pi normally returns the raw JWT rather than a JSON credential object.
  }

  const accountId = decodeAccountId(raw);
  return accountId ? { accessToken: raw, accountId } : undefined;
}

async function resolveCredentials(
  ctx: ExtensionContext,
): Promise<Credentials | undefined> {
  try {
    const raw = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER);
    return raw ? parseCredentials(raw) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function selectRateLimitBucket(
  response: UsageResponse,
  modelId: string | undefined,
): RateLimitBucket | undefined {
  const root = asRecord(response.rate_limit) as RateLimitBucket | undefined;
  if (!modelId) return root;

  const normalizedModel = normalizeName(modelId);
  const additional = response.additional_rate_limits;
  const entries = Array.isArray(additional)
    ? additional
    : Object.values(asRecord(additional) ?? {});

  for (const entry of entries) {
    const record = asRecord(entry);
    const limitName = record?.limit_name;
    if (typeof limitName !== "string") continue;

    const normalizedLimit = normalizeName(limitName);
    if (
      !normalizedModel.includes(normalizedLimit) &&
      !normalizedLimit.includes(normalizedModel)
    )
      continue;

    const bucket = asRecord(record.rate_limit) as RateLimitBucket | undefined;
    if (bucket) return bucket;
  }

  return root;
}

function durationSeconds(window: UsageWindow): number | undefined {
  const seconds = finiteNumber(window.limit_window_seconds);
  if (seconds !== undefined && seconds > 0) return seconds;

  const minutes = finiteNumber(window.limit_window_minutes);
  return minutes !== undefined && minutes > 0 ? minutes * 60 : undefined;
}

function formatWindowDuration(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0)
    return `${seconds / 86_400}d`;
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds)}s`;
}

function resetAfterSeconds(window: UsageWindow): number | undefined {
  const resetAfter = finiteNumber(window.reset_after_seconds);
  if (resetAfter !== undefined) return Math.max(0, resetAfter);

  const resetAt = finiteNumber(window.reset_at);
  if (resetAt === undefined) return undefined;
  const resetAtMs = resetAt > 100_000_000_000 ? resetAt : resetAt * 1000;
  return Math.max(0, (resetAtMs - Date.now()) / 1000);
}

function parseWindow(value: unknown): DisplayWindow | undefined {
  const window = asRecord(value) as UsageWindow | undefined;
  if (!window) return undefined;

  const usedPercent = finiteNumber(window.used_percent);
  const seconds = durationSeconds(window);
  if (usedPercent === undefined || seconds === undefined) return undefined;

  return {
    label: formatWindowDuration(seconds),
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetAfterSeconds: resetAfterSeconds(window),
    durationSeconds: seconds,
  };
}

function parseWindows(
  raw: unknown,
  modelId: string | undefined,
): DisplayWindow[] {
  const response = asRecord(raw) as UsageResponse | undefined;
  if (!response) return [];

  const bucket = selectRateLimitBucket(response, modelId);
  if (!bucket) return [];

  return [
    parseWindow(bucket.primary_window),
    parseWindow(bucket.secondary_window),
  ]
    .filter((window): window is DisplayWindow => window !== undefined)
    .sort((left, right) => left.durationSeconds - right.durationSeconds);
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function formatReset(seconds: number): string {
  const roundedMinutes = Math.max(0, Math.round(seconds / 60));
  const days = Math.floor(roundedMinutes / 1_440);
  const hours = Math.floor((roundedMinutes % 1_440) / 60);
  const minutes = roundedMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function windowAmount(window: DisplayWindow): string {
  return `${window.label} ${formatPercent(window.remainingPercent)}% left`;
}

function amountColor(window: DisplayWindow): "error" | "warning" | "success" {
  if (window.remainingPercent <= 20) return "error";
  if (window.remainingPercent <= 40) return "warning";
  return "success";
}

function formatWindow(window: DisplayWindow): string {
  const reset =
    window.resetAfterSeconds === undefined
      ? ""
      : `, resets in ${formatReset(window.resetAfterSeconds)}`;
  return windowAmount(window) + reset;
}

function windowPace(window: DisplayWindow) {
  if (window.resetAfterSeconds === undefined) return undefined;
  // T3 compares quota used with the percentage of the reset window elapsed.
  const elapsed = Math.max(0, Math.min(1, 1 - window.resetAfterSeconds / window.durationSeconds));
  const gap = 100 - window.remainingPercent - elapsed * 100;
  if (gap > 5) return { text: "Ahead of pace", color: "warning" } as const;
  if (gap < -5) return { text: "Under pace", color: "success" } as const;
  return { text: "On pace", color: "muted" } as const;
}

function formatCodexQuota(raw: unknown, theme?: ExtensionContext["ui"]["theme"]): string | undefined {
  const result = asRecord(raw);
  const formatBucket = (key: string, value: unknown): string | undefined => {
    const bucket = asRecord(value);
    if (!bucket) return undefined;
    const windows = [bucket.primary, bucket.secondary]
      .map(asRecord)
      .map((window) => parseWindow({
        used_percent: window?.usedPercent,
        limit_window_minutes: window?.windowDurationMins,
        reset_at: window?.resetsAt,
      }))
      .filter((window): window is DisplayWindow => window !== undefined)
      .sort((a, b) => a.durationSeconds - b.durationSeconds);
    if (windows.length === 0) return undefined;
    const name = key === "codex" ? "" :
      (typeof bucket.limitName === "string" ? bucket.limitName : key).replace(/[^a-zA-Z0-9 ._()-]/g, "").trim().slice(0, 60);
    const summary = windows.map((window) => {
      const amount = theme ? theme.fg(amountColor(window), windowAmount(window)) : formatWindow(window);
      const pace = windowPace(window);
      return pace ? amount + " · " + (theme ? theme.fg(pace.color, pace.text) : pace.text) : amount;
    });
    const label = `Codex quota${name ? ` (${name})` : ""}:`;
    return `${theme ? theme.fg("dim", label) : label} ${summary.join(" | ")}`;
  };
  const byId = asRecord(result?.rateLimitsByLimitId);
  if (theme) return formatBucket("codex", byId?.codex) ?? formatBucket("codex", result?.rateLimits);
  const buckets = Object.entries(byId ?? {})
    .map(([key, value]) => formatBucket(key, value))
    .filter((line): line is string => line !== undefined);
  return buckets.length ? buckets.join("\n") : formatBucket("codex", result?.rateLimits);
}

function formatStatus(
  ctx: ExtensionContext,
  windows: DisplayWindow[],
): { styled: string; plain: string } {
  const styledParts = windows.map((window) => ctx.ui.theme.fg(amountColor(window), windowAmount(window)));
  const plainParts = windows.map(formatWindow);

  return {
    styled: `${ctx.ui.theme.fg("dim", "OpenAI:")} ${styledParts.join(ctx.ui.theme.fg("dim", " · "))}`,
    plain: `OpenAI: ${plainParts.join(" · ")}`,
  };
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight:
    | { controller: AbortController; result: Promise<string> }
    | undefined;
  let lastFetchAt = 0;
  let activeSource: string | undefined;
  let lastPlainStatus = "OpenAI usage unavailable";

  function stopRefresh(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    inFlight?.controller.abort();
    inFlight = undefined;
    lastFetchAt = 0;
  }

  // setStatus also emits RPC UI events. Keep the automatic meter in Pi's
  // terminal footer rather than surfacing it in hosts such as T3.
  function setFooter(ctx: ExtensionContext, text?: string): void {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, text);
  }

  function usageKind(ctx: ExtensionContext): "chatgpt" | "codex" | undefined {
    const model = ctx.model;
    if (model?.provider === "openai" && ctx.modelRegistry.isUsingOAuth(model))
      return "chatgpt";
    if (model?.provider === CODEX_PROVIDER && ctx.modelRegistry.isUsingOAuth(model))
      return "codex";
    return undefined;
  }

  async function fetchLegacyQuota(ctx: ExtensionContext, signal: AbortSignal) {
    const credentials = await resolveCredentials(ctx);
    signal.throwIfAborted();
    if (!credentials) throw new Error("Run /login openai-codex.");
    const response = await fetch(CODEX_USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const windows = parseWindows(await response.json(), ctx.model?.id);
    if (windows.length === 0) throw new Error("No rate-limit windows in response.");
    return formatStatus(ctx, windows);
  }

  async function fetchCliQuota(ctx: ExtensionContext, signal: AbortSignal) {
    const result = await readCodexRateLimits(signal);
    const plain = formatCodexQuota(result);
    if (!plain) throw new Error("Codex did not report any quota windows for this login.");
    const styled = ctx.mode === "tui" ? formatCodexQuota(result, ctx.ui.theme) : undefined;
    return { plain, styled };
  }

  async function fetchAndPublish(
    ctx: ExtensionContext,
    force = false,
  ): Promise<string> {
    const kind = usageKind(ctx);
    if (!kind) return "OpenAI subscription usage is unavailable for the active model or authentication.";
    if (inFlight) return inFlight.result;
    if (!force && Date.now() - lastFetchAt < REFRESH_INTERVAL_MS)
      return lastPlainStatus;

    const controller = new AbortController();
    lastFetchAt = Date.now();
    const result = (async () => {
      try {
        const status = kind === "chatgpt"
          ? await fetchCliQuota(ctx, controller.signal)
          : await fetchLegacyQuota(ctx, controller.signal);
        if (controller.signal.aborted) return lastPlainStatus;
        lastPlainStatus = status.plain;
        setFooter(ctx, status.styled);
      } catch (error) {
        if (controller.signal.aborted) return lastPlainStatus;
        const message = error instanceof Error ? error.message : "Could not read quota.";
        const label = kind === "chatgpt" ? "Codex quota unavailable" : "OpenAI usage unavailable";
        lastPlainStatus = `${label}: ${message}`;
        setFooter(ctx, ctx.ui.theme.fg("warning", label));
      }
      return lastPlainStatus;
    })().finally(() => {
      if (inFlight?.controller === controller) inFlight = undefined;
    });

    inFlight = { controller, result };
    return result;
  }

  function refreshForModel(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const kind = usageKind(ctx);
    // The CLI reports Codex account quota, so switching between Pi OpenAI
    // models does not require restarting the read.
    const source = kind === "codex" ? `legacy:${ctx.model?.id}` : kind;
    if (source === activeSource) return;
    activeSource = source;
    stopRefresh();
    setFooter(ctx);
    if (!source) return;

    void fetchAndPublish(ctx);
    refreshTimer = setInterval(() => { void fetchAndPublish(ctx); }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  pi.on("session_start", (_event, ctx) => refreshForModel(ctx));
  pi.on("model_select", (_event, ctx) => refreshForModel(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode === "tui") void fetchAndPublish(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    activeSource = undefined;
    stopRefresh();
    setFooter(ctx);
  });

  pi.registerCommand("openai-usage", {
    description: "Show quota details and reset times; add codex to query the local CLI from any model",
    getArgumentCompletions: (prefix) => "codex".startsWith(prefix.trim().toLowerCase())
      ? [{ value: "codex", label: "codex", description: "Show quota from the signed-in Codex CLI" }]
      : null,
    handler: async (args, ctx) => {
      const option = args.trim().toLowerCase();
      if (option === "codex") {
        if (usageKind(ctx) === "chatgpt") {
          const status = await fetchAndPublish(ctx, true);
          ctx.ui.notify(status, status.startsWith("Codex quota unavailable") ? "warning" : "info");
          return;
        }
        try {
          const status = formatCodexQuota(await readCodexRateLimits(ctx.signal));
          if (status) ctx.ui.notify(status, "info");
          else ctx.ui.notify("Codex did not report any quota windows for this login.", "warning");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Could not read Codex quota.", "warning");
        }
        return;
      }
      if (option) {
        ctx.ui.notify("Usage: /openai-usage [codex]", "warning");
        return;
      }
      const status = await fetchAndPublish(ctx, true);
      const link = usageKind(ctx) === "chatgpt" ? `\nPi sign-in usage: ${CHATGPT_USAGE_URL}` : "";
      ctx.ui.notify(status + link, status.includes("unavailable") ? "warning" : "info");
    },
  });
}
