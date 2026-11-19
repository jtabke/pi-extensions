import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LUNA_MODEL_ID = "gpt-6-luna";
// Only offer Ultrafast where advertised by the Codex subscription catalog.
const ULTRAFAST_MODEL_ID = "gpt-6.2-sol";
const CONFIG_PATH = join(getAgentDir(), "extensions", "fast.json");
const LEGACY_CONFIG_PATH = join(getAgentDir(), "extensions", "luna-fast.json");

type Payload = Record<string, unknown>;

type FastMode = "off" | "on" | "ultrafast";

type FastConfig = {
	enabledModels: Set<string>;
	ultrafast: boolean;
	subagents: boolean;
};

function getMode(config: FastConfig, modelId: string | undefined): FastMode {
	if (!modelId || !config.enabledModels.has(modelId)) return "off";
	return modelId === ULTRAFAST_MODEL_ID && config.ultrafast ? "ultrafast" : "on";
}

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEligible(ctx: ExtensionContext, model = ctx.model): boolean {
	return (
		model?.provider === "openai" &&
		model.api === "openai-responses" &&
		ctx.modelRegistry.isUsingOAuth(model)
	);
}

function migrateLegacyConfig(): void {
	if (existsSync(CONFIG_PATH) || !existsSync(LEGACY_CONFIG_PATH)) return;

	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		renameSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
	} catch (error) {
		console.error(`Warning: Could not migrate ${LEGACY_CONFIG_PATH} to ${CONFIG_PATH}: ${error}`);
	}
}

function readConfig(): FastConfig {
	const fallback: FastConfig = {
		enabledModels: new Set([LUNA_MODEL_ID]),
		ultrafast: false,
		subagents: false,
	};
	const configPath = existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH;
	if (!existsSync(configPath)) return fallback;

	try {
		const config = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof config === "object" && config !== null) {
			let enabledModels = fallback.enabledModels;
			if (
				"enabledModels" in config &&
				Array.isArray(config.enabledModels) &&
				config.enabledModels.every((model) => typeof model === "string")
			) {
				enabledModels = new Set(config.enabledModels);
			} else if ("enabled" in config && typeof config.enabled === "boolean") {
				// Preserve the original Luna-only configuration format.
				enabledModels = config.enabled ? new Set([LUNA_MODEL_ID]) : new Set();
			}

			return {
				enabledModels,
				ultrafast: "ultrafast" in config && config.ultrafast === true,
				subagents: "subagents" in config && typeof config.subagents === "boolean"
					? config.subagents
					: false,
			};
		}
	} catch (error) {
		console.error(`Warning: Could not read ${configPath}: ${error}`);
	}

	return fallback;
}

