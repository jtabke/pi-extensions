import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
const configDir = join(agentDir, "extensions");
const configPath = join(configDir, "fast.json");
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));
const { default: fast } = await import("../extensions/fast/index.ts");
const luna = { id: "gpt-6-luna", name: "Luna", provider: "openai", api: "openai-responses" };
const sol = { ...luna, id: "gpt-6-sol", name: "Sol" };
const unsupported = { ...sol, provider: "other" };

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
function harness(choices: (string | undefined)[] = [], model: typeof luna | undefined = sol, oauth = true, hasUI = true, mode = "tui") {
	const events: Record<string, Function> = {};
	let handler: Function;
	let completions: Function;
	const dialogs: string[][] = [];
	const titles: string[] = [];
	const inputs: (string | undefined)[] = [];
	const statuses: Record<string, string | undefined> = {};
	const notices: string[] = [];
	fast({
		on: (name: string, fn: Function) => { events[name] = fn; },
		registerCommand: (_name: string, spec: { handler: Function; getArgumentCompletions: Function }) => {
			handler = spec.handler;
			completions = spec.getArgumentCompletions;
		},
	} as any);
	const ctx = {
		model, hasUI, mode,
		modelRegistry: { getAvailable: () => [luna, sol, unsupported], isUsingOAuth: () => oauth },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, value: string | undefined) => { statuses[key] = value; },
			theme: { fg: (color: string, value: string) => `[${color}]${value}` },
			input: async () => {
				expect(inputs.length).toBeGreaterThan(0);
				return inputs.shift();
			},
			select: async (title: string, options: string[]) => {
				titles.push(title);
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
	return { ctx, events, dialogs, titles, inputs, statuses, notices, command: (args = "") => handler!(args, ctx), complete: (prefix: string) => completions!(prefix) };
}

test("bare /fast opens the current speed directly; cancelling preserves defaults", async () => {
	const h = harness([undefined]);
	await h.command();
	expect(h.dialogs).toEqual([["✓ Default", "Fast"]]);
	expect(h.titles[0]).toContain("Speed for Sol");
	expect(existsSync(configPath)).toBe(false);
	const payload = { model: luna.id };
	expect(h.events.before_provider_request({ payload }, { ...h.ctx, model: luna })).toEqual({ ...payload, service_tier: "priority" });
	expect(h.events.before_provider_request({ payload: { model: sol.id } }, h.ctx)).toBeUndefined();
});

test("direct speed selection saves and closes; reselecting the current speed is a no-op", async () => {
	const h = harness(["Fast", "✓ Fast", "Default"]);
	await h.command();
	expect(h.dialogs).toHaveLength(1);
	expect(config()).toEqual({ enabledModels: [sol.id, luna.id].sort(), subagents: false });
	expect(h.statuses.fast).toBe("[accent]Fast");
	await h.command();
	expect(h.notices).toHaveLength(1);
	await h.command();
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: false });
	expect(h.statuses.fast).toBe("[dim]Default");
});

function subagentLaunches(): Record<string, unknown>[] {
	return [
		{ agent: "scout", task: "Inspect the code" },
		{ workflow: true },
		{ workflow: "./workflow.js" },
		{ workflow: "parallel", args: { tasks: [] } },
		{ options: { script: "return 1" } },
	];
}

test("subagent menu saves default and applies it to current launch forms", async () => {
	const h = harness(["On"]);
	await h.command("subagents");
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: true });
	for (const input of subagentLaunches()) {
		h.events.tool_call({ toolName: "subagent", input });
		expect(input.options).toMatchObject({ fast: true });
		expect(input).not.toHaveProperty("fast");
	}
	await h.command("subagents off");
	for (const input of subagentLaunches()) {
		const original = structuredClone(input);
		h.events.tool_call({ toolName: "subagent", input });
		expect(input).toEqual(original);
	}
});

test("subagent default preserves explicit nested and flat Fast overrides and other options", () => {
	save({ subagents: true });
	const h = harness();
	for (const launch of subagentLaunches()) {
		for (const fast of [false, true]) {
			for (const flat of [false, true]) {
				const options = { ...(launch.options as Record<string, unknown>), timeoutMs: 1000 };
				const input = flat ? { ...launch, options, fast } : { ...launch, options: { ...options, fast } };
				const original = structuredClone(input);
				h.events.tool_call({ toolName: "subagent", input });
				expect(input).toEqual(original);
			}
		}
		const input = { ...launch, options: { ...(launch.options as Record<string, unknown>), timeoutMs: 1000 } };
		h.events.tool_call({ toolName: "subagent", input });
		expect(input.options).toEqual({ ...(launch.options as Record<string, unknown>), timeoutMs: 1000, fast: true });
	}
});

