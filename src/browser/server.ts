import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { BrowserAction, ExtensionToServerMessage, ServerToExtensionMessage } from "../types/browser-protocol";
import { BrowserPageState } from "../types/pipeline";

export const BROWSER_BRIDGE_PORT = 17872;

interface Pending {
  resolve: (value: ExtensionToServerMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
  responseType: "snapshot" | "action_result";
}

/** Local compact-label bridge. Connections own their requests: a reconnect can
 * never acknowledge an action from an older extension session. */
export class BrowserBridge {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private bindError: string | null = null;
  private connectionChanged: (() => void) | null = null;

  onConnectionChanged(callback: () => void): void {
    this.connectionChanged = callback;
  }

  private notifyConnectionChanged(): void {
    try { this.connectionChanged?.(); } catch (err) { logger.error("browser.status_callback_failed", err); }
  }

  start() {
    if (this.wss) return;
    const server = new WebSocketServer({ port: BROWSER_BRIDGE_PORT, host: "127.0.0.1", maxPayload: 128 * 1024 });
    this.wss = server;
    server.on("listening", () => {
      this.bindError = null;
      logger.event("browser.server_started", { port: BROWSER_BRIDGE_PORT });
      this.notifyConnectionChanged();
    });
    server.on("connection", (ws) => {
      const previous = this.socket;
      this.socket = ws;
      if (previous && previous !== ws) {
        this.rejectPending(previous, "Chrome extension reconnected. Say the command again.");
        previous.close();
      }
      logger.event("browser.extension_connected", {});
      this.notifyConnectionChanged();
      ws.on("message", (raw) => {
        if (this.socket === ws) this.onMessage(raw.toString(), ws);
      });
      ws.on("close", () => {
        this.rejectPending(ws, "Chrome extension disconnected. Reconnect it and say the command again.");
        if (this.socket !== ws) return;
        this.socket = null;
        logger.event("browser.extension_disconnected", {});
        this.notifyConnectionChanged();
      });
      ws.on("error", (err) => {
        logger.error("browser.socket_error", err);
        this.rejectPending(ws, "Chrome extension connection failed.");
        if (this.socket === ws) {
          this.socket = null;
          this.notifyConnectionChanged();
        }
        ws.terminate();
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.bindError = err.code === "EADDRINUSE"
        ? "Port " + BROWSER_BRIDGE_PORT + " is already in use — another Dragon instance (or a leftover one) is likely still running. Quit it, then relaunch."
        : err.message;
      logger.error("browser.server_bind_failed", err, { port: BROWSER_BRIDGE_PORT });
      this.notifyConnectionChanged();
    });
  }

  getBindError(): string | null {
    return this.bindError;
  }

  stop() {
    const server = this.wss;
    this.wss = null;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser bridge stopped."));
    }
    this.pending.clear();
    for (const client of server?.clients ?? []) client.terminate();
    server?.close();
    this.notifyConnectionChanged();
  }

  isConnected(): boolean {
    return this.socket != null && this.socket.readyState === WebSocket.OPEN;
  }

  private rejectPending(socket: WebSocket, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private onMessage(raw: string, socket: WebSocket) {
    let msg: ExtensionToServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      logger.error("browser.parse_error", err);
      return;
    }
    if (!msg || typeof msg !== "object" || msg.type === "hello") return;
    if (msg.type !== "snapshot" && msg.type !== "action_result") return;
    const requestId = msg.requestId;
    if (typeof requestId !== "string") return;
    const pending = this.pending.get(requestId);
    if (!pending || pending.socket !== socket || pending.responseType !== msg.type) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(msg);
  }

  private send(message: ServerToExtensionMessage, timeoutMs: number): Promise<ExtensionToServerMessage> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome extension is not connected."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error("Chrome did not respond in time. Check the page and say the command again."));
      }, timeoutMs);
      const pending: Pending = { resolve, reject, timer, socket, responseType: message.type === "get_snapshot" ? "snapshot" : "action_result" };
      this.pending.set(message.requestId, pending);
      const failed = (error: Error) => {
        if (this.pending.get(message.requestId) !== pending) return;
        clearTimeout(timer);
        this.pending.delete(message.requestId);
        reject(error);
      };
      try {
        socket.send(JSON.stringify(message), (err) => { if (err) failed(err); });
      } catch (err) {
        failed(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async requestSnapshot(timeoutMs = 1000): Promise<BrowserPageState> {
    const empty = (): BrowserPageState => ({ connected: this.isConnected(), url: "", title: "", focusedElementId: null, elements: [] });
    if (!this.isConnected()) return empty();
    try {
      const res = await this.send({ type: "get_snapshot", requestId: randomUUID() }, timeoutMs);
      if (res.type !== "snapshot") return empty();
      return {
        connected: this.isConnected(),
        url: typeof res.url === "string" ? res.url : "",
        title: typeof res.title === "string" ? res.title.slice(0, 300) : "",
        focusedElementId: typeof res.focusedElementId === "string" ? res.focusedElementId : null,
        elements: (Array.isArray(res.elements) ? res.elements : []).slice(0, 60)
          .filter((element) => element && typeof element.id === "string" && typeof element.tag === "string" && typeof element.role === "string" && typeof element.text === "string")
          .map((element) => ({ id: element.id, tag: element.tag.slice(0, 30), role: element.role.slice(0, 60), text: element.text.slice(0, 100), score: 0 })),
      };
    } catch (err) {
      logger.error("browser.snapshot_failed", err);
      return empty();
    }
  }

  async sendAction(action: BrowserAction, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.send({ type: "action", requestId: randomUUID(), action }, timeoutMs);
      if (res.type !== "action_result") return { ok: false, error: "Unexpected browser response." };
      return { ok: res.ok === true, ...(typeof res.error === "string" ? { error: res.error } : {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
