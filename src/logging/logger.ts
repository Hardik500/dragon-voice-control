import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

/**
 * Structured JSONL debug logger.
 *
 * Rules (see AGENTS.md / DECISIONS.md):
 * - Never log API keys, Authorization headers, or raw audio bytes.
 * - One JSON object per line, rotated per calendar day.
 */

export type LogVerbosity = "normal" | "verbose";

const REDACT_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "openrouterapikey",
  "deepgramapikey",
  "token",
  "audio",
  "pcm",
  "chunk",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value == null) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return `[binary ${(value as any).byteLength ?? (value as any).length ?? 0} bytes omitted]`;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      return value.slice(0, 50).map((v) => redact(v, depth + 1)).concat(`...(${value.length - 50} more)`);
    }
    return value.map((v) => redact(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

class Logger {
  private verbosity: LogVerbosity = "normal";
  private stream: fs.WriteStream | null = null;
  private currentDay = "";
  private readonly sessionId: string;
  public readonly logDir: string;

  constructor() {
    this.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  setVerbosity(v: LogVerbosity) {
    this.verbosity = v;
  }

  private ensureStream() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.stream && day === this.currentDay) return;
    if (this.stream) this.stream.end();
    this.currentDay = day;
    const file = path.join(this.logDir, `dragon-${day}.jsonl`);
    this.stream = fs.createWriteStream(file, { flags: "a" });
  }

  event(stage: string, data: Record<string, unknown> = {}, opts: { verboseOnly?: boolean } = {}) {
    if (opts.verboseOnly && this.verbosity !== "verbose") return;
    this.ensureStream();
    const record = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      stage,
      ...(redact(data) as Record<string, unknown>),
    };
    try {
      this.stream?.write(JSON.stringify(record) + "\n");
    } catch (err) {
      // Logging must never crash the app.
      console.error("log write failed", err);
    }
  }

  error(stage: string, err: unknown, data: Record<string, unknown> = {}) {
    const message = err instanceof Error ? err.message : String(err);
    this.event(stage, { ...data, error: message }, {});
  }
}

export const logger = new Logger();
