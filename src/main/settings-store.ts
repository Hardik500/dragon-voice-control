import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_SETTINGS, DragonSettings } from "../types/settings";
import { logger } from "../logging/logger";
import { writeJsonAtomic } from "./json-store";

const ENUMS: Partial<Record<keyof DragonSettings, readonly string[]>> = {
  activationMode: ["push_to_talk", "always_listening"],
  decisionProvider: ["jev", "laya"],
  logVerbosity: ["normal", "verbose"],
  screenClickMethod: ["auto", "accessibility", "vision"],
};

function normalized(raw: unknown, base: DragonSettings, strict: boolean): DragonSettings {
  const next = { ...base };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw new Error("Settings must be an object.");
    return next;
  }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof DragonSettings)[]) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    let value = (raw as Record<string, unknown>)[key];
    if (key === "activationMode" && value === "wake_word") value = "always_listening";
    let valid = typeof value === typeof DEFAULT_SETTINGS[key];
    if (typeof value === "string") {
      value = value.trim();
      if (ENUMS[key]) valid = ENUMS[key]!.includes(value as string);
      if (key.endsWith("Shortcut") && !value) valid = false;
      if (key === "layaBaseUrl") {
        try { const url = new URL(value as string); valid = valid && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
        catch { valid = false; }
      }
      if ((key === "layaModel" || key === "layaServerCommand") && !value) valid = false;
    }
    if (!valid) {
      if (strict) throw new Error("Invalid setting: " + key + ".");
      continue;
    }
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}

export class SettingsStore {
  private filePath = path.join(app.getPath("userData"), "settings.json");
  private settings: DragonSettings;
  private lastPersistOk = true;

  constructor() {
    const defaults = {
      ...DEFAULT_SETTINGS,
      openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
      deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
    };
    this.settings = normalized(defaults, DEFAULT_SETTINGS, false);
    try {
      if (fs.existsSync(this.filePath)) {
        this.settings = normalized(JSON.parse(fs.readFileSync(this.filePath, "utf8")), this.settings, false);
      }
    } catch {
      // JSON parse errors can quote file contents, including keys. Never log that error.
      logger.event("settings.load_failed", { reason: "Could not read or parse settings; using valid defaults." });
    }
  }

  get(): DragonSettings { return { ...this.settings }; }

  update(partial: Partial<DragonSettings>): DragonSettings {
    const candidate = normalized(partial, this.settings, true);
    try {
      writeJsonAtomic(this.filePath, candidate);
      this.settings = candidate;
      this.lastPersistOk = true;
    } catch {
      this.lastPersistOk = false;
      logger.event("settings.persist_failed", { reason: "Settings could not be saved; active preferences were kept." });
    }
    return this.get();
  }

  get persistedLast(): boolean { return this.lastPersistOk; }
}