test("subagent default ignores management, other tools, and malformed launch inputs", () => {
	save({ subagents: true });
	const h = harness();
	for (const input of [
		{ action: "status", id: "run" },
		{ action: "validate", workflow: true },
		{ action: "schedule.create", workflow: "./workflow.js" },
		{ action: "resume", agent: "scout", task: "Inspect" },
		{}, { agent: "scout" }, { task: "Inspect" }, { workflow: false }, { workflow: "" },
		{ workflow: true, options: null }, { workflow: true, options: [] },
		null, [],
	]) {
		const original = structuredClone(input);
		h.events.tool_call({ toolName: "subagent", input });
		expect(input).toEqual(original);
	}
	const input = { agent: "scout", task: "Inspect" };
	h.events.tool_call({ toolName: "other", input });
	expect(input).not.toHaveProperty("options");
});

test("/fast models searches by name, edits another model, and leaves the active model alone", async () => {
	const h = harness(["Default"]);
	h.inputs.push("lu");
	await h.command("models");
	expect(h.titles[0]).toContain("Speed for Luna");
	expect(h.dialogs).toEqual([["✓ Fast", "Default"]]);
	expect(config()).toEqual({ enabledModels: [], subagents: false });
	expect(h.ctx.model).toBe(sol);
	expect(h.statuses.fast).toBe("[dim]Default");
});

test("/fast models can select from matching models and cancel without saving", async () => {
	const h = harness([luna.id, undefined]);
	h.inputs.push("");
	await h.command("models");
	expect(h.dialogs).toEqual([
		[`${luna.id} · Fast`, `${sol.id} · Default`],
		["✓ Fast", "Default"],
	]);
	expect(existsSync(configPath)).toBe(false);
});

test("unavailable saved models can only be reset", async () => {
	save({ enabledModels: ["retired-model"], subagents: false });
	const h = harness(["Default"]);
	await h.command("models retired");
	expect(h.dialogs).toEqual([["Default"]]);
	expect(h.titles[0]).toContain("unavailable");
	expect(config().enabledModels).toEqual([]);
});

test("unsupported current models don't get a picker; non-OAuth settings are reset-only", async () => {
	const h = harness([], unsupported);
	await h.command();
	expect(h.dialogs).toEqual([]);
	expect(h.notices[0]).toContain("does not support");
	const noAuth = harness([undefined], sol, false);
	await noAuth.command("models luna");
	expect(noAuth.dialogs).toEqual([["Default"]]);
	expect(existsSync(configPath)).toBe(false);
});

test("terminal footer styles Default and Fast, and clears for unsupported models", () => {
	const h = harness([], luna);
	h.events.session_start({}, h.ctx);
	expect(h.statuses.fast).toBe("[accent]Fast");
	h.events.model_select({ model: sol }, h.ctx);
	expect(h.statuses.fast).toBe("[dim]Default");
	h.events.model_select({ model: luna }, h.ctx);
	expect(h.statuses.fast).toBe("[accent]Fast");
	h.events.model_select({ model: { ...luna, provider: "other" } }, h.ctx);
	expect(h.statuses.fast).toBeUndefined();
});

test("RPC speed status remains plain and does not publish Default", () => {
	const h = harness([], luna, true, true, "rpc");
	h.events.session_start({}, h.ctx);
	expect(h.statuses.fast).toBe("Fast");
	h.events.model_select({ model: sol }, h.ctx);
	expect(h.statuses.fast).toBeUndefined();
});

test("headless bare command does not enable Fast or open dialogs", async () => {
	const h = harness([], sol, true, false);
	await h.command();
	expect(h.dialogs).toEqual([]);
	expect(existsSync(configPath)).toBe(false);
	await h.command("on");
	expect(config().enabledModels).toContain(sol.id);
});

test("quick current-model commands appear in argument completions", () => {
	const h = harness();
	expect(h.complete("").map((item: { value: string }) => item.value)).toEqual([
		"on", "off", "ultrafast", "status", "models", "subagents",
	]);
	expect(h.complete("UL")).toMatchObject([{ value: "ultrafast" }]);
	expect(h.complete("unknown")).toBeNull();
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
	expect(h.notices.pop()).toBe("Saved speed for Sol: unsupported.\nSaved subagent Fast setting: off.");
	await h.command("all status");
	expect(h.notices.pop()).toContain("unsupported");
	await h.command("luna status");
	expect(h.notices.pop()).toBe("Saved speed for Luna: Fast.");
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
	await missing.command("subagents on");
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: true });
	await missing.command("luna off");
	expect(config()).toEqual({ enabledModels: [], subagents: true });
});

