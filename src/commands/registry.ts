/**
 * Platform selector: re-exports the active OS's app aliases / key specs / settings panes /
 * locations, plus the platform-neutral common vocab (websites, canonical name lists, site
 * search templates). This is the only registry module the decision layer (`extract.ts`,
 * `resolve.ts`, `questions.ts`) should import from — never `registry-macos.ts` /
 * `registry-windows.ts` directly (those are for `automation/macos.ts` / `automation/windows.ts`
 * only, which know they're only ever running on their own OS).
 */
import * as common from "./registry-common";
import * as mac from "./registry-macos";
import * as win from "./registry-windows";

const platform = process.platform === "win32" ? win : mac;

const APP_ALIASES: Record<string, unknown> = platform.APP_ALIASES;

/** All recognized voice alias keys for the active platform (e.g. "chrome", "notepad"). Shared
 * code should only ever see these keys, never the platform-specific resolved value. */
export function appAliasKeys(): string[] {
  return Object.keys(APP_ALIASES);
}

/** Friendly display name for an alias key, for Jev target descriptions / overlay / history /
 * voice replies. Platform automation modules resolve the same key to their own executable
 * representation independently, using their own registry file. */
export function appAliasLabel(aliasKey: string): string {
  const entry = APP_ALIASES[aliasKey];
  if (entry == null) return aliasKey;
  if (typeof entry === "string") return entry; // macOS: value is already the app name
  const winEntry = entry as { label?: string; processName: string };
  return winEntry.label ?? winEntry.processName;
}

export const SETTINGS_PANES = platform.SETTINGS_PANES;
export const LOCATIONS = platform.LOCATIONS;
export const KEY_SPECS = platform.KEY_SPECS;

export const KNOWN_WEBSITES = common.KNOWN_WEBSITES;
export const SITE_SEARCH_TEMPLATES = common.SITE_SEARCH_TEMPLATES;
export const KEY_PHRASE_NAMES = common.KEY_PHRASE_NAMES;
export const SETTINGS_PANE_NAMES = common.SETTINGS_PANE_NAMES;
export const LOCATION_NAMES = common.LOCATION_NAMES;

function checkCoverage(names: string[], map: Record<string, unknown>, mapLabel: string) {
  const missing = names.filter((n) => !(n in map));
  if (missing.length > 0) {
    // Fail loudly at startup rather than silently no-op'ing a command at runtime — this only
    // fires if a future edit adds a common name without updating both platform registries.
    throw new Error(`${mapLabel} on ${process.platform} is missing entries for: ${missing.join(", ")}`);
  }
}
checkCoverage(common.KEY_PHRASE_NAMES, platform.KEY_SPECS, "KEY_SPECS");
checkCoverage(common.SETTINGS_PANE_NAMES, platform.SETTINGS_PANES, "SETTINGS_PANES");
checkCoverage(common.LOCATION_NAMES, platform.LOCATIONS, "LOCATIONS");
