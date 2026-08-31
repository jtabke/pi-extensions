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

function isEligible(ctx: ExtensionContext): boolean {
	const model = ctx.model;
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

function setModelEnabled(modelId: string, enabled: boolean): void {
	const config = readConfig();
	if (enabled) config.enabledModels.add(modelId);
	else config.enabledModels.delete(modelId);
	writeConfig(config);
}

function setSubagentsEnabled(enabled: boolean): void {
	const config = readConfig();
	config.subagents = enabled;
	writeConfig(config);
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
		description: "Control Fast mode for the current model, Luna, or subagents",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const target = parts[0] === "luna" || parts[0] === "subagents" ? parts[0] : "current";
			const action = (target === "current" ? parts[0] : parts[1]) || "on";
			const usage = "Usage: /fast [on | off | status] | /fast luna [on | off | status] | /fast subagents [on | off | status]";

			if (parts.length > (target === "current" ? 1 : 2)) {
				ctx.ui.notify(usage, "warning");
				return;
			}

			if (target === "subagents") {
				if (action === "status") {
					const enabled = readConfig().subagents;
					ctx.ui.notify(`Subagent Fast mode is ${enabled ? "on" : "off"}.`, "info");
					return;
				}

				if (action === "on" || action === "off") {
					const enabled = action === "on";
					setSubagentsEnabled(enabled);
					ctx.ui.notify(`Subagent Fast mode is ${enabled ? "on" : "off"}.`, "info");
					return;
				}
			} else if (target === "luna") {
				if (action === "status") {
					const enabled = readConfig().enabledModels.has(LUNA_MODEL_ID);
					ctx.ui.notify(`Luna Fast mode is ${enabled ? "on" : "off"}.`, "info");
					return;
				}

				if (action === "on" || action === "off") {
					const enabled = action === "on";
					setModelEnabled(LUNA_MODEL_ID, enabled);
					ctx.ui.notify(`Luna Fast mode is ${enabled ? "on" : "off"}.`, "info");
					return;
				}
			} else {
				const model = ctx.model;
				if (action === "status" || action === "on" || action === "off") {
					if (!model || !isEligible(ctx)) {
						ctx.ui.notify("The current model or authentication does not support this Fast mode.", "warning");
						return;
					}

					if (action === "status") {
						const enabled = readConfig().enabledModels.has(model.id);
						ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"} for ${model.name}.`, "info");
						return;
					}

					const enabled = action === "on";
					setModelEnabled(model.id, enabled);
					ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"} for ${model.name}.`, "info");
					return;
				}
			}

			ctx.ui.notify(usage, "warning");
		},
	});
}
