import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { BrowserAction, ExtensionToServerMessage, ServerToExtensionMessage } from "../types/browser-protocol";
import { BrowserPageState } from "../types/pipeline";

export const BROWSER_BRIDGE_PORT = 17872;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Local WebSocket server the unpacked Chrome extension connects to. Only
 * compact page context (URL, title, focused element, capped element list)
 * ever crosses this boundary; never full page HTML.
 */
export class BrowserBridge {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();

  start() {
    this.wss = new WebSocketServer({ port: BROWSER_BRIDGE_PORT, host: "127.0.0.1" });
    this.wss.on("connection", (ws) => {
      logger.event("browser.extension_connected", {});
      this.socket = ws;
      ws.on("message", (raw) => this.onMessage(raw.toString()));
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
        logger.event("browser.extension_disconnected", {});
      });
      ws.on("error", (err) => logger.error("browser.socket_error", err));
    });
    this.wss.on("error", (err) => logger.error("browser.server_error", err));
    logger.event("browser.server_started", { port: BROWSER_BRIDGE_PORT });
  }

  stop() {
    this.socket?.close();
    this.wss?.close();
  }

  isConnected(): boolean {
    return this.socket != null && this.socket.readyState === WebSocket.OPEN;
  }

  private onMessage(raw: string) {
    let msg: ExtensionToServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      logger.error("browser.parse_error", err);
      return;
    }
    if (msg.type === "hello") return;
    if (msg.type === "snapshot" || msg.type === "action_result") {
      const requestId = "requestId" in msg ? msg.requestId : null;
      if (requestId && this.pending.has(requestId)) {
        const p = this.pending.get(requestId)!;
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        p.resolve(msg);
      }
    }
  }

  private send(message: ServerToExtensionMessage, timeoutMs: number): Promise<any> {
    if (!this.isConnected()) return Promise.reject(new Error("Chrome extension is not connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error("Browser bridge request timed out"));
      }, timeoutMs);
      this.pending.set(message.requestId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify(message));
    });
  }

  async requestSnapshot(timeoutMs = 800): Promise<BrowserPageState> {
    if (!this.isConnected()) {
      return { connected: false, url: "", title: "", focusedElementId: null, elements: [] };
    }
    try {
      const requestId = randomUUID();
      const res = await this.send({ type: "get_snapshot", requestId }, timeoutMs);
      return {
        connected: true,
        url: res.url ?? "",
        title: res.title ?? "",
        focusedElementId: res.focusedElementId ?? null,
        elements: (res.elements ?? []).map((e: any) => ({
          id: e.id,
          tag: e.tag,
          role: e.role,
          text: e.text,
          score: 0,
        })),
      };
    } catch (err) {
      logger.error("browser.snapshot_failed", err);
      return { connected: this.isConnected(), url: "", title: "", focusedElementId: null, elements: [] };
    }
  }

  async sendAction(action: BrowserAction, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
    const requestId = randomUUID();
    try {
      const res = await this.send({ type: "action", requestId, action }, timeoutMs);
      return { ok: !!res.ok, error: res.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
