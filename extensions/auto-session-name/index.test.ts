import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-name-test-"));
mock.module("@earendil-works/pi-coding-agent", {
	namedExports: { getAgentDir: () => agentDir },
});
const { default: extension } = await import("./index.ts");
const configPath = join(agentDir, "extensions", "auto-session-name.json");

type Response = {
	content: { type: string; text: string }[];
	stopReason: string;
};
const response = (
	text = "Fix Session Naming Races",
	stopReason = "stop",
): Response => ({ content: [{ type: "text", text }], stopReason });
function deferred() {
	let resolve!: (value: Response) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Response>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture(config?: unknown) {
	rmSync(join(agentDir, "extensions"), { recursive: true, force: true });
	if (config !== undefined) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(configPath, JSON.stringify(config));
	}
	const events = new Map<string, Function>();
	let command: any;
	let id = "session-A";
	let name: string | undefined;
	let authenticated = true;
	let hasUI = true;
	let selection: string | undefined;
	let onSelect: (() => void) | undefined;
	const dialogs: { title: string; options: string[] }[] = [];
	let work = deferred();
	const calls: { model: any; input: any; options: any }[] = [];
	const names: string[] = [];
	const notices: string[] = [];
	const model = { provider: "chosen", id: "family/title-model" };
	const branch: any[] = [
		{
			type: "message",
			message: { role: "user", content: "Fix session naming" },
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "Implemented race protection" },
				],
				stopReason: "stop",
			},
		},
	];
	const ctx = {
		model: { provider: "wrong", id: "never-use" },
		sessionManager: { getSessionId: () => id, getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				provider === model.provider && modelId === model.id ? model : undefined,
			hasConfiguredAuth: () => authenticated,
			getAvailable: () => (authenticated ? [model] : []),
			streamSimple: (selected: any, input: any, options: any) => {
				calls.push({ model: selected, input, options });
				return { result: () => work.promise };
			},
		},
		get hasUI() { return hasUI; },
		ui: {
			notify: (text: string) => notices.push(text),
			select: async (title: string, options: string[]) => {
				dialogs.push({ title, options });
				onSelect?.();
				return selection;
			},
		},
	};
	const install = () => extension({
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		on: (event: string, handler: Function) => events.set(event, handler),
		registerCommand: (_name: string, definition: any) => {
			command = definition;
		},
		getSessionName: () => name,
		setSessionName: (title: string) => {
			name = title;
			branch.push({ type: "session_info", name: title });
			names.push(title);
			events.get("session_info_changed")!({ name: title }, ctx);
		},
	} as any);
	install();
	const emitRaw = (event: string, data: any = {}) => events.get(event)!(data, ctx);
	const emit = (event: string, data: any = {}) => {
		const result = emitRaw(event, data);
		// Drain detached naming completions in assertions, not in production handlers.
		return event === "agent_settled"
			? Promise.resolve(result).then(() => new Promise<void>((resolve) => setImmediate(resolve)))
			: result;
	};
	emit("session_start");
	return {
		calls,
		names,
		notices,
		nextResponse: () => { work = deferred(); },
		addTurns: (count: number) => {
			for (let i = 0; i < count; i++) {
				branch.push(
					{ type: "message", message: { role: "user", content: "Discuss database migrations" } },
					{ type: "message", message: { role: "assistant", content: "Plan database migration steps", stopReason: "stop" } },
				);
			}
		},
		branch,
		dialogs,
		pick: (value?: string, callback?: () => void) => {
			selection = value;
			onSelect = callback;
		},
		ui: (value: boolean) => { hasUI = value; },
		emit,
		emitRaw,
		reopen: () => { emit("session_shutdown"); install(); emit("session_start"); },
		command: (args: string) => command.handler(args, ctx),
		completions: (prefix: string) => command.getArgumentCompletions(prefix),
		get resolve() {
			const current = work;
			return (value = response()) => current.resolve(value);
		},
		reject: () => work.reject(new Error("private payload")),
		manual: (value: string | undefined) => {
			name = value;
			branch.push({ type: "session_info", name: value });
			emit("session_info_changed", { name: value });
		},
		auth: (value: boolean) => {
			authenticated = value;
		},
		switch: (next = "session-B") => {
			id = next;
			for (let i = branch.length - 1; i >= 0; i--) {
				if (branch[i].type === "session_info" || branch[i].customType === "auto-session-name") branch.splice(i, 1);
			}
			name = undefined;
			work = deferred();
			emit("session_start");
		},
		setNativeName: (value: string) => {
			name = value;
		},
	};
}
const selected = { provider: "chosen", model: "family/title-model" };

