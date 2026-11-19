import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import usage from "../extensions/openai-usage/index.ts";

const chatgpt = { provider: "openai", id: "gpt-6.2-sol" };
const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
const fakeCredential = JSON.stringify({ access: "fake-token", accountId: "fake-account" });
const fixture = {
  rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 25 } },
};

function harness(initial = chatgpt, oauth = true, mode: ExtensionContext["mode"] = "tui") {
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
  let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
  const statuses: (string | undefined)[] = [];
  let statusChanged: ((value: string | undefined) => void) | undefined;
  const notices: { message: string; level: string }[] = [];
  const providers: string[] = [];
  const authChecks: string[] = [];
  const colors: [string, string][] = [];
  const context = {
    model: initial,
    mode,
    hasUI: true,
    modelRegistry: {
      isUsingOAuth: () => { authChecks.push(context.model.provider); return oauth; },
      getApiKeyForProvider: async (provider: string) => {
        providers.push(provider);
        return fakeCredential;
      },
    },
    ui: {
      setStatus: (_key: string, status?: string) => { statuses.push(status); statusChanged?.(status); },
      theme: { fg: (color: string, value: string) => { colors.push([color, value]); return value; } },
      notify: (message: string, level: string) => { notices.push({ message, level }); },
    },
  };
  usage({
    on: (event: string, handler: typeof handlers[string]) => { handlers[event] = handler; },
    registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
  } as unknown as ExtensionAPI);
  const ctx = context as unknown as ExtensionContext;
  return {
    statuses, notices, providers, authChecks, colors,
    waitForStatus: (expected: string) => statuses.includes(expected) ? Promise.resolve() :
      new Promise<void>((resolve) => {
        statusChanged = (value) => {
          if (value !== expected) return;
          statusChanged = undefined;
          resolve();
        };
      }),
    start: () => handlers.session_start({}, ctx),
    select: (model: typeof chatgpt) => { context.model = model; return handlers.model_select({ model }, ctx); },
    settled: () => handlers.agent_settled({}, ctx),
    stop: () => handlers.session_shutdown({}, ctx),
    command: (args = "") => command!(args, ctx),
  };
}

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { fetchMock?.mockRestore(); });

function mockFetch() {
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(fixture));
  return fetchMock;
}

test("current ChatGPT OAuth automatically shows Codex quota and pace; slash command adds details", async () => {
  const fetch = mockFetch();
  const h = harness();
  const nextHalfHour = Math.floor(Date.now() / 1000) + 1800;
  const main = { primary: { usedPercent: 25, resetsAt: nextHalfHour, windowDurationMins: 60 } };
  const other = { limitName: "Extra", primary: { ...main.primary, usedPercent: 75 } };
  await withFakeCodex({ result: { rateLimitsByLimitId: { codex: main, extra: other } } }, async () => {
    try {
      expect(h.start()).toBeUndefined(); // startup does not wait for the subprocess
      await h.waitForStatus("Codex quota: 1h 75% left · Under pace");
      expect(h.colors).toContainEqual(["success", "1h 75% left"]);
      expect(h.colors).toContainEqual(["success", "Under pace"]);
      expect(h.notices).toEqual([]);
      const statuses = h.statuses.length;
      await h.select({ ...chatgpt, id: "gpt-6.2-astra" });
      expect(h.statuses).toHaveLength(statuses);
      await h.command();
      expect(h.notices.at(-1)?.level).toBe("info");
      expect(h.notices.at(-1)?.message).toContain("Codex quota: 1h 75% left, resets in 30m · Under pace");
      expect(h.notices.at(-1)?.message).toContain("Codex quota (Extra): 1h 25% left");
      expect(h.notices.at(-1)?.message).toContain("https://chatgpt.com/settings/usage");
      await h.select({ ...chatgpt, provider: "other" });
      expect(h.statuses.at(-1)).toBeUndefined();
      expect(h.providers).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { h.stop(); }
  });
});

test("quota level and pace receive independent theme colors", async () => {
  const h = harness();
  const now = Math.floor(Date.now() / 1000);
  await withFakeCodex({ result: { rateLimits: {
    primary: { usedPercent: 90, resetsAt: now + 30 * 60, windowDurationMins: 60 },
    secondary: { usedPercent: 65, resetsAt: now + 42 * 60, windowDurationMins: 120 },
  } } }, async () => {
    try {
      h.start();
      await h.waitForStatus("Codex quota: 1h 10% left · Ahead of pace | 2h 35% left · On pace");
      expect(h.colors).toContainEqual(["error", "1h 10% left"]);
      expect(h.colors).toContainEqual(["warning", "Ahead of pace"]);
      expect(h.colors).toContainEqual(["warning", "2h 35% left"]);
      expect(h.colors).toContainEqual(["muted", "On pace"]);
    } finally { h.stop(); }
  });
});

test("RPC hosts never receive a quota footer but can request details explicitly", async () => {
  const timedWindow = { usedPercent: 25, windowDurationMins: 60 };
  const h = harness(chatgpt, true, "rpc");
  await withFakeCodex({ result: { rateLimits: { primary: timedWindow } } }, async () => {
    try {
      await h.start();
      await h.select({ ...chatgpt, id: "gpt-6.2-astra" });
      await h.settled();
      expect(h.authChecks).toEqual([]);
      expect(h.statuses).toEqual([]);
      await h.command();
      expect(h.notices.at(-1)?.message).toContain("Codex quota: 1h 75% left");
    } finally { h.stop(); }
    expect(h.statuses).toEqual([]);
  });
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
    h.start();
    await h.waitForStatus("OpenAI: 5h 75% left");
    expect(h.providers).toEqual(["openai-codex"]);
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer fake-token", "chatgpt-account-id": "fake-account" }),
    }));
    await h.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { h.stop(); }
});

