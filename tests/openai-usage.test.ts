import { afterEach, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import usage from "../extensions/openai-usage/index.ts";

const chatgpt = { provider: "openai", id: "gpt-6.2-sol" };
const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
const fakeCredential = JSON.stringify({ access: "fake-token", accountId: "fake-account" });
const fixture = {
  rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 25 } },
};

function harness(initial = chatgpt, oauth = true) {
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
  let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
  const statuses: (string | undefined)[] = [];
  const notices: { message: string; level: string }[] = [];
  const providers: string[] = [];
  const context = {
    model: initial,
    modelRegistry: {
      isUsingOAuth: () => oauth,
      getApiKeyForProvider: async (provider: string) => {
        providers.push(provider);
        return fakeCredential;
      },
    },
    ui: {
      setStatus: (_key: string, status?: string) => { statuses.push(status); },
      theme: { fg: (_color: string, value: string) => value },
      notify: (message: string, level: string) => { notices.push({ message, level }); },
    },
  };
  usage({
    on: (event: string, handler: typeof handlers[string]) => { handlers[event] = handler; },
    registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
  } as unknown as ExtensionAPI);
  const ctx = context as unknown as ExtensionContext;
  return {
    statuses, notices, providers,
    start: () => handlers.session_start({}, ctx),
    select: (model: typeof chatgpt) => { context.model = model; return handlers.model_select({ model }, ctx); },
    settled: () => handlers.agent_settled({}, ctx),
    stop: () => handlers.session_shutdown({}, ctx),
    command: () => command!("", ctx),
  };
}

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { fetchMock?.mockRestore(); });

function mockFetch() {
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(fixture));
  return fetchMock;
}

test("current ChatGPT OAuth shows the usage link without resolving or sending credentials", async () => {
  const fetch = mockFetch();
  const h = harness();
  try {
    await h.start();
    await h.settled();
    await h.command();
    expect(h.statuses.at(-1)).toBe("ChatGPT usage: /openai-usage");
    const notice = h.notices.at(-1);
    expect(notice?.level).toBe("info");
    expect(notice?.message).toContain("https://chatgpt.com/settings/usage");
    expect(notice?.message).toContain("Numeric quota windows are not available");
    expect(h.providers).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  } finally { h.stop(); }
});

test("API-key or other-provider sessions do not show subscription usage or fetch credentials", async () => {
  const fetch = mockFetch();
  for (const h of [harness(chatgpt, false), harness(codex, false), harness({ ...chatgpt, provider: "other" })]) {
    try {
      await h.start();
      await h.command();
      expect(h.statuses.at(-1)).toBeUndefined();
      expect(h.notices.at(-1)?.message).toContain("unavailable for the active model or authentication");
      expect(h.providers).toEqual([]);
    } finally { h.stop(); }
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("legacy Codex OAuth keeps numeric windows and only sends its credential to the Codex origin", async () => {
  const fetch = mockFetch();
  const h = harness(codex);
  try {
    await h.start();
    expect(h.statuses.at(-1)).toBe("OpenAI: 5h 75% left");
    expect(h.providers).toEqual(["openai-codex"]);
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer fake-token", "chatgpt-account-id": "fake-account" }),
    }));
    await h.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { h.stop(); }
});

test("switching to ChatGPT aborts an in-flight Codex refresh and keeps the ChatGPT footer", async () => {
  const fetch = mockFetch();
  let release!: (value: Response) => void;
  let started!: (value: AbortSignal | null | undefined) => void;
  const request = new Promise<AbortSignal | null | undefined>((resolve) => { started = resolve; });
  fetch.mockImplementation((_url, options) => {
    started(options?.signal);
    return new Promise((resolve) => { release = resolve; });
  });
  const h = harness(codex);
  try {
    const pending = h.start();
    const signal = await request;
    await h.select(chatgpt);
    expect(signal?.aborted).toBe(true);
    release(Response.json(fixture));
    await pending;
    expect(h.statuses.at(-1)).toBe("ChatGPT usage: /openai-usage");
  } finally { h.stop(); }
});
