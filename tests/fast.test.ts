import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
const configDir = join(agentDir, "extensions");
const configPath = join(configDir, "fast.json");
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));
const { default: fast } = await import("../extensions/fast/index.ts");
const luna = { id: "gpt-5.6-luna", name: "Luna", provider: "openai-codex", api: "openai-codex-responses" };
const sol = { ...luna, id: "gpt-5.6-sol", name: "Sol" };
const unsupported = { ...sol, provider: "openai" };

beforeEach(() => {
	rmSync(configDir, { recursive: true, force: true });
});
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

function config() {
	return JSON.parse(readFileSync(configPath, "utf8"));
}
function save(value: unknown, filename = "fast.json") {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, filename), JSON.stringify(value));
}
function harness(choices: (string | undefined)[] = [], model: typeof luna | undefined = sol, oauth = true, hasUI = true) {
	const events: Record<string, Function> = {};
	let handler: Function;
	const dialogs: string[][] = [];
	const notices: string[] = [];
	fast({
		on: (name: string, fn: Function) => { events[name] = fn; },
		registerCommand: (_name: string, spec: { handler: Function }) => { handler = spec.handler; },
	} as any);
	const ctx = {
		model, hasUI,
		modelRegistry: { getAvailable: () => [luna, sol, unsupported], isUsingOAuth: () => oauth },
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (_title: string, options: string[]) => {
				dialogs.push(options);
				expect(choices.length).toBeGreaterThan(0);
				const prefix = choices.shift();
				if (prefix === undefined) return undefined;
				const result = options.find((option) => option.startsWith(prefix));
				expect(result).toBeDefined();
				return result;
			},
		},
	};
	return { ctx, events, dialogs, notices, command: (args = "") => handler!(args, ctx) };
}

test("opening and cancelling preserves Luna-on, Sol-off, subagents-off defaults without writing", async () => {
	const h = harness([undefined]);
	await h.command();
	expect(h.dialogs[0]).toEqual([
		`${luna.id}: On`, `${sol.id}: Off (current parent)`, "Subagent-wide setting: Off", "Done",
	]);
	expect(existsSync(configPath)).toBe(false);
	const payload = { model: luna.id };
	expect(h.events.before_provider_request({ payload }, { ...h.ctx, model: luna })).toEqual({ ...payload, service_tier: "priority" });
	expect(h.events.before_provider_request({ payload: { model: sol.id } }, h.ctx)).toBeUndefined();
});

test("model list saves only the selected model and supports cancelling the value dialog", async () => {
	const h = harness([sol.id, undefined, sol.id, "On", "Done"]);
	await h.command();
	expect(config()).toEqual({ enabledModels: [sol.id, luna.id].sort(), subagents: false });
	const next = harness([sol.id, "Off", "Done"]);
	await next.command();
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: false });
});

test("subagent menu saves default and preserves both explicit launch overrides", async () => {
	const h = harness(["Subagent-wide", "On", "Done"]);
	await h.command();
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: true });
	for (const explicit of [undefined, false, true]) {
		const input = { workflowScript: "return 1", fast: explicit };
		h.events.tool_call({ toolName: "subagent", input });
		expect(input.fast).toBe(explicit ?? true);
	}
	await h.command("subagents off");
	const input = { workflowScript: "return 1" };
	h.events.tool_call({ toolName: "subagent", input });
	expect(input).not.toHaveProperty("fast");
});

test("model list changes a different model without changing the selected parent", async () => {
	const h = harness([luna.id, "Off", sol.id, "On", "Done"]);
	await h.command();
	expect(config()).toEqual({ enabledModels: [sol.id], subagents: false });
	expect(h.ctx.model).toBe(sol);
});

test("unavailable saved models can be disabled but not enabled", async () => {
	save({ enabledModels: ["retired-model"], subagents: false });
	const h = harness(["retired-model", "On", "retired-model", "Off", "Done"]);
	await h.command();
	expect(h.notices[0]).toContain("unavailable");
	expect(config().enabledModels).toEqual([]);
});

test("model list does not mark a different provider's model as current or allow non-OAuth models on", async () => {
	const h = harness(["Done"], unsupported);
	await h.command();
	expect(h.dialogs[0].some((label) => label.includes("current parent"))).toBe(false);
	const noAuth = harness([luna.id, "On", "Done"], sol, false);
	await noAuth.command();
	expect(noAuth.dialogs[0]).toEqual([`${luna.id}: On (unavailable)`, "Subagent-wide setting: Off", "Done"]);
	expect(noAuth.notices[0]).toContain("unavailable");
	expect(existsSync(configPath)).toBe(false);
});

test("headless bare command does not enable Fast or open dialogs", async () => {
	const h = harness([], sol, true, false);
	await h.command();
	expect(h.dialogs).toEqual([]);
	expect(existsSync(configPath)).toBe(false);
	await h.command("on");
	expect(config().enabledModels).toContain(sol.id);
});

test("inline controls and status retain their existing behavior", async () => {
	const h = harness();
	await h.command("all on");
	expect(config()).toEqual({ enabledModels: [sol.id, luna.id].sort(), subagents: true });
	const saved = readFileSync(configPath, "utf8");
	for (const args of ["status", "all status", "luna status", "subagents status", "invalid", "on extra"]) {
		await h.command(args);
		expect(readFileSync(configPath, "utf8")).toBe(saved);
	}
	await h.command("all off");
	await h.command("luna off");
	expect(config()).toEqual({ enabledModels: [], subagents: false });
	await h.command("luna");
	expect(config().enabledModels).toEqual([luna.id]);
	expect(h.dialogs).toEqual([]);
});

test("status reports the requested scope and unsupported current models without writing", async () => {
	const h = harness([], unsupported);
	await h.command("status");
	expect(h.notices.pop()).toBe("Saved Fast setting for Sol: unsupported.\nSaved subagent Fast setting: off.");
	await h.command("all status");
	expect(h.notices.pop()).toContain("unsupported");
	await h.command("luna status");
	expect(h.notices.pop()).toBe("Saved Fast setting for Luna: on.");
	await h.command("subagents status");
	expect(h.notices.pop()).toBe("Saved subagent Fast setting: off.");
	expect(existsSync(configPath)).toBe(false);
});

test("unsupported, unauthenticated, and missing current models cannot partially update all", async () => {
	const missing = harness();
	missing.ctx.model = undefined;
	for (const h of [harness([], unsupported), harness([], sol, false), missing]) {
		for (const args of ["on", "off", "all", "all on", "all off"]) {
			await h.command(args);
			expect(h.notices.pop()).toContain("does not support");
			expect(existsSync(configPath)).toBe(false);
		}
	}
	await missing.command("subagents");
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: true });
	await missing.command("luna off");
	expect(config()).toEqual({ enabledModels: [], subagents: true });
});

test("legacy Luna settings migrate and remain visible in the menu", async () => {
	save({ enabled: false }, "luna-fast.json");
	const h = harness([luna.id, "On", "Done"]);
	await h.command();
	expect(existsSync(join(configDir, "luna-fast.json"))).toBe(false);
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: false });
});

test("parent payload safeguards preserve explicit tiers and reject mismatched or unsupported requests", () => {
	const h = harness([], luna);
	for (const payload of [{ model: luna.id, service_tier: "auto" }, { model: sol.id }, null, []]) {
		expect(h.events.before_provider_request({ payload }, h.ctx)).toBeUndefined();
	}
	expect(h.events.before_provider_request({ payload: { model: luna.id } }, { ...h.ctx, model: unsupported })).toBeUndefined();
});