test("legacy Luna settings migrate and remain visible in the menu", async () => {
	save({ enabled: false }, "luna-fast.json");
	const h = harness(["Fast"]);
	await h.command("models luna");
	expect(existsSync(join(configDir, "luna-fast.json"))).toBe(false);
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: false });
});

test("GPT-6.1 Sol can enable Fast without a hard-coded model allowlist", async () => {
	const sol61 = { ...sol, id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
	const h = harness(["Fast"], sol61);
	h.ctx.modelRegistry.getAvailable = () => [luna, sol, sol61, unsupported];
	await h.command();
	expect(config()).toEqual({ enabledModels: [luna.id, sol61.id].sort(), subagents: false });
	const payload = { model: sol61.id };
	expect(h.events.before_provider_request({ payload }, h.ctx)).toEqual({ ...payload, service_tier: "priority" });
	await h.command("off");
	expect(h.events.before_provider_request({ payload }, h.ctx)).toBeUndefined();
});

const sol62 = { ...sol, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" };

test("GPT-6.2 Sol can select Ultrafast without upgrading existing Fast settings", async () => {
	save({ enabledModels: [luna.id, sol62.id], subagents: true });
	const h = harness(["Ultrafast", undefined], sol62);
	h.ctx.modelRegistry.getAvailable = () => [luna, sol62];
	const payload = { model: sol62.id };
	const request = (body: Record<string, unknown> = payload) => h.events.before_provider_request({ payload: body }, h.ctx);
	expect(request()).toEqual({ ...payload, service_tier: "priority" });
	await h.command();
	expect(h.dialogs[0]).toEqual(["✓ Fast", "Default", "Ultrafast · higher usage"]);
	expect(h.statuses.fast).toBe("[warning]Ultrafast");
	await h.command();
	expect(h.dialogs[1][0]).toBe("✓ Ultrafast · higher usage");
	expect(config()).toEqual({ enabledModels: [luna.id, sol62.id].sort(), ultrafast: true, subagents: true });
	expect(request()).toEqual({ ...payload, service_tier: "ultrafast" });
	expect(request({ ...payload, service_tier: "priority" })).toBeUndefined();
	const lunaPayload = { model: luna.id };
	expect(h.events.before_provider_request({ payload: lunaPayload }, { ...h.ctx, model: luna }))
		.toEqual({ ...lunaPayload, service_tier: "priority" });
	await h.command("status");
	expect(h.notices.pop()).toContain("GPT-6.2 Sol: Ultrafast");
	await h.command("on");
	expect(request()).toEqual({ ...payload, service_tier: "priority" });
	await h.command("ultrafast");
	expect(request()).toEqual({ ...payload, service_tier: "ultrafast" });
	await h.command("off");
	expect(config()).toEqual({ enabledModels: [luna.id], subagents: true });
	expect(request()).toBeUndefined();
});

test("Ultrafast cannot be set for unsupported models, authentication, or subagent scope", async () => {
	for (const h of [harness([], sol), harness([], sol62, false), harness([], { ...sol62, provider: "other" })]) {
		await h.command("ultrafast");
		expect(h.notices.pop()).toMatch(/only supported|does not support/);
	}
	const h = harness([], sol62);
	for (const scope of ["all", "subagents", "luna"]) {
		await h.command(`${scope} ultrafast`);
		expect(h.notices.pop()).toContain("Usage:");
	}
	expect(existsSync(configPath)).toBe(false);
});

test("legacy routes, mismatched provider/API pairs, and API-key authentication remain unsupported", async () => {
	for (const model of [
		{ ...sol, api: "openai-codex-responses" },
		{ ...sol, provider: "openai-codex" },
		{ ...sol, api: "openai-completions" },
		{ ...luna, provider: "openai-codex", api: "openai-codex-responses" },
	]) {
		const h = harness([], model);
		expect(h.events.before_provider_request({ payload: { model: model.id } }, h.ctx)).toBeUndefined();
		await h.command("on");
		expect(h.notices.pop()).toContain("does not support");
		expect(existsSync(configPath)).toBe(false);
	}
	for (const model of [luna, sol]) {
		const h = harness([], model, false);
		expect(h.events.before_provider_request({ payload: { model: model.id } }, h.ctx)).toBeUndefined();
		await h.command("on");
		expect(h.notices.pop()).toContain("does not support");
		expect(existsSync(configPath)).toBe(false);
	}
});

test("parent payload safeguards preserve explicit tiers and reject mismatched or unsupported requests", () => {
	const h = harness([], luna);
	for (const payload of [{ model: luna.id, service_tier: "auto" }, { model: sol.id }, null, []]) {
		expect(h.events.before_provider_request({ payload }, h.ctx)).toBeUndefined();
	}
	expect(h.events.before_provider_request({ payload: { model: luna.id } }, { ...h.ctx, model: unsupported })).toBeUndefined();
});
