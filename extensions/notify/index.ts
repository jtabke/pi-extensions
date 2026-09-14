/**
 * Pi Notify Extension
 *
 * Sends a native notification when Pi agent is done and waiting for input.
 * Commands:
 * - /notify-toggle [on|off|status]
 * - /notify-test [message]
 * - /notify-min [seconds|off|status]
 *
 * Settings: ~/.pi/agent/notify-settings.json
 * Debug log: ~/.pi/agent/notify-debug.log
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";

const LOG = join(homedir(), ".pi", "agent", "notify-debug.log");
const SETTINGS = join(homedir(), ".pi", "agent", "notify-settings.json");
const PROCESS_TIMEOUT_MS = 5000;
const IS_SUBAGENT = process.env.PI_SUBAGENT_CHILD === "1";

type NotifySettings = {
	enabled: boolean;
	/** 0 means notify for every completed agent turn. */
	minDurationMs: number;
};

const DEFAULT_SETTINGS: NotifySettings = {
	enabled: true,
	minDurationMs: 0,
};

let settings = loadSettings();
let currentPrompt = "";
let currentProject = "Pi";
let currentStartedAt = 0;

function truncate(text: string, max = 140): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `${minutes}m ${remainder}s`;
}

function parseSeconds(value: string): number | undefined {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.round(seconds * 1000);
}

function log(message: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Ignore logging failures; notification should be best-effort.
	}
}

function loadSettings(): NotifySettings {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS, "utf8")) as Partial<NotifySettings>;
		return {
			enabled: parsed.enabled !== false,
			minDurationMs:
				typeof parsed.minDurationMs === "number" && Number.isFinite(parsed.minDurationMs) && parsed.minDurationMs >= 0
					? parsed.minDurationMs
					: DEFAULT_SETTINGS.minDurationMs,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function saveSettings(next: NotifySettings): void {
	settings = next;
	try {
		const tmp = `${SETTINGS}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
		renameSync(tmp, SETTINGS);
	} catch (error) {
		log(`[notify] failed to save settings: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function psSingleQuoted(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${psSingleQuoted(body)})) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier(${psSingleQuoted(title)}).Show(${toast})`,
	].join("; ");
}

function macNotify(title: string, body: string): void {
	// Prefer terminal-notifier when available. It tends to behave better than
	// osascript from tmux/background terminal sessions.
	execFile(
		"terminal-notifier",
		["-title", title, "-message", body, "-sound", "Glass"],
		{ timeout: PROCESS_TIMEOUT_MS },
		(error) => {
			if (!error) {
				log("[notify] mac terminal-notifier sent");
				return;
			}

			log(`[notify] mac terminal-notifier failed: ${error.message}; falling back to osascript`);
			execFile(
				"osascript",
				["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`],
				{ timeout: PROCESS_TIMEOUT_MS },
				(osascriptError) => {
					if (osascriptError) log(`[notify] mac osascript failed: ${osascriptError.message}`);
					else log("[notify] mac osascript sent");
				},
			);
		},
	);
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile(
		"powershell.exe",
		["-NoProfile", "-Command", windowsToastScript(title, body)],
		{ timeout: PROCESS_TIMEOUT_MS },
		(error) => {
			if (error) log(`[notify] windows toast failed: ${error.message}`);
		},
	);
}

function notify(title: string, body: string): void {
	log(
		`[notify] firing platform=${process.platform} TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""} TERM=${process.env.TERM ?? ""} KITTY=${process.env.KITTY_WINDOW_ID ? "1" : "0"} WT=${process.env.WT_SESSION ? "1" : "0"}`,
	);

	if (process.platform === "darwin") {
		macNotify(title, body);
		return;
	}

	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

export default function (pi: ExtensionAPI) {
	if (IS_SUBAGENT) return;

	log(`[notify] extension loaded enabled=${settings.enabled} minDurationMs=${settings.minDurationMs}`);

	pi.registerCommand("notify-toggle", {
		description: "Toggle ready-for-input notifications (usage: /notify-toggle [on|off|status])",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "on" || action === "enable" || action === "enabled") {
				saveSettings({ ...settings, enabled: true });
			} else if (action === "off" || action === "disable" || action === "disabled") {
				saveSettings({ ...settings, enabled: false });
			} else if (action === "" || action === "toggle") {
				saveSettings({ ...settings, enabled: !settings.enabled });
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /notify-toggle [on|off|status]", "warning");
				return;
			}

			ctx.ui.notify(`Pi notifications ${settings.enabled ? "enabled" : "disabled"}`, "info");
			log(`[notify] toggle/status enabled=${settings.enabled}`);
		},
	});

	pi.registerCommand("notify-test", {
		description: "Send a test notification now (usage: /notify-test [message])",
		handler: async (args, ctx) => {
			const message = truncate(args.trim() || "Manual test notification from Pi", 180);
			notify("Pi notify test", message);
			ctx.ui.notify("Sent test notification", "info");
		},
	});

	pi.registerCommand("notify-min", {
		description: "Set minimum turn duration for notifications (usage: /notify-min [seconds|off|status])",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "" || value === "status") {
				const label = settings.minDurationMs === 0 ? "off" : formatDuration(settings.minDurationMs);
				ctx.ui.notify(`Pi notification minimum duration: ${label}`, "info");
				return;
			}

			if (value === "off" || value === "0") {
				saveSettings({ ...settings, minDurationMs: 0 });
				ctx.ui.notify("Pi notifications will fire for every completed turn", "info");
				return;
			}

			const minDurationMs = parseSeconds(value);
			if (minDurationMs === undefined) {
				ctx.ui.notify("Usage: /notify-min [seconds|off|status]", "warning");
				return;
			}

			saveSettings({ ...settings, minDurationMs });
			ctx.ui.notify(`Pi notifications only after ${formatDuration(minDurationMs)}`, "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		currentPrompt = event.prompt ?? "";
		currentProject = basename(event.systemPromptOptions?.cwd ?? process.cwd()) || "Pi";
		currentStartedAt = Date.now();
	});

	pi.on("agent_end", async () => {
		if (!settings.enabled) {
			log("[notify] skipped because disabled");
			return;
		}

		const elapsedMs = currentStartedAt ? Date.now() - currentStartedAt : 0;
		if (settings.minDurationMs > 0 && elapsedMs < settings.minDurationMs) {
			log(`[notify] skipped elapsedMs=${elapsedMs} minDurationMs=${settings.minDurationMs}`);
			return;
		}

		const elapsed = currentStartedAt ? ` in ${formatDuration(elapsedMs)}` : "";
		const sessionName = pi.getSessionName();
		const title = sessionName
			? `Pi ready: ${truncate(sessionName, 80)}`
			: `Pi ready: ${truncate(currentProject, 80)}`;
		const bodyPrefix = sessionName ? `${currentProject} · ` : "";
		const body = currentPrompt
			? `${bodyPrefix}Done${elapsed}. ${truncate(currentPrompt)}`
			: `${bodyPrefix}Ready for input${elapsed}`;
		notify(title, body);
	});
}
