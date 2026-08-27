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
const MODEL_ID = "gpt-5.6-luna";
const SERVICE_TIER = "priority";
const CONFIG_PATH = join(getAgentDir(), "extensions", "luna-fast.json");
const DEFAULT_ENABLED = true;

type Payload = Record<string, unknown>;

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEligible(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return (
		model?.provider === PROVIDER_ID &&
		model.api === API_ID &&
		model.id === MODEL_ID &&
		ctx.modelRegistry.isUsingOAuth(model)
	);
}

function readEnabled(): boolean {
	if (!existsSync(CONFIG_PATH)) return DEFAULT_ENABLED;

	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
		if (
			typeof config === "object" &&
			config !== null &&
			"enabled" in config &&
			typeof config.enabled === "boolean"
		) {
			return config.enabled;
		}
	} catch (error) {
		console.error(`Warning: Could not read ${CONFIG_PATH}: ${error}`);
	}

	return DEFAULT_ENABLED;
}

function writeEnabled(enabled: boolean): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;

	try {
		writeFileSync(temporaryPath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf-8");
		renameSync(temporaryPath, CONFIG_PATH);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

export default function lunaFast(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (!readEnabled() || !isEligible(ctx) || !isPayload(event.payload)) return;
		if (event.payload.model !== MODEL_ID || "service_tier" in event.payload) return;

		return {
			...event.payload,
			service_tier: SERVICE_TIER,
		};
	});

	pi.registerCommand("luna-fast", {
		description: "Control Fast mode for ChatGPT-auth GPT-5.6 Luna requests",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "on" || action === "off") {
				const enabled = action === "on";
				writeEnabled(enabled);
				ctx.ui.notify(`Luna Fast mode is ${enabled ? "on" : "off"}.`, "info");
				return;
			}

			if (action === "status") {
				const enabled = readEnabled();
				const eligibility = isEligible(ctx)
					? "The current model and authentication are eligible."
					: "The current model or authentication is not eligible.";
				ctx.ui.notify(`Luna Fast mode is ${enabled ? "on" : "off"}. ${eligibility}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /luna-fast on | off | status", "warning");
		},
	});
}
