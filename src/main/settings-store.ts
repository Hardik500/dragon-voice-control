import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_SETTINGS, DragonSettings } from "../types/settings";
import { logger } from "../logging/logger";

const FILE_NAME = "settings.json";

export class SettingsStore {
  private filePath: string;
  private settings: DragonSettings;

  constructor() {
    this.filePath = path.join(app.getPath("userData"), FILE_NAME);
    this.settings = this.load();
  }

  private load(): DragonSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        return { ...DEFAULT_SETTINGS, ...raw };
      }
    } catch (err) {
      logger.error("settings.load", err);
    }
    // First run convenience: allow .env-style dev prefill without requiring it.
    const envOr = (name: string) => process.env[name] ?? "";
    return {
      ...DEFAULT_SETTINGS,
      openRouterApiKey: envOr("OPENROUTER_API_KEY"),
      deepgramApiKey: envOr("DEEPGRAM_API_KEY"),
    };
  }

  get(): DragonSettings {
    return this.settings;
  }

  update(partial: Partial<DragonSettings>): DragonSettings {
    this.settings = { ...this.settings, ...partial };
    this.persist();
    return this.settings;
  }

  private persist() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), "utf-8");
    } catch (err) {
      logger.error("settings.persist", err);
    }
  }
}
