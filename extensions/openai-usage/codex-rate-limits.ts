import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 12_000;

/** Query Codex's existing login without reading its credential files. */
export function readCodexRateLimits(signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (stop.aborted) return Promise.reject(new Error("Codex quota read cancelled."));

  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let finished = false;
    let initialized = false;

    function finish(error?: Error, result?: unknown): void {
      if (finished) return;
      finished = true;
      stop.removeEventListener("abort", onAbort);
      output.close();
      child.stdin.destroy();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill();
        const forceStop = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceStop.unref();
        child.once("close", () => clearTimeout(forceStop));
      }
      if (error) reject(error);
      else resolve(result);
    }

    function onAbort(): void {
      finish(new Error(timeout.aborted ? "Codex quota read timed out." : "Codex quota read cancelled."));
    }

    function send(message: object): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    stop.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === "ENOENT" ? "Codex CLI was not found on PATH." : "Could not start Codex CLI."));
    });
    child.once("close", () => finish(new Error("Codex CLI exited before returning quota information.")));
    child.stdin.on("error", () => finish(new Error("Could not send a quota request to Codex CLI.")));
    output.on("error", () => finish(new Error("Could not read quota information from Codex CLI.")));
    output.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (finished || message?.id !== (initialized ? 2 : 1)) return;
      if (message.error) {
        // Do not surface backend errors that may include account or request details.
        finish(new Error(initialized
          ? "Codex could not read quota. Check `codex login status`."
          : "Could not initialize the Codex app server."));
        return;
      }
      if (initialized) {
        finish(undefined, message.result);
      } else {
        initialized = true;
        send({ jsonrpc: "2.0", method: "initialized" });
        send({
          jsonrpc: "2.0", id: 2, method: "account/rateLimits/read",
          params: { excludeResetCreditDetails: true },
        });
      }
    });
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "pi_openai_usage", version: "1.0.0" } },
    });
  });
}
