import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dragonMic", {
  onStart: (cb: (generation: number, options?: { deviceId?: string }) => void) =>
    ipcRenderer.on("mic:start", (_event, generation: number, options?: { deviceId?: string }) => cb(generation, options)),
  onStop: (cb: (generation: number) => void) =>
    ipcRenderer.on("mic:stop", (_event, generation: number) => cb(generation)),
  sendChunk: (buf: Uint8Array, generation: number) => ipcRenderer.send("mic:chunk", buf, generation),
  sendStatus: (status: string, detail: string | undefined, generation: number) =>
    ipcRenderer.send("mic:status", status, detail, generation),
});