test("explicit model command persists, completes, rejects invalid choices, and disables without fallback", async () => {
	const f = fixture();
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 0);
	assert.throws(() => readFileSync(configPath));
	await f.command("status");
	assert.match(f.notices.at(-1)!, /disabled/);
	assert.deepEqual(f.completions("chosen/"), [
		{ value: "chosen/family/title-model", label: "chosen/family/title-model" },
	]);
	await f.command("chosen/family/title-model");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), selected);
	assert.equal(f.calls.length, 0);
	for (const input of ["unknown/model", "chosen/", "bad syntax"])
		await f.command(input);
	f.auth(false);
	await f.command("chosen/family/title-model");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), selected);
	await f.command("status");
	assert.match(f.notices.at(-1)!, /chosen\/family\/title-model/);
	await f.command("off");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		provider: null,
		model: null,
	});
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 0);
});

test("no-argument command opens model picker and saves selection without a provider request", async () => {
	const f = fixture();
	f.pick("chosen/family/title-model");
	await f.command("");
	assert.deepEqual(f.dialogs, [{
		title: "Choose auto-name model",
		options: ["chosen/family/title-model"],
	}]);
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), selected);
	assert.equal(f.calls.length, 0);
	await f.command("status");
	assert.equal(f.dialogs.length, 1);
	const settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	assert.deepEqual(f.names, ["Fix Session Naming Races"]);
});

test("picker cancellation preserves disabled or selected config", async () => {
	for (const config of [undefined, selected]) {
		const f = fixture(config);
		await f.command("");
		assert.equal(f.dialogs.length, 1);
		assert.equal(f.calls.length, 0);
		if (config) assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), config);
		else assert.throws(() => readFileSync(configPath));
	}
});

test("empty model list, noninteractive status, and lost authentication do not save a choice", async () => {
	const f = fixture();
	f.auth(false);
	await f.command("");
	assert.equal(f.dialogs.length, 0);
	assert.match(f.notices.at(-1)!, /no authenticated models/);
	f.ui(false);
	await f.command("");
	assert.equal(f.dialogs.length, 0);
	assert.match(f.notices.at(-1)!, /disabled/);
	f.ui(true);
	f.auth(true);
	f.pick("chosen/family/title-model", () => f.auth(false));
	await f.command("");
	assert.match(f.notices.at(-1)!, /authentication not configured/);
	assert.throws(() => readFileSync(configPath));
	assert.equal(f.calls.length, 0);
});

test("invalid configs warn, stay unchanged, and never fall back", async () => {
	const warnings: string[] = [];
	const warn = mock.method(console, "warn", (text: string) =>
		warnings.push(text),
	);
	try {
		for (const config of [
			{ model: "oops" },
			{ ...selected, extra: true },
			"x".repeat(5000),
			null,
		]) {
			const f = fixture(config);
			const before = readFileSync(configPath, "utf8");
			await f.emit("agent_settled");
			assert.equal(f.calls.length, 0);
			assert.equal(readFileSync(configPath, "utf8"), before);
		}
		assert.equal(warnings.length, 4);
	} finally {
		warn.mock.restore();
	}
});

