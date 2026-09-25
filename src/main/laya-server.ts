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

function localPort(baseUrl: string): string {
  try {
    return new URL(baseUrl).port || "8000";
  } catch {
    return "8000";
  }
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
  private intentionalStop = false;
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

  async start(): Promise<LayaServerStatus> {
    if (this.child) return this.getStatus();
    if (this.pollTimer) return this.getStatus();

    const settings = this.getSettings();
    const config = layaConfig(settings);
    const existing = await checkDecisionProvider(config);
    if (existing.ok) {
      this.setStatus({
        state: "ready",
        message: `External Laya server is already ready (${existing.model ?? settings.layaModel})`,
        pid: null,
        model: existing.model,
        managed: false,
      });
      return this.getStatus();
    }

    const command = resolveLayaCommand(settings);
    const model = settings.layaModel.trim() || "laya";
    const args = ["serve", model, "--host", "127.0.0.1", "--port", localPort(settings.layaBaseUrl), "--no-browser"];
    this.intentionalStop = false;
    this.setStatus({
      state: "starting",
      message: `Starting ${command}…`,
      pid: null,
      model,
      managed: true,
    });

    try {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stdout?.resume();
      child.stderr?.resume();
      this.setStatus({ ...this.status, pid: child.pid ?? null });
      logger.event("laya_server.start_requested", { command, model, port: localPort(settings.layaBaseUrl) });

      child.once("error", (error) => {
        if (this.child !== child) return;
        this.clearPoll();
        this.child = null;
        this.setStatus({
          state: "error",
          message: `Could not start ${command}: ${error.message}`,
          pid: null,
          model,
          managed: true,
        });
      });
      child.once("exit", (code, signal) => {
        if (this.child !== child) return;
        this.clearPoll();
        this.child = null;
        if (this.intentionalStop) {
          this.setStatus({ state: "stopped", message: "Laya server stopped", pid: null, model, managed: true });
        } else {
          this.setStatus({
            state: "error",
            message: `Laya server exited unexpectedly (${code ?? "unknown"}${signal ? `/${signal}` : ""})`,
            pid: null,
            model,
            managed: true,
          });
        }
      });

      this.pollUntilReady(config);
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ state: "error", message: `Could not start ${command}: ${message}`, pid: null, model, managed: true });
      return this.getStatus();
    }
  }

  stop(): LayaServerStatus {
    this.clearPoll();
    const child = this.child;
    if (!child) {
      if (this.status.state === "ready" && !this.status.managed) {
        this.setStatus({ ...this.status, message: "Laya server is external and was not stopped" });
      }
      return this.getStatus();
    }

    this.intentionalStop = true;
    this.child = null;
    child.kill();
    this.setStatus({ state: "stopped", message: "Laya server stopped", pid: null, model: this.status.model, managed: true });
    return this.getStatus();
  }

  dispose(): void {
    this.stop();
  }

  private pollUntilReady(config: DecisionProviderConfig): void {
    if (this.pollTimer) return;
    const poll = async () => {
      if (!this.child) return;
      const health: ProviderHealth = await checkDecisionProvider(config);
      if (!this.child) return;
      if (health.ok) {
        this.clearPoll();
        this.setStatus({
          state: "ready",
          message: `Laya server ready (${health.model ?? config.layaModel})`,
          pid: this.child.pid ?? null,
          model: health.model ?? config.layaModel,
          managed: true,
        });
        return;
      }
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        void poll();
      }, 1000);
    };
    void poll();
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private setStatus(status: LayaServerStatus): void {
    this.status = status;
    this.onStatus(this.getStatus());
  }
}
