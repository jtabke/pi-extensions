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
const CONFIG_PATH = join(getAgentDir(), "extensions", "luna-fast.json");

type Payload = Record<string, unknown>;

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

function readEnabledModels(): Set<string> {
	if (!existsSync(CONFIG_PATH)) return new Set([LUNA_MODEL_ID]);

	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
		if (typeof config === "object" && config !== null) {
			if (
				"enabledModels" in config &&
				Array.isArray(config.enabledModels) &&
				config.enabledModels.every((model) => typeof model === "string")
			) {
				return new Set(config.enabledModels);
			}

			// Preserve the original Luna-only configuration format.
			if ("enabled" in config && typeof config.enabled === "boolean") {
				return config.enabled ? new Set([LUNA_MODEL_ID]) : new Set();
			}
		}
	} catch (error) {
		console.error(`Warning: Could not read ${CONFIG_PATH}: ${error}`);
	}

	return new Set([LUNA_MODEL_ID]);
}

function writeEnabledModels(enabledModels: Set<string>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
	const config = { enabledModels: [...enabledModels].sort() };

	try {
		writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		renameSync(temporaryPath, CONFIG_PATH);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function setModelEnabled(modelId: string, enabled: boolean): void {
	const enabledModels = readEnabledModels();
	if (enabled) enabledModels.add(modelId);
	else enabledModels.delete(modelId);
	writeEnabledModels(enabledModels);
}

export default function lunaFast(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			!model ||
			!readEnabledModels().has(model.id) ||
			!isEligible(ctx) ||
			!isPayload(event.payload)
		) return;
		if (event.payload.model !== model.id || "service_tier" in event.payload) return;

		return {
			...event.payload,
			service_tier: SERVICE_TIER,
		};
	});

	pi.registerCommand("fast", {
		description: "Control Fast mode for the current model or GPT-5.6 Luna",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const targetsLuna = parts[0] === "luna";
			const action = (targetsLuna ? parts[1] : parts[0]) || "on";

			if (parts.length > (targetsLuna ? 2 : 1)) {
				ctx.ui.notify("Usage: /fast [on | off | status] | /fast luna [on | off | status]", "warning");
				return;
			}

			if (targetsLuna) {
				if (action === "status") {
					const enabled = readEnabledModels().has(LUNA_MODEL_ID);
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
						const enabled = readEnabledModels().has(model.id);
						ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"} for ${model.name}.`, "info");
						return;
					}

					const enabled = action === "on";
					setModelEnabled(model.id, enabled);
					ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"} for ${model.name}.`, "info");
					return;
				}
			}

			ctx.ui.notify("Usage: /fast [on | off | status] | /fast luna [on | off | status]", "warning");
		},
	});
}