test("first user only, explicit model, bounded text and request options; one attempt", async () => {
	const f = fixture(selected);
	f.branch.unshift({ type: "custom", data: "secret metadata" });
	f.branch[1].message.content = [
		{ type: "image", data: "private image" },
		{ type: "text", text: "u".repeat(2000) },
	];
	f.branch[2].message.content.push({ type: "text", text: "a".repeat(1000) });
	f.branch.push({
		type: "message",
		message: { role: "user", content: "later secret" },
	});
	const settled = f.emit("agent_settled");
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	const call = f.calls[0];
	assert.deepEqual(call.model, {
		provider: "chosen",
		id: "family/title-model",
	});
	assert.equal(
		call.input.messages[0].content,
		`User:\n${"u".repeat(1600)}`,
	);
	assert.match(call.input.systemPrompt, /3-8-word/);
	assert.deepEqual(Object.keys(call.options).sort(), [
		"cacheRetention",
		"maxRetries",
		"maxTokens",
		"reasoning",
		"signal",
		"timeoutMs",
	]);
	assert.equal(call.options.maxTokens, 96);
	assert.equal(call.options.timeoutMs, 15000);
	assert.equal(call.options.maxRetries, 0);
	assert.equal(call.options.cacheRetention, "none");
	assert.equal(call.options.reasoning, "minimal");
	f.resolve();
	await settled;
	assert.deepEqual(f.names, ["Fix Session Naming Races"]);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
});

test("empty user text or preexisting native name means no request", async () => {
	for (const kind of ["empty", "name"]) {
		const f = fixture(selected);
		if (kind === "empty") f.branch[0].message.content = " ";
		if (kind === "name") f.setNativeName("Owner title");
		await f.emit("agent_settled");
		assert.equal(f.calls.length, 0);
	}
});

test("first nonempty user triggers naming before persistence or assistant text without blocking", async () => {
	const f = fixture(selected);
	f.branch.length = 0;
	const empty = { role: "user", content: [{ type: "image", data: "private" }, { type: "text", text: " " }] };
	await f.emit("message_end", { message: empty });
	assert.equal(f.calls.length, 0);
	f.branch.push({ type: "message", message: empty });
	const user = { role: "user", content: "Build database migrations" };
	await f.emit("message_end", { message: user });
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].input.messages[0].content, "User:\nBuild database migrations");
	f.branch.push({ type: "message", message: user });
	f.resolve(response("Build Database Migration Steps"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(f.names, ["Build Database Migration Steps"]);
	f.addTurns(4);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	f.addTurns(1);
	f.nextResponse();
	const settled = f.emit("agent_settled");
	f.resolve(response("Build Database Migration Steps"));
	await settled;
	assert.equal(f.calls.length, 2);
});

test("initial naming skips empty users and ignores assistant errors and later users", async () => {
	const f = fixture(selected);
	f.branch[1].message.stopReason = "aborted";
	f.branch.unshift({ type: "message", message: { role: "user", content: " " } });
	f.addTurns(1);
	const settled = f.emit("agent_settled");
	assert.equal(f.calls[0].input.messages[0].content, "User:\nFix session naming");
	f.resolve();
	await settled;
});

test("normalization uses first nonempty text line and rejects empty/error/aborted", async () => {
	for (const [text, reason, expected] of [
		['\n  **"Fix\t Naming"**\nIgnore second line', "stop", "Fix Naming"],
		["> ‘Fix\u0000 naming’", "stop", "Fix naming"],
		["x".repeat(100), "stop", "x".repeat(80)],
		["```", "stop", undefined],
		[" \n ", "stop", undefined],
		["Bad title", "error", undefined],
		["Bad title", "aborted", undefined],
	] as const) {
		const f = fixture(selected);
		const settled = f.emit("agent_settled");
		f.resolve(response(text, reason));
		await settled;
		assert.deepEqual(f.names, expected ? [expected] : []);
	}
});