async function withFakeCodex(reply: object | undefined, run: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fake-codex-"));
  const path = process.env.PATH;
  if (reply !== undefined) {
    writeFileSync(join(dir, "codex"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(2);
let initialized = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  else if (msg.method === "initialized") initialized = true;
  else if (initialized && msg.method === "account/rateLimits/read" && msg.params.excludeResetCreditDetails) {
    console.log(JSON.stringify({ method: "unrelated/notice", params: {} }));
    console.log(JSON.stringify({ id: msg.id, ...${JSON.stringify(reply)} }));
  } else process.exit(3);
});
`, { mode: 0o755 });
  }
  process.env.PATH = reply === undefined ? dir : dir + delimiter + path;
  try { await run(); } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("/openai-usage codex uses only Codex RPC and displays T3-style pacing per timed window", async () => {
  const fetch = mockFetch();
  const h = harness({ ...chatgpt, provider: "other" });
  const nextHalfHour = Math.floor(Date.now() / 1000) + 1800;
  const window = (usedPercent: number, resetsAt: number | null = nextHalfHour) =>
    ({ usedPercent, resetsAt, windowDurationMins: 60 });
  await withFakeCodex({ result: {
    rateLimitsByLimitId: {
      codex: { primary: window(75) },
      general: { limitName: "General", primary: window(50) },
      extra: { limitName: "Extra", primary: window(25), secondary: { ...window(10, null), windowDurationMins: 120 } },
    },
  } }, async () => {
    await h.command("codex");
  });
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0].level).toBe("info");
  const lines = h.notices[0].message.split("\n");
  expect(lines).toEqual([
    "Codex quota: 1h 25% left, resets in 30m · Ahead of pace",
    "Codex quota (General): 1h 50% left, resets in 30m · On pace",
    "Codex quota (Extra): 1h 75% left, resets in 30m · Under pace | 2h 90% left",
  ]);
  expect(h.providers).toEqual([]);
  expect(h.statuses).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

test("Codex errors are actionable without relaying backend details; missing CLI and empty quota are distinct", async () => {
  for (const [reply, expected] of [
    [undefined, "Codex CLI was not found on PATH."],
    [{ error: { message: "backend detail that must not be shown" } }, "Codex could not read quota. Check `codex login status`."],
    [{ result: { rateLimits: {} } }, "Codex did not report any quota windows for this login."],
  ] as const) {
    const h = harness({ ...chatgpt, provider: "other" });
    await withFakeCodex(reply, async () => { await h.command("codex"); });
    expect(h.notices).toEqual([{ message: expected, level: "warning" }]);
  }
});

test("switching away from Codex aborts an in-flight legacy quota request", async () => {
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
    h.start();
    const signal = await request;
    const pending = h.command();
    await h.select({ ...chatgpt, provider: "other" });
    expect(signal?.aborted).toBe(true);
    release(Response.json(fixture));
    await pending;
    expect(h.statuses.at(-1)).toBeUndefined();
  } finally { h.stop(); }
});
