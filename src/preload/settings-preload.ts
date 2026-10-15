import { contextBridge, ipcRenderer } from "electron";
import { DragonSettings } from "../types/settings";

contextBridge.exposeInMainWorld("dragonSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  update: (partial: Partial<DragonSettings>) => ipcRenderer.invoke("settings:update", partial),
  checkDecisionProvider: () => ipcRenderer.invoke("decision-provider:check"),
  startLayaServer: () => ipcRenderer.invoke("laya-server:start"),
  stopLayaServer: () => ipcRenderer.invoke("laya-server:stop"),
  getLayaServerStatus: () => ipcRenderer.invoke("laya-server:status"),
  openExtensionFolder: () => ipcRenderer.invoke("settings:openExtensionFolder"),
  openLogs: () => ipcRenderer.invoke("settings:openLogs"),
  openDashboard: () => ipcRenderer.invoke("settings:openDashboard"),
  getHistory: () => ipcRenderer.invoke("history:get"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  setListening: (enabled: boolean) => ipcRenderer.invoke("voice:setListening", enabled),
  retryListening: () => ipcRenderer.invoke("voice:retry"),
  setMode: (mode: "normal" | "insert" | "workflow") => ipcRenderer.invoke("voice:setMode", mode),
  emergencyStop: () => ipcRenderer.invoke("voice:emergencyStop"),
  listMicrophones: () => ipcRenderer.invoke("voice:listMicrophones"),
  onStatus: (cb: (status: any) => void) => ipcRenderer.on("status:update", (_e, data) => cb(data)),
});
