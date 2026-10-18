import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { checkDecisionProvider, DecisionProviderConfig, ProviderHealth } from "../decision/jev-client";
import { logger } from "../logging/logger";
import { DragonSettings } from "../types/settings";

export type LayaServerState = "stopped" | "starting" | "ready" | "stopping" | "error";

export interface LayaServerStatus {
  state: LayaServerState;
  message: string;
  pid: number | null;
  model: string | null;
  managed: boolean;
}

function layaConfig(settings: DragonSettings): DecisionProviderConfig {
  return {
    provider: "laya",
    openRouterApiKey: "",
    layaBaseUrl: settings.layaBaseUrl,
    layaModel: settings.layaModel,
  };
}

function localEndpoint(baseUrl: string): { host: string; port: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Laya base URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("Laya base URL must be a local http:// address");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Laya base URL must not include credentials, a query, or a fragment");
  }
  // Health checks use URL semantics: http://localhost without a port means 80.
  return { host: parsed.hostname.includes(":") ? "::1" : "127.0.0.1", port: parsed.port || "80" };
}

function resolveLayaCommand(settings: DragonSettings): string {
  const configured = settings.layaServerCommand.trim() || "laya-server";
  if (configured !== "laya-server") return configured;
  const candidates = [
    process.env.LAYA_SERVER_COMMAND,
    join(homedir(), ".local", "bin", "laya-server.exe"),
    join(homedir(), ".local", "bin", "laya-server"),
    process.env.APPDATA ? join(process.env.APPDATA, "uv", "bin", "laya-server.exe") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "uv", "bin", "laya-server.exe") : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? configured;
}

/** Owns only a laya-server process started by Dragon; an already-running server is left alone. */
export class LayaServerManager {
  private child: ChildProcess | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<LayaServerStatus> | null = null;
  private generation = 0;
  private disposed = false;
  private shutdownReason: "stop" | "timeout" | null = null;
  private static readonly STARTUP_TIMEOUT_MS = 120_000;
  private status: LayaServerStatus = {
    state: "stopped",
    message: "Laya server is not running",
    pid: null,
    model: null,
    managed: false,
  };

  constructor(
    private getSettings: () => DragonSettings,
    private onStatus: (status: LayaServerStatus) => void
  ) {}

  getStatus(): LayaServerStatus {
    return { ...this.status };
  }

  /** Health checks and process creation form one attempt, including concurrent Start clicks. */
  start(): Promise<LayaServerStatus> {
    if (this.disposed || this.child) return Promise.resolve(this.getStatus());
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    const settings = { ...this.getSettings() };
    this.setStatus({ state: "starting", message: "Checking for a running Laya server…", pid: null,
      model: settings.layaModel.trim() || "laya", managed: false });
    if (generation !== this.generation || this.disposed) return Promise.resolve(this.getStatus());
    const work = this.startAttempt(settings, generation).finally(() => {
      if (this.startPromise === work) this.startPromise = null;
    });
    this.startPromise = work;
    return work;
  }

