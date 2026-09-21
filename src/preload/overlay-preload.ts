import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dragonOverlay", {
  onUpdate: (cb: (update: any) => void) => ipcRenderer.on("overlay:update", (_e, data) => cb(data)),
  getHistory: () => ipcRenderer.invoke("history:get"),
});
