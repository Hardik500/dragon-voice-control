import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { HistoryEntry, INTENT_NAMES } from "../types/pipeline";
import { logger } from "../logging/logger";
import { writeJsonAtomic } from "./json-store";

const MAX_ENTRIES = 200;
function copyEntry(row: HistoryEntry): HistoryEntry {
  const { utteranceId, timestamp, transcript, intent, action, status, detail } = row;
  return { utteranceId, timestamp, transcript, intent, action, status, detail };
}
function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as HistoryEntry;
  return INTENT_NAMES.includes(row.intent) && Number.isFinite(row.timestamp) && ["success", "error", "ignored"].includes(row.status) &&
    ["utteranceId", "transcript", "intent", "action", "detail"].every(key => typeof (row as any)[key] === "string");
}

export class HistoryStore {
  private filePath = path.join(app.getPath("userData"), "history.json");
  private entries: HistoryEntry[] = [];

  constructor() {
    try {
      if (fs.existsSync(this.filePath)) {
        const rows: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        if (Array.isArray(rows)) this.entries = rows.filter(isEntry).slice(0, MAX_ENTRIES).map(copyEntry);
      }
    } catch {
      logger.event("history.load_failed", { reason: "Could not read or parse command history." });
    }
  }

  add(entry: HistoryEntry): void {
    this.entries.unshift(copyEntry(entry));
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    try { writeJsonAtomic(this.filePath, this.entries); }
    catch { logger.event("history.persist_failed", { reason: "Recent history remains available for this session." }); }
  }

  list(): HistoryEntry[] { return this.entries.map(entry => ({ ...entry })); }

  clear(): void {
    try { writeJsonAtomic(this.filePath, []); }
    catch { throw new Error("Command history could not be cleared on disk. Check file access and try again."); }
    this.entries = [];
  }
}
