import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../logging/logger";
import { JevDecisionTrace } from "../types/pipeline";

const DASHBOARD_PORT = 17873;
const DASHBOARD_HOST = "127.0.0.1";
const RENDERER_DIR = path.join(__dirname, "..", "..", "src", "renderer");
const DASHBOARD_HTML = path.join(RENDERER_DIR, "dashboard.html");
const DASHBOARD_JS = path.join(__dirname, "..", "..", "dist-renderer", "dashboard.js");

/**
 * A tiny read-only local web app for inspecting Jev's typed decisions. It is intentionally
 * separate from the Chrome extension bridge so the dashboard can be opened in the user's
 * normal browser at a stable URL without coupling the two local protocols.
 */
export class DashboardServer {
  private server: http.Server | null = null;

  constructor(
    private getDecisions: () => JevDecisionTrace[],
    private getStatus: () => Record<string, unknown>
  ) {}

  url(): string {
    return `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/dashboard`;
  }

  start(): void {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("error", (err) => {
      logger.error("dashboard.server_error", err);
    });
    this.server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
      logger.event("dashboard.server_started", { url: this.url() });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = new URL(req.url ?? "/", this.url()).pathname;
    if (pathname === "/") {
      res.writeHead(302, { Location: "/dashboard" });
      res.end();
      return;
    }
    if (pathname === "/dashboard") {
      this.serveFile(res, DASHBOARD_HTML, "text/html; charset=utf-8");
      return;
    }
    if (pathname === "/dist-renderer/dashboard.js") {
      this.serveFile(res, DASHBOARD_JS, "text/javascript; charset=utf-8");
      return;
    }
    if (pathname === "/api/decisions") {
      this.sendJson(res, {
        generatedAt: Date.now(),
        decisions: this.getDecisions(),
        status: this.getStatus(),
      });
      return;
    }
    this.sendJson(res, { error: "Not found" }, 404);
  }

  private sendJson(res: http.ServerResponse, body: unknown, statusCode = 200): void {
    const bodyText = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(bodyText),
    });
    res.end(bodyText);
  }

  private serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        this.sendJson(res, { error: "Dashboard asset unavailable" }, 500);
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Length": data.length,
      });
      res.end(data);
    });
  }
}
