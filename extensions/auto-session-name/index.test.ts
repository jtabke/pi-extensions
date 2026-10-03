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
		sessionManager: { getSessionId: () => id, getBranch: () => branch },
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
		ui: { notify: (text: string) => notices.push(text) },
	};
	extension({
		on: (event: string, handler: Function) => events.set(event, handler),
		registerCommand: (_name: string, definition: any) => {
			command = definition;
		},
		getSessionName: () => name,
		setSessionName: (title: string) => {
			name = title;
			names.push(title);
			events.get("session_info_changed")!({ name: title }, ctx);
		},
	} as any);
	const emit = (event: string) => events.get(event)!({}, ctx);
	emit("session_start");
	return {
		calls,
		names,
		notices,
		branch,
		emit,
		command: (args: string) => command.handler(args, ctx),
		completions: (prefix: string) => command.getArgumentCompletions(prefix),
		get resolve() {
			const current = work;
			return (value = response()) => current.resolve(value);
		},
		reject: () => work.reject(new Error("private payload")),
		manual: (value: string | undefined) => {
			name = value;
			emit("session_info_changed");
		},
		auth: (value: boolean) => {
			authenticated = value;
		},
		switch: (next = "session-B") => {
			id = next;
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
	await f.command("");
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

test("first branch exchange, explicit model, bounded text and request options; one attempt", async () => {
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
		`User:\n${"u".repeat(1600)}\n\nAssistant:\n${("Implemented race protection\n" + "a".repeat(1000)).slice(0, 800)}`,
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

test("no complete first exchange or preexisting native name means no request", async () => {
	for (const kind of ["user-only", "empty", "second-user", "name"]) {
		const f = fixture(selected);
		if (kind === "user-only") f.branch.pop();
		if (kind === "empty") f.branch[0].message.content = " ";
		if (kind === "second-user")
			f.branch.splice(1, 0, {
				type: "message",
				message: { role: "user", content: "new exchange" },
			});
		if (kind === "name") f.setNativeName("Owner title");
		await f.emit("agent_settled");
		assert.equal(f.calls.length, 0);
	}
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

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
