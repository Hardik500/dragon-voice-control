import { ipcMain, shell, BrowserWindow } from "electron";
import { DragonSettings, toRendererSafe } from "../types/settings";
import { SettingsStore } from "./settings-store";
import { DragonPipeline } from "./pipeline";
import { logger } from "../logging/logger";

export interface IpcDeps {
  settingsStore: SettingsStore;
  pipeline: DragonPipeline;
  onSettingsChanged: (settings: DragonSettings) => void;
  getStatus: () => Record<string, unknown>;
}

export function registerIpc(deps: IpcDeps) {
  ipcMain.handle("settings:get", () => toRendererSafe(deps.settingsStore.get()));

  ipcMain.handle("settings:update", (_e, partial: Partial<DragonSettings>) => {
    const updated = deps.settingsStore.update(partial);
    logger.event("settings.updated", { fields: Object.keys(partial) });
    deps.onSettingsChanged(updated);
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
