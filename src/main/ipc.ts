import { ipcMain, shell, BrowserWindow } from "electron";
import { ActivationMode, DragonSettings, toRendererSafe } from "../types/settings";
import { SettingsStore } from "./settings-store";
import { DragonPipeline } from "./pipeline";
import { logger } from "../logging/logger";

export interface IpcDeps {
  settingsStore: SettingsStore;
  pipeline: DragonPipeline;
  /** `changedMode` is only set when the activation mode actually changed, not merely
   * present in the update payload (the Settings window always submits every field). */
  onSettingsChanged: (settings: DragonSettings, changedMode?: ActivationMode) => void;
  getStatus: () => Record<string, unknown>;
}

export function registerIpc(deps: IpcDeps) {
  ipcMain.handle("settings:get", () => toRendererSafe(deps.settingsStore.get()));

  ipcMain.handle("settings:update", (_e, partial: Partial<DragonSettings>) => {
    const previous = deps.settingsStore.get();
    const updated = deps.settingsStore.update(partial);
    logger.event("settings.updated", { fields: Object.keys(partial) });
    const modeChanged = partial.activationMode != null && partial.activationMode !== previous.activationMode;
    deps.onSettingsChanged(updated, modeChanged ? partial.activationMode : undefined);
    return toRendererSafe(updated);
  });

  ipcMain.handle("settings:openLogs", () => {
    shell.openPath(logger.logDir);
  });

  ipcMain.handle("history:get", () => deps.pipeline.getHistory());
  ipcMain.handle("history:clear", () => {
    deps.pipeline.clearHistory();
    return [];
  });
  ipcMain.handle("jev:decisions", () => deps.pipeline.getJevDecisionTraces());
  ipcMain.handle("jev:decisions:clear", () => {
    deps.pipeline.clearJevDecisionTraces();
    return [];
  });

  ipcMain.handle("status:get", () => deps.getStatus());

  ipcMain.on("mic:chunk", (_e, chunk: Uint8Array) => {
    deps.pipeline.handleMicChunk(Buffer.from(chunk));
  });

  ipcMain.on("mic:status", (_e, status: string, detail?: string) => {
    logger.event("mic.status", { status, detail });
  });
}

export function broadcastStatus(windows: BrowserWindow[], status: Record<string, unknown>) {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send("status:update", status);
  }
}
