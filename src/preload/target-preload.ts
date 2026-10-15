import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dragonTarget", {
  onUpdate: (cb: (target: { x: number; y: number; number?: number; label: string }) => void) =>
    ipcRenderer.on("target:update", (_e, target) => cb(target)),
});
