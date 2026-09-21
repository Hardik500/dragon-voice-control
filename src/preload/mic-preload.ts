import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dragonMic", {
  onStart: (cb: () => void) => ipcRenderer.on("mic:start", () => cb()),
  onStop: (cb: () => void) => ipcRenderer.on("mic:stop", () => cb()),
  sendChunk: (buf: Uint8Array) => ipcRenderer.send("mic:chunk", buf),
  sendStatus: (status: string, detail?: string) => ipcRenderer.send("mic:status", status, detail),
});