  private async startAttempt(settings: DragonSettings, generation: number): Promise<LayaServerStatus> {
    const config = layaConfig(settings);
    const model = settings.layaModel.trim() || "laya";
    const isCurrent = () => !this.disposed && generation === this.generation;
    try {
      const endpoint = localEndpoint(settings.layaBaseUrl);
      const existing = await checkDecisionProvider(config);
      if (!isCurrent()) return this.getStatus();
      if (existing.ok) {
        this.setStatus({
          state: "ready",
          message: `External Laya server is already ready (${existing.model ?? model})`,
          pid: null,
          model: existing.model,
          managed: false,
        });
        return this.getStatus();
      }

      const base = new URL(settings.layaBaseUrl);
      if (base.pathname !== "/" || base.search || base.hash) {
        throw new Error("Managed Laya needs a base URL with no path, query or fragment, such as http://127.0.0.1:8000");
      }
      const command = resolveLayaCommand(settings);
      const args = ["serve", model, "--host", endpoint.host, "--port", endpoint.port, "--no-browser"];
      this.shutdownReason = null;
      this.setStatus({ state: "starting", message: `Starting ${command}…`, pid: null, model, managed: true });
      if (!isCurrent()) return this.getStatus();
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.child = child;

      child.once("error", (error) => {
        if (this.child !== child) return;
        this.generation += 1;
        this.clearPoll();
        // Spawn failures have no PID. Keep an existing process owned if signalling it fails.
        if (child.pid == null) this.child = null;
        this.setStatus({ state: "error", message: `Could not run ${command}: ${error.message}`,
          pid: this.child?.pid ?? null, model, managed: true });
      });
      child.once("exit", (code, signal) => {
        if (this.child !== child) return;
        this.clearPoll();
        this.child = null;
        if (this.shutdownReason === "stop") {
          this.setStatus({ state: "stopped", message: "Laya server stopped", pid: null, model, managed: true });
        } else if (this.shutdownReason === "timeout") {
          this.setStatus({ ...this.status, state: "error", pid: null });
        } else {
          this.setStatus({ state: "error",
            message: `Laya server exited unexpectedly (${code ?? "unknown"}${signal ? `/${signal}` : ""})`,
            pid: null, model, managed: true });
        }
      });
      child.stdout?.resume();
      child.stderr?.resume();
      this.setStatus({ ...this.status, pid: child.pid ?? null });
      logger.event("laya_server.start_requested", { command, model, port: endpoint.port });
      if (isCurrent() && this.child === child && this.shutdownReason === null) this.pollUntilReady(config, child, generation);
      return this.getStatus();
    } catch (error) {
      if (!isCurrent()) return this.getStatus();
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ state: "error", message: `Could not start Laya: ${message}`, pid: this.child?.pid ?? null,
        model, managed: this.child !== null });
      return this.getStatus();
    }
  }

  stop(): LayaServerStatus {
    this.generation += 1;
    this.startPromise = null;
    this.clearPoll();
    const child = this.child;
    if (!child) {
      if (this.status.state === "ready" && !this.status.managed) {
        this.setStatus({ ...this.status, message: "Laya server is external and was not stopped" });
      } else {
        this.setStatus({ state: "stopped", message: "Laya server stopped", pid: null,
          model: this.status.model, managed: this.status.managed });
      }
      return this.getStatus();
    }

    this.shutdownReason = "stop";
    this.setStatus({ ...this.status, state: "stopping", message: "Stopping Laya server…" });
    this.terminateManagedChild(child);
    return this.getStatus();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private terminateManagedChild(child: ChildProcess): void {
    if (this.child !== child) return;
    try {
      if (!child.kill() && this.child === child) {
        this.setStatus({ ...this.status, state: "error", message: "Could not stop the managed Laya process. Try Stop again." });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ ...this.status, state: "error", message: `Could not stop the managed Laya process: ${message}` });
    }
  }

  private pollUntilReady(config: DecisionProviderConfig, child: ChildProcess, generation: number): void {
    let lastHealthMessage = "The server did not respond";
    const isCurrent = () => generation === this.generation && this.child === child && this.shutdownReason === null;
    this.startupTimer = setTimeout(() => {
      if (!isCurrent()) return;
      this.generation += 1;
      this.clearPoll();
      this.shutdownReason = "timeout";
      this.setStatus({ state: "error", message: `Laya did not become ready within 120 seconds. ${lastHealthMessage}. Check the model and server command, then retry.`,
        pid: child.pid ?? null, model: config.layaModel, managed: true });
      this.terminateManagedChild(child);
    }, LayaServerManager.STARTUP_TIMEOUT_MS);
    this.startupTimer.unref();
    const poll = async () => {
      if (!isCurrent()) return;
      let health: ProviderHealth;
      try {
        health = await checkDecisionProvider(config);
      } catch (error) {
        health = { ok: false, provider: "laya", model: null, message: error instanceof Error ? error.message : String(error) };
      }
      // A stopped/replaced process or a newer configuration must never inherit this result.
      if (!isCurrent()) return;
      if (health.ok) {
        this.clearPoll();
        this.setStatus({ state: "ready", message: `Laya server ready (${health.model ?? config.layaModel})`,
          pid: child.pid ?? null, model: health.model ?? config.layaModel, managed: true });
        return;
      }
      lastHealthMessage = health.message;
      this.pollTimer = setTimeout(() => { this.pollTimer = null; void poll(); }, 1000);
      this.pollTimer.unref();
    };
    void poll();
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.pollTimer = null;
    this.startupTimer = null;
  }

  private setStatus(status: LayaServerStatus): void {
    this.status = status;
    this.onStatus(this.getStatus());
  }
}
