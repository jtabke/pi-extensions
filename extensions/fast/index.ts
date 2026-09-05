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

const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
const LUNA_MODEL_ID = "gpt-5.6-luna";
const SERVICE_TIER = "priority";
const CONFIG_PATH = join(getAgentDir(), "extensions", "fast.json");
const LEGACY_CONFIG_PATH = join(getAgentDir(), "extensions", "luna-fast.json");

type Payload = Record<string, unknown>;

type FastConfig = {
	enabledModels: Set<string>;
	subagents: boolean;
};

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEligible(ctx: ExtensionContext, model = ctx.model): boolean {
	return (
		model?.provider === PROVIDER_ID &&
		model.api === API_ID &&
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
		subagents: config.subagents,
	};

	try {
		writeFileSync(temporaryPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf-8");
		renameSync(temporaryPath, CONFIG_PATH);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function setEnabled(target: { modelId?: string; subagents?: boolean }, enabled: boolean): void {
	const config = readConfig();
	if (target.modelId !== undefined) {
		if (enabled) config.enabledModels.add(target.modelId);
		else config.enabledModels.delete(target.modelId);
	}
	if (target.subagents) config.subagents = enabled;
	writeConfig(config);
}

async function configureFast(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Use /fast on, /fast off, or /fast subagents on|off when no configuration UI is available.", "warning");
		return;
	}
	while (true) {
		const config = readConfig();
		const availableIds = new Set(ctx.modelRegistry.getAvailable()
			.filter((model) => isEligible(ctx, model)).map((model) => model.id));
		// Keep unavailable saved models visible so their settings can be disabled.
		const ids = [...new Set([...availableIds, ...config.enabledModels])].sort();
		const labels = ids.map((id) => {
			const current = id === ctx.model?.id && ctx.model.provider === PROVIDER_ID;
			return `${id}: ${config.enabledModels.has(id) ? "On" : "Off"}${current ? " (current parent)" : ""}${availableIds.has(id) ? "" : " (unavailable)"}`;
		});
		const subagentLabel = `Subagent-wide setting: ${config.subagents ? "On" : "Off"}`;
		const choice = await ctx.ui.select("Fast saved settings — changes persist; priority may increase quota/cost", [
			...labels, subagentLabel, "Done",
		]);
		if (choice === undefined || choice === "Done") return;
		const subagents = choice === subagentLabel;
		const modelId = ids[labels.indexOf(choice)];
		if (!subagents && modelId === undefined) continue;
		const currentEnabled = subagents ? config.subagents : config.enabledModels.has(modelId);
		const title = subagents
			? "Saved subagent setting — explicit fast:true/false takes precedence"
			: `Saved Fast setting for ${modelId}`;
		const value = await ctx.ui.select(title, currentEnabled ? ["On", "Off"] : ["Off", "On"]);
		if (value === undefined) continue;
		const enabled = value === "On";
		if (enabled && !subagents && !availableIds.has(modelId)) {
			ctx.ui.notify("This model is unavailable or does not have supported authentication. You may disable its saved setting.", "warning");
			continue;
		}
		setEnabled({ modelId, subagents }, enabled);
	}
}

export default function fast(pi: ExtensionAPI): void {
	migrateLegacyConfig();

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			!model ||
			!readConfig().enabledModels.has(model.id) ||
			!isEligible(ctx) ||
			!isPayload(event.payload)
		) return;
		if (event.payload.model !== model.id || "service_tier" in event.payload) return;

		return {
			...event.payload,
			service_tier: SERVICE_TIER,
		};
	});

	pi.on("tool_call", (event) => {
		if (
			event.toolName !== "subagent" ||
			!readConfig().subagents ||
			!isPayload(event.input) ||
			typeof event.input.workflowScript !== "string"
		) return;

		if (event.input.fast === undefined) event.input.fast = true;
	});

	pi.registerCommand("fast", {
		description: "Configure Fast mode, or use on/off/status for the current model, Luna, or subagents",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				await configureFast(ctx);
				return;
			}
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const target = parts[0] === "luna" || parts[0] === "subagents" || parts[0] === "all"
				? parts[0]
				: "current";
			const action = (target === "current" ? parts[0] : parts[1]) || "on";
			const usage = "Usage: /fast [on | off | status] | /fast all [on | off | status] | /fast luna [on | off | status] | /fast subagents [on | off | status]";

			if (parts.length > (target === "current" ? 1 : 2) || !["on", "off", "status"].includes(action)) {
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
						? "unsupported" : modelId && config.enabledModels.has(modelId) ? "on" : "off";
					lines.push(`Saved Fast setting for ${modelName}: ${status}.`);
				}
				if (target !== "luna") lines.push(`Saved subagent Fast setting: ${config.subagents ? "on" : "off"}.`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (usesCurrentModel && !isEligible(ctx)) {
				ctx.ui.notify("The current model or authentication does not support this Fast mode.", "warning");
				return;
			}
			setEnabled({ modelId, subagents }, action === "on");
			const label = target === "subagents" ? "subagents" : `${modelName}${subagents ? " and subagents" : ""}`;
			ctx.ui.notify(`Saved Fast setting is ${action} for ${label}.`, "info");
		},
	});
}
