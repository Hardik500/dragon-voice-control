import { app, ipcMain, shell, BrowserWindow } from "electron";
import * as path from "path";
import { ActivationMode, DragonSettings, toRendererSafe } from "../types/settings";
import { SettingsStore } from "./settings-store";
import { DragonPipeline } from "./pipeline";
import { LayaServerManager } from "./laya-server";
import { checkDecisionProvider } from "../decision/jev-client";
import { logger } from "../logging/logger";

export interface IpcDeps {
  settingsStore: SettingsStore;
  pipeline: DragonPipeline;
  layaServer: LayaServerManager;
  /** `changedMode` is only set when the activation mode actually changed, not merely
   * present in the update payload (the Settings window always submits every field). */
  onSettingsChanged: (settings: DragonSettings, changedMode?: ActivationMode) => void;
  openDashboard: () => void;
  getStatus: () => Record<string, unknown>;
  setListening: (enabled: boolean) => Promise<void>;
  retryListening: () => Promise<void>;
  setMode: (mode: "normal" | "insert" | "workflow") => void;
  emergencyStop: () => void;
  listMicrophones: () => Promise<Array<{ deviceId: string; label: string }>>;
  onMicStatus: (status: string, detail: string | undefined, generation: number) => void;
  onMicChunk: (chunk: Buffer, generation: number) => void;
}

export function registerIpc(deps: IpcDeps) {
  ipcMain.handle("settings:get", () => toRendererSafe(deps.settingsStore.get()));

  ipcMain.handle("settings:update", (_e, partial: Partial<DragonSettings>) => {
    const previous = deps.settingsStore.get();
    const updated = deps.settingsStore.update(partial);
    logger.event("settings.updated", { fields: Object.keys(partial), persisted: deps.settingsStore.persistedLast });
    const modeChanged = updated.activationMode !== previous.activationMode;
    if (deps.settingsStore.persistedLast) deps.onSettingsChanged(updated, modeChanged ? updated.activationMode : undefined);
    return { ...toRendererSafe(updated), persisted: deps.settingsStore.persistedLast };
  });

  ipcMain.handle("decision-provider:check", async () => {
    const settings = deps.settingsStore.get();
    return checkDecisionProvider({
      provider: settings.decisionProvider,
      openRouterApiKey: settings.openRouterApiKey,
      layaBaseUrl: settings.layaBaseUrl,
      layaModel: settings.layaModel,
    });
  });

  ipcMain.handle("laya-server:start", () => deps.layaServer.start());
  ipcMain.handle("laya-server:stop", () => deps.layaServer.stop());
  ipcMain.handle("laya-server:status", () => deps.layaServer.getStatus());

  ipcMain.handle("settings:openLogs", () => {
    shell.openPath(logger.logDir);
  });
  ipcMain.handle("settings:openDashboard", () => deps.openDashboard());
  ipcMain.handle("settings:openExtensionFolder", async () => {
    const directory = app.isPackaged ? path.join(process.resourcesPath, "chrome-extension") : path.join(__dirname, "..", "..", "chrome-extension");
    const error = await shell.openPath(directory);
    if (error) throw new Error("Could not open the extension folder. Use the displayed path to select it in Chrome.");
  });

  ipcMain.handle("history:get", () => deps.pipeline.getHistory());
  ipcMain.handle("history:clear", () => {
    deps.pipeline.clearHistory();
    return [];
  });

  ipcMain.handle("status:get", () => deps.getStatus());
  ipcMain.handle("voice:setListening", async (_e, enabled: boolean) => {
    await deps.setListening(enabled);
    return deps.getStatus();
  });
  ipcMain.handle("voice:setMode", (_e, mode: "normal" | "insert" | "workflow") => {
    if (!["normal", "insert", "workflow"].includes(mode)) throw new Error("Unknown interaction mode.");
    deps.setMode(mode);
    return deps.getStatus();
  });
  ipcMain.handle("voice:emergencyStop", () => {
    deps.emergencyStop();
    return deps.getStatus();
  });
  ipcMain.handle("voice:listMicrophones", () => deps.listMicrophones());
  ipcMain.handle("voice:retry", async () => {
    await deps.retryListening();
    return deps.getStatus();
  });

  ipcMain.on("mic:chunk", (_e, chunk: Uint8Array, generation: number) => {
    deps.onMicChunk(Buffer.from(chunk), generation);
  });

  ipcMain.on("mic:status", (_e, status: string, detail: string | undefined, generation: number) => {
    logger.event("mic.status", { status, detail, generation });
    deps.onMicStatus(status, detail, generation);
  });
}

export function broadcastStatus(windows: BrowserWindow[], status: Record<string, unknown>) {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send("status:update", status);
  }
}
