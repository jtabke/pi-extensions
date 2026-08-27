import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const STATUS_KEY = "openai-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
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
    const raw = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
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

function formatStatus(
  ctx: ExtensionContext,
  windows: DisplayWindow[],
): { styled: string; plain: string } {
  const styledParts = windows.map((window) => {
    const value = `${window.label} ${formatPercent(window.remainingPercent)}% left`;
    const color =
      window.remainingPercent <= 20
        ? "error"
        : window.remainingPercent <= 40
          ? "warning"
          : "success";
    return ctx.ui.theme.fg(color, value);
  });
  const plainParts = windows.map((window) => {
    const reset =
      window.resetAfterSeconds === undefined
        ? ""
        : `, resets in ${formatReset(window.resetAfterSeconds)}`;
    return `${window.label} ${formatPercent(window.remainingPercent)}% left${reset}`;
  });

  return {
    styled: `${ctx.ui.theme.fg("dim", "OpenAI:")} ${styledParts.join(ctx.ui.theme.fg("dim", " · "))}`,
    plain: `OpenAI: ${plainParts.join(" · ")}`,
  };
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<string> | undefined;
  let lastFetchAt = 0;
  let lastPlainStatus = "OpenAI usage unavailable";

  function stopTimer(): void {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  function modelUsesCodex(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === PROVIDER;
  }

  async function fetchAndPublish(
    ctx: ExtensionContext,
    force = false,
  ): Promise<string> {
    if (!modelUsesCodex(ctx)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return "OpenAI usage is hidden because the active model is not using OpenAI Codex OAuth";
    }

    if (!force && Date.now() - lastFetchAt < REFRESH_INTERVAL_MS)
      return lastPlainStatus;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const credentials = await resolveCredentials(ctx);
      if (!credentials) {
        lastPlainStatus = "OpenAI usage unavailable. Run /login openai-codex";
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("warning", lastPlainStatus),
        );
        return lastPlainStatus;
      }

      try {
        const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
        if (ctx.signal) signals.push(ctx.signal);
        const response = await fetch(USAGE_URL, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${credentials.accessToken}`,
            "chatgpt-account-id": credentials.accountId,
          },
          signal: AbortSignal.any(signals),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const windows = parseWindows(await response.json(), ctx.model?.id);
        if (windows.length === 0)
          throw new Error("No rate-limit windows in response");

        const status = formatStatus(ctx, windows);
        lastFetchAt = Date.now();
        lastPlainStatus = status.plain;
        ctx.ui.setStatus(STATUS_KEY, status.styled);
        return status.plain;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastPlainStatus = `OpenAI usage refresh failed: ${message}`;
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("warning", lastPlainStatus),
        );
        return lastPlainStatus;
      }
    })().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  }

  function startTimer(ctx: ExtensionContext): void {
    stopTimer();
    if (!modelUsesCodex(ctx)) return;

    refreshTimer = setInterval(() => {
      void fetchAndPublish(ctx);
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    startTimer(ctx);
    await fetchAndPublish(ctx, true);
  });

  pi.on("model_select", async (_event, ctx) => {
    startTimer(ctx);
    await fetchAndPublish(ctx, true);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await fetchAndPublish(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("openai-usage", {
    description: "Refresh and show OpenAI Codex subscription usage",
    handler: async (_args, ctx) => {
      const status = await fetchAndPublish(ctx, true);
      ctx.ui.notify(
        status,
        status.includes("failed") || status.includes("unavailable")
          ? "warning"
          : "info",
      );
    },
  });
}
