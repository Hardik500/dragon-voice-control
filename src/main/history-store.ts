import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { HistoryEntry } from "../types/pipeline";
import { logger } from "../logging/logger";

const FILE_NAME = "history.json";
const MAX_ENTRIES = 200;

export class HistoryStore {
  private filePath: string;
  private entries: HistoryEntry[];

  constructor() {
    this.filePath = path.join(app.getPath("userData"), FILE_NAME);
    this.entries = this.load();
  }

  private load(): HistoryEntry[] {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      }
    } catch (err) {
      logger.error("history.load", err);
    }
    return [];
  }

  add(entry: HistoryEntry) {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.persist();
  }

  list(): HistoryEntry[] {
    return this.entries;
  }

  clear() {
    this.entries = [];
    this.persist();
  }

  private persist() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch (err) {
      logger.error("history.persist", err);
    }
  }
}
