import { contextBridge, ipcRenderer } from "electron";
import { DragonSettings } from "../types/settings";

contextBridge.exposeInMainWorld("dragonSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  update: (partial: Partial<DragonSettings>) => ipcRenderer.invoke("settings:update", partial),
  checkDecisionProvider: () => ipcRenderer.invoke("decision-provider:check"),
  openLogs: () => ipcRenderer.invoke("settings:openLogs"),
  openDashboard: () => ipcRenderer.invoke("settings:openDashboard"),
  getHistory: () => ipcRenderer.invoke("history:get"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  onStatus: (cb: (status: any) => void) => ipcRenderer.on("status:update", (_e, data) => cb(data)),
});