test("manual name and name clearing retire pending work even when provider ignores abort", async () => {
	for (const title of ["Manual title", undefined]) {
		const f = fixture(selected);
		const settled = f.emit("agent_settled");
		f.manual(title);
		await settled;
		assert.equal(f.calls[0].options.signal.aborted, true);
		f.resolve();
		await Promise.resolve();
		await f.emit("agent_settled");
		assert.deepEqual(f.names, []);
		assert.equal(f.calls.length, 1);
	}
});

test("switch and same-ID replacement retire stale request; new instance can name", async () => {
	for (const id of ["session-B", "session-A"]) {
		const f = fixture(selected);
		const settled = f.emit("agent_settled");
		const oldResolve = f.resolve;
		// Capture the old provider promise independently of the fixture's new work.
		const oldSignal = f.calls[0].options.signal;
		f.switch(id);
		await settled;
		assert.equal(oldSignal.aborted, true);
		oldResolve(response("Stale Session Title"));
		await Promise.resolve();
		assert.deepEqual(f.names, []);
		const next = f.emit("agent_settled");
		f.resolve(response("New Session Title"));
		await next;
		assert.deepEqual(f.names, ["New Session Title"]);
		assert.equal(f.calls.length, 2);
	}
});

test("failure is contained; reselection retries only at settled; off/shutdown cancel", async () => {
	const f = fixture(selected);
	const failed = f.emit("agent_settled");
	f.reject();
	await failed;
	assert.deepEqual(f.names, []);
	assert.match(f.notices.at(-1)!, /request failed/);
	assert.ok(!f.notices.some((text) => text.includes("private payload")));
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	f.switch();
	f.auth(false);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	f.auth(true);
	await f.command("chosen/family/title-model");
	assert.equal(f.calls.length, 1);
	const pending = f.emit("agent_settled");
	await f.command("off");
	await pending;
	assert.equal(f.calls[1].options.signal.aborted, true);
	f.resolve();
	await Promise.resolve();
	assert.deepEqual(f.names, []);
	await f.command("chosen/family/title-model");
	f.switch();
	const shutdown = f.emit("agent_settled");
	f.emit("session_shutdown");
	await shutdown;
	assert.equal(f.calls[2].options.signal.aborted, true);
});

test("explicit model reselection retires pending work without sending from command", async () => {
	const f = fixture(selected);
	const settled = f.emit("agent_settled");
	await f.command("chosen/family/title-model");
	await settled;
	assert.equal(f.calls[0].options.signal.aborted, true);
	assert.equal(f.calls.length, 1);
	f.resolve(response("Retired Provider Title"));
	await Promise.resolve();
	assert.deepEqual(f.names, []);
});

test("timeout bounds settlement when provider ignores abort", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(selected);
	const settled = f.emit("agent_settled");
	t.mock.timers.tick(15000);
	await settled;
	assert.equal(f.calls[0].options.signal.aborted, true);
	f.resolve();
	await Promise.resolve();
	assert.deepEqual(f.names, []);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
});

test("failed atomic write preserves prior choice and cleans owned temporary file", async () => {
	const f = fixture(selected);
	rmSync(configPath);
	mkdirSync(configPath);
	await f.command("off");
	assert.match(f.notices.at(-1)!, /previous choice retained/);
	assert.deepEqual(readdirSync(join(agentDir, "extensions")), [
		"auto-session-name.json",
	]);
	const settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	assert.equal(f.calls.length, 1);
});

test("refines after five more user turns, then every five; unchanged titles do not emit changes", async () => {
	const f = fixture(selected);
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	f.addTurns(4);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	f.addTurns(1);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.emitRaw("agent_settled");
	assert.equal(f.calls.length, 2);
	assert.match(f.calls[1].input.systemPrompt, /Rename only if/);
	assert.match(f.calls[1].input.messages[0].content, /Current title:\nFix Session Naming Races/);
	assert.match(f.calls[1].input.messages[0].content, /database migrations/);
	assert.ok(!f.calls[1].input.messages[0].content.includes("Implemented race protection"));
	f.resolve(response("Plan Database Migration Steps"));
	await settled;
	assert.deepEqual(f.names, ["Fix Session Naming Races", "Plan Database Migration Steps"]);
	f.addTurns(4);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	f.addTurns(1);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.resolve(response("Plan Database Migration Steps"));
	await settled;
	assert.equal(f.calls.length, 3);
	assert.equal(f.names.length, 2);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 3);
});