function writeConfig(config: FastConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
	const serialized = {
		enabledModels: [...config.enabledModels].sort(),
		...(getMode(config, ULTRAFAST_MODEL_ID) === "ultrafast" ? { ultrafast: true } : {}),
		subagents: config.subagents,
	};

	try {
		writeFileSync(temporaryPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf-8");
		renameSync(temporaryPath, CONFIG_PATH);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function setMode(target: { modelId?: string; subagents?: boolean }, mode: FastMode): void {
	const config = readConfig();
	if (target.modelId !== undefined) {
		if (mode === "off") config.enabledModels.delete(target.modelId);
		else config.enabledModels.add(target.modelId);
		if (target.modelId === ULTRAFAST_MODEL_ID) config.ultrafast = mode === "ultrafast";
	}
	if (target.subagents) config.subagents = mode === "on";
	writeConfig(config);
}

function modeLabel(mode: FastMode): string {
	return mode === "on" ? "Fast" : mode === "ultrafast" ? "Ultrafast" : "Default";
}

function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
	if (!ctx.hasUI) return;
	if (!isEligible(ctx, model)) {
		ctx.ui.setStatus("fast", undefined);
		return;
	}
	const mode = getMode(readConfig(), model?.id);
	if (ctx.mode !== "tui") {
		ctx.ui.setStatus("fast", mode === "off" ? undefined : modeLabel(mode));
		return;
	}
	const color = mode === "off" ? "dim" : mode === "on" ? "accent" : "warning";
	ctx.ui.setStatus("fast", ctx.ui.theme.fg(color, modeLabel(mode)));
}

async function pickSpeed(ctx: ExtensionContext, modelId: string, modelName: string, available: boolean): Promise<void> {
	const current = getMode(readConfig(), modelId);
	const modes: FastMode[] = ["off"];
	if (available) {
		modes.push("on");
		if (modelId === ULTRAFAST_MODEL_ID) modes.push("ultrafast");
	}
	// Focus the current speed so accepting the first option doesn't change it.
	const choices = modes.includes(current) ? [current, ...modes.filter((mode) => mode !== current)] : modes;
	const labels = choices.map((mode) => `${mode === current ? "✓ " : ""}${modeLabel(mode)}${mode === "ultrafast" ? " · higher usage" : ""}`);
	const choice = await ctx.ui.select(
		`Speed for ${modelName} · saved across sessions${available ? "" : " · unavailable (reset only)"}`,
		labels,
	);
	const mode = choice === undefined ? undefined : choices[labels.indexOf(choice)];
	if (mode === undefined || mode === current) return;
	setMode({ modelId }, mode);
	updateStatus(ctx);
	ctx.ui.notify(`${modelName} speed set to ${modeLabel(mode)}.`, "info");
}

async function pickModelSpeed(ctx: ExtensionContext, filter: string): Promise<void> {
	const search = filter || await ctx.ui.input("Find a model by name or ID (Enter for all)", "e.g. 6.2 sol");
	if (search === undefined) return;
	const config = readConfig();
	const available = new Map(ctx.modelRegistry.getAvailable()
		.filter((model) => isEligible(ctx, model)).map((model) => [model.id, model.name]));
	// Saved models remain resettable even if authentication or availability changes.
	const ids = [...new Set([...available.keys(), ...config.enabledModels])].sort().filter((id) => {
		const text = `${id} ${available.get(id) ?? ""}`.toLowerCase();
		return search.toLowerCase().trim().split(/\s+/).every((word) => text.includes(word));
	});
	if (ids.length === 0) {
		ctx.ui.notify("No matching Fast settings.", "info");
		return;
	}
	const labels = ids.map((id) => `${id} · ${modeLabel(getMode(config, id))}${available.has(id) ? "" : " (unavailable)"}`);
	const choice = ids.length === 1 ? labels[0] : await ctx.ui.select("Choose a model to edit", labels);
	const modelId = choice === undefined ? undefined : ids[labels.indexOf(choice)];
	if (modelId !== undefined) await pickSpeed(ctx, modelId, available.get(modelId) ?? modelId, available.has(modelId));
}

async function pickSubagentFast(ctx: ExtensionContext): Promise<void> {
	const enabled = readConfig().subagents;
	const labels = enabled ? ["✓ On", "Off"] : ["✓ Off", "On"];
	const choice = await ctx.ui.select("Subagent Fast default · explicit per-launch settings take precedence", labels);
	if (choice !== labels[1]) return;
	setMode({ subagents: true }, enabled ? "off" : "on");
	ctx.ui.notify(`Saved subagent Fast setting: ${enabled ? "off" : "on"}.`, "info");
}

export default function fast(pi: ExtensionAPI): void {
	migrateLegacyConfig();

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || !isEligible(ctx) || !isPayload(event.payload)) return;
		if (event.payload.model !== model.id || "service_tier" in event.payload) return;
		const mode = getMode(readConfig(), model.id);
		if (mode === "off") return;

		return {
			...event.payload,
			service_tier: mode === "ultrafast" ? "ultrafast" : "priority",
		};
	});

	pi.on("tool_call", (event) => {
		if (
			event.toolName !== "subagent" ||
			!readConfig().subagents ||
			!isPayload(event.input) ||
			event.input.action !== undefined
		) return;

		const input = event.input;
		if (input.options !== undefined && !isPayload(input.options)) return;
		const options = input.options ?? {};
		const launchesChild =
			(typeof input.agent === "string" && typeof input.task === "string") ||
			input.workflow === true ||
			(typeof input.workflow === "string" && input.workflow.trim().length > 0) ||
			typeof options.script === "string";
		if (!launchesChild || input.fast !== undefined || options.fast !== undefined) return;

		// Current pi-subagents lowers options into launch params during execute().
		input.options = { ...options, fast: true };
	});

	pi.registerCommand("fast", {
		description: "Pick a speed, or use on, off, ultrafast, or status for the current model",
		getArgumentCompletions: (prefix) => {
			const matches = [
				{ value: "on", label: "on", description: "Select Fast for the current model" },
				{ value: "off", label: "off", description: "Reset the current model to Default" },
				{ value: "ultrafast", label: "ultrafast", description: "Select Ultrafast for GPT-6.2 Sol" },
				{ value: "status", label: "status", description: "Show the saved speed and subagent setting" },
				{ value: "models", label: "models", description: "Find and edit another model" },
				{ value: "subagents", label: "subagents", description: "Configure the subagent Fast default" },
			].filter(({ value }) => value.startsWith(prefix.trimStart().toLowerCase()));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const parts = input.toLowerCase().split(/\s+/).filter(Boolean);
			if (!input || parts[0] === "models" || input.toLowerCase() === "subagents") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Use /fast on|off|ultrafast|status or /fast subagents on|off|status without a UI.", "warning");
					return;
				}
				if (parts[0] === "models") {
					await pickModelSpeed(ctx, input.slice("models".length).trim());
				} else if (parts[0] === "subagents") {
					await pickSubagentFast(ctx);
				} else if (ctx.model && isEligible(ctx)) {
					await pickSpeed(ctx, ctx.model.id, ctx.model.name, true);
				} else {
					ctx.ui.notify("The current model or authentication does not support this Fast mode. Use /fast models to manage other models.", "warning");
				}
				return;
			}
			const target = parts[0] === "luna" || parts[0] === "subagents" || parts[0] === "all"
				? parts[0]
				: "current";
			const action = (target === "current" ? parts[0] : parts[1]) || "on";
			const usage = "Usage: /fast [on | off | status | ultrafast] | /fast models [filter] | /fast all [on | off | status] | /fast luna [on | off | status] | /fast subagents [on | off | status]";

			if (parts.length > (target === "current" ? 1 : 2) || (
				action !== "on" && action !== "off" && action !== "status" && !(target === "current" && action === "ultrafast")
			)) {
				ctx.ui.notify(usage, "warning");
				return;
			}

			const usesCurrentModel = target === "current" || target === "all";
			const modelId = target === "luna" ? LUNA_MODEL_ID : usesCurrentModel ? ctx.model?.id : undefined;
			const modelName = target === "luna" ? "Luna" : ctx.model?.name ?? "Current model";
			const subagents = target === "subagents" || target === "all";

			if (action === "status") {
				const config = readConfig();
				const lines: string[] = [];
				if (target !== "subagents") {
					const status = usesCurrentModel && !isEligible(ctx)
						? "unsupported" : getMode(config, modelId);
					lines.push(`Saved speed for ${modelName}: ${status === "unsupported" ? status : modeLabel(status)}.`);
				}
				if (target !== "luna") lines.push(`Saved subagent Fast setting: ${config.subagents ? "on" : "off"}.`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (usesCurrentModel && !isEligible(ctx)) {
				ctx.ui.notify("The current model or authentication does not support this Fast mode.", "warning");
				return;
			}
			if (action === "ultrafast" && modelId !== ULTRAFAST_MODEL_ID) {
				ctx.ui.notify("Ultrafast is only supported for GPT-6.2 Sol.", "warning");
				return;
			}
			setMode({ modelId, subagents }, action);
			if (modelId !== undefined) updateStatus(ctx);
			const lines: string[] = [];
			if (modelId !== undefined) lines.push(`${modelName} speed set to ${modeLabel(action)}.`);
			if (subagents) lines.push(`Saved subagent Fast setting: ${action}.`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
