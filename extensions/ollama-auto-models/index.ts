import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type DiscoveredModel = {
  id: string;
  name?: string;
  family?: string;
  capabilities?: string[];
};

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_OLLAMA_TOOLS = ["read", "edit", "write", "bash"];
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function normalizeOllamaHost(raw: string | undefined): string {
  let host = (raw ?? DEFAULT_OLLAMA_HOST).trim();
  if (!host) host = DEFAULT_OLLAMA_HOST;
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
  host = host.replace(/\/+$/, "");
  return host.replace(/\/v1$/i, "");
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function modelsFromOpenAI(payload: unknown): DiscoveredModel[] {
  const data = (payload as { data?: Array<{ id?: string; name?: string }> }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((model) => ({ id: model.id ?? model.name ?? "", name: model.name ?? model.id }))
    .filter((model) => Boolean(model.id));
}

function modelsFromOllamaTags(payload: unknown): DiscoveredModel[] {
  const models = (payload as { models?: Array<{ name?: string; model?: string }> }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => ({ id: model.name ?? model.model ?? "", name: model.name ?? model.model }))
    .filter((model) => Boolean(model.id));
}

function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const byId = new Map<string, DiscoveredModel>();
  for (const model of models) {
    if (model.id && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function enrichModel(
  host: string,
  model: DiscoveredModel,
  timeoutMs: number,
): Promise<DiscoveredModel> {
  try {
    const payload = (await fetchJson(`${host}/api/show`, timeoutMs, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model.id }),
    })) as {
      capabilities?: string[];
      details?: { family?: string };
    };

    return {
      ...model,
      family: payload.details?.family,
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : undefined,
    };
  } catch (error) {
    console.warn(`[ollama-auto-models] Metadata discovery failed for ${model.id}: ${error}`);
    return model;
  }
}

async function discoverOllamaModels(host: string): Promise<DiscoveredModel[]> {
  const timeoutMs = positiveInteger(process.env.PI_OLLAMA_DISCOVERY_TIMEOUT_MS, 1500);
  let discovered: DiscoveredModel[] = [];

  try {
    const payload = await fetchJson(`${host}/api/tags`, timeoutMs);
    discovered = uniqueModels(modelsFromOllamaTags(payload));
  } catch (error) {
    console.warn(`[ollama-auto-models] /api/tags discovery failed: ${error}`);
  }

  if (!discovered.length) {
    try {
      const payload = await fetchJson(`${host}/v1/models`, timeoutMs);
      discovered = uniqueModels(modelsFromOpenAI(payload));
    } catch (error) {
      console.warn(`[ollama-auto-models] /v1/models discovery failed: ${error}`);
    }
  }

  return Promise.all(discovered.map((model) => enrichModel(host, model, timeoutMs)));
}

function configuredOllamaTools(): string[] | undefined {
  if (/^(0|false|off|no)$/i.test(process.env.PI_OLLAMA_LEAN_TOOLS ?? "")) return undefined;
  const configured = process.env.PI_OLLAMA_TOOLS?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_OLLAMA_TOOLS;
}

function configuredOllamaThinking(): ThinkingLevel | undefined {
  const raw = (process.env.PI_OLLAMA_THINKING ?? "keep").trim().toLowerCase();
  if (/^(keep|inherit|default)$/i.test(raw)) return undefined;
  return THINKING_LEVELS.has(raw as ThinkingLevel) ? (raw as ThinkingLevel) : "off";
}

export default async function (pi: ExtensionAPI) {
  const host = normalizeOllamaHost(process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_HOST);
  const modelCapabilities = new Map<string, Set<string>>();
  let toolsToRestore: string[] | undefined;
  let thinkingToRestore: ThinkingLevel | undefined;

  async function registerOllamaProvider(): Promise<number> {
    const discovered = await discoverOllamaModels(host);

    if (!discovered.length) {
      console.warn(`[ollama-auto-models] No local Ollama models found at ${host}`);
      return 0;
    }

    const contextWindow = positiveInteger(
      process.env.PI_OLLAMA_CONTEXT_WINDOW,
      DEFAULT_CONTEXT_WINDOW,
    );
    const maxTokens = positiveInteger(process.env.PI_OLLAMA_MAX_TOKENS, DEFAULT_MAX_TOKENS);

    modelCapabilities.clear();
    for (const model of discovered) {
      modelCapabilities.set(model.id, new Set(model.capabilities ?? []));
    }

    pi.registerProvider("ollama", {
      name: "Ollama",
      baseUrl: `${host}/v1`,
      api: "openai-completions",
      apiKey: "ollama",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: discovered.map((model) => {
        const capabilities = new Set(model.capabilities ?? []);
        const supportsThinking = capabilities.has("thinking");
        const isQwen = /qwen/i.test(`${model.family ?? ""} ${model.id}`);

        return {
          id: model.id,
          name: `${model.name ?? model.id} (Ollama)`,
          reasoning: supportsThinking,
          input: capabilities.has("vision") ? (["text", "image"] as const) : (["text"] as const),
          contextWindow,
          maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: supportsThinking && isQwen
            ? { thinkingFormat: "qwen-chat-template" as const }
            : undefined,
        };
      }),
    });

    return discovered.length;
  }

  function applyOllamaProfile(provider: string | undefined, modelId: string | undefined, ctx: ExtensionContext) {
    if (provider !== "ollama") {
      if (toolsToRestore) {
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        pi.setActiveTools(toolsToRestore.filter((name) => available.has(name)));
        toolsToRestore = undefined;
      }
      if (thinkingToRestore) {
        pi.setThinkingLevel(thinkingToRestore);
        thinkingToRestore = undefined;
      }
      return;
    }

    const leanTools = configuredOllamaTools();
    if (leanTools) {
      toolsToRestore ??= pi.getActiveTools();
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const baseline = new Set(toolsToRestore);
      const supportsTools = !modelId || modelCapabilities.get(modelId)?.has("tools") !== false;
      const active = supportsTools
        ? leanTools.filter((name) => available.has(name) && baseline.has(name))
        : [];
      pi.setActiveTools(active);
      if (ctx.hasUI) {
        ctx.ui.notify(
          active.length ? `Ollama lean tools: ${active.join(", ")}` : "This Ollama model reports no tool support.",
          "info",
        );
      }
    }

    const thinking = configuredOllamaThinking();
    if (thinking) {
      thinkingToRestore ??= pi.getThinkingLevel();
      pi.setThinkingLevel(thinking);
    }
  }

  await registerOllamaProvider();

  pi.on("session_start", (_event, ctx) => {
    applyOllamaProfile(ctx.model?.provider, ctx.model?.id, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    applyOllamaProfile(event.model.provider, event.model.id, ctx);
  });

  pi.registerCommand("ollama-refresh", {
    description: "Refresh Pi's Ollama model list from the local Ollama server",
    handler: async (_args, ctx) => {
      const count = await registerOllamaProvider();
      if (count > 0) {
        ctx.ui.notify(
          `Registered ${count} Ollama model${count === 1 ? "" : "s"}. Open /model to view them.`,
          "info",
        );
      } else {
        ctx.ui.notify(`No Ollama models found at ${host}. Is Ollama running?`, "warning");
      }
    },
  });
}