test("refinement excludes private blocks and bounds recent text", async () => {
	const f = fixture(selected);
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	f.addTurns(5);
	f.branch.at(-2).message.content = [{ type: "image", data: "private image" }, { type: "text", text: "u".repeat(2000) }];
	f.branch.at(-1).message.content = [{ type: "thinking", thinking: "private thought" }, { type: "text", text: "a".repeat(1000) }];
	f.branch.push({ type: "message", message: { role: "toolResult", content: "private tool" } });
	f.nextResponse();
	settled = f.emit("agent_settled");
	const excerpt = f.calls[1].input.messages[0].content;
	assert.ok(excerpt.includes("u".repeat(1600)));
	assert.ok(!excerpt.includes("u".repeat(1601)));
	assert.ok(excerpt.includes("a".repeat(800)));
	assert.ok(!excerpt.includes("a".repeat(801)));
	assert.ok(!excerpt.includes("private"));
	f.resolve();
	await settled;
});

test("manual changes, off, replacement and shutdown cancel refinement; manual names stay protected", async () => {
	for (const action of ["manual", "clear", "off", "switch", "shutdown"]) {
		const f = fixture(selected);
		let settled = f.emit("agent_settled");
		f.resolve();
		await settled;
		f.addTurns(5);
		f.nextResponse();
		settled = f.emit("agent_settled");
		const resolve = f.resolve;
		if (action === "manual") f.manual("Owner title");
		if (action === "clear") f.manual(undefined);
		if (action === "off") await f.command("off");
		if (action === "switch") f.switch();
		if (action === "shutdown") f.emit("session_shutdown");
		await settled;
		assert.equal(f.calls[1].options.signal.aborted, true);
		resolve(response("Stale Refined Session Title"));
		await Promise.resolve();
		assert.deepEqual(f.names, ["Fix Session Naming Races"]);
		if (action === "manual" || action === "clear") {
			f.addTurns(20);
			await f.command("chosen/family/title-model");
			await f.emit("agent_settled");
			assert.equal(f.calls.length, 2);
		}
	}
});

test("failed refinement keeps title and waits five more user turns", async () => {
	const f = fixture(selected);
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	f.addTurns(5);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.reject();
	await settled;
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	assert.equal(f.names.length, 1);
	f.addTurns(5);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.resolve(response("Plan Database Migration Steps"));
	await settled;
	assert.equal(f.calls.length, 3);
	assert.equal(f.names.length, 2);
});

test("reopening an automatic title restores the five-turn schedule", async () => {
	const f = fixture(selected);
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	f.addTurns(4);
	f.reopen();
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	f.addTurns(1);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.resolve(response("Plan Database Migration Steps"));
	await settled;
	assert.deepEqual(f.names, ["Fix Session Naming Races", "Plan Database Migration Steps"]);
	f.reopen();
	f.addTurns(4);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	f.addTurns(1);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.resolve(response("Plan Database Migration Steps"));
	await settled;
	assert.equal(f.calls.length, 3);
	assert.equal(f.names.length, 2);
});

test("reopening after a failed refinement preserves its five-turn wait", async () => {
	const f = fixture(selected);
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	f.addTurns(5);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.reject();
	await settled;
	f.reopen();
	f.addTurns(4);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	f.addTurns(1);
	f.nextResponse();
	settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	assert.equal(f.calls.length, 3);
});

test("reopening protects manual renames, same-title assignments, clearing, and unmarked titles", async () => {
	for (const title of ["Owner title", "Fix Session Naming Races", undefined]) {
		const f = fixture(selected);
		const settled = f.emit("agent_settled");
		f.resolve();
		await settled;
		f.manual(title);
		f.reopen();
		f.addTurns(20);
		await f.command("chosen/family/title-model");
		await f.emit("agent_settled");
		assert.equal(f.calls.length, 1);
	}
	const f = fixture(selected);
	f.setNativeName("Legacy Automatic Or Manual Title");
	f.reopen();
	f.addTurns(20);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 0);
});

test("a later native name entry protects manual changes made without this extension", async () => {
	const f = fixture(selected);
	const settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	// Even assigning the same title must remove automatic ownership.
	f.branch.push({ type: "session_info", name: "Fix Session Naming Races" });
	f.reopen();
	f.addTurns(20);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
});

test("minor changes keep the exact title without emitting a rename", async () => {
	const f = fixture(selected);
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	for (let i = 0; i < 5; i++) f.branch.push(
		{ type: "message", message: { role: "user", content: "Add a session naming regression test" } },
		{ type: "message", message: { role: "assistant", content: "Test manual session name protection", stopReason: "stop" } },
	);
	f.nextResponse();
	settled = f.emit("agent_settled");
	assert.match(f.calls[1].input.messages[0].content, /session naming regression test/);
	assert.match(f.calls[1].input.systemPrompt, /minor changes/);
	f.resolve();
	await settled;
	assert.equal(f.calls.length, 2);
	assert.deepEqual(f.names, ["Fix Session Naming Races"]);
});

test("refinement returns immediately and prevents overlapping requests", async () => {
	const f = fixture(selected);
	const initial = f.emit("agent_settled");
	f.resolve();
	await initial;
	f.addTurns(5);
	f.nextResponse();
	assert.equal(f.emitRaw("agent_settled"), undefined);
	assert.equal(f.calls.length, 2);
	// The provider is still unresolved, but settlement has returned.
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	assert.deepEqual(f.names, ["Fix Session Naming Races"]);
	f.resolve(response("Plan Database Migration Steps"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(f.names, ["Fix Session Naming Races", "Plan Database Migration Steps"]);
});

test("checks not yet due do not read assistant text; due checks read only recent text", async () => {
	const f = fixture(selected);
	const initial = f.emit("agent_settled");
	f.resolve();
	await initial;
	Object.defineProperty(f.branch[1].message, "content", {
		get() { throw new Error("Old assistant text must not be read"); },
	});
	// These entries still count as user turns, but do not yet trigger refinement.
	f.addTurns(4);
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 1);
	assert.deepEqual(f.notices, []);
	f.addTurns(1);
	f.nextResponse();
	const settled = f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	assert.match(f.calls[1].input.messages[0].content, /database migrations/);
	f.resolve();
	await settled;
	assert.deepEqual(f.notices, []);
});

test("unchanged refinement writes only its scheduled check; changed titles save ownership", async () => {
	const f = fixture(selected);
	const states = () => f.branch.filter((entry) => entry.customType === "auto-session-name");
	let settled = f.emit("agent_settled");
	f.resolve();
	await settled;
	assert.equal(states().length, 1);
	f.addTurns(5);
	f.nextResponse();
	settled = f.emit("agent_settled");
	assert.equal(states().length, 2);
	f.resolve();
	await settled;
	assert.equal(states().length, 2);
	assert.deepEqual(states().at(-1).data, { title: "Fix Session Naming Races", nextRefinement: 11 });
	f.reopen();
	await f.emit("agent_settled");
	assert.equal(f.calls.length, 2);
	f.addTurns(5);
	f.nextResponse();
	settled = f.emit("agent_settled");
	assert.equal(states().length, 3);
	f.resolve(response("Plan Database Migration Steps"));
	await settled;
	assert.equal(states().length, 4);
	assert.deepEqual(states().at(-1).data, { title: "Plan Database Migration Steps", nextRefinement: 16 });
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
