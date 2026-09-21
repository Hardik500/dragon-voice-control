/**
 * Platform-neutral closed vocabularies. Only names/keys live here — the actual
 * per-platform representation (AppleScript key codes, Windows virtual-key codes,
 * `ms-settings:` URIs, folder paths, executable aliases) lives in
 * `registry-macos.ts` / `registry-windows.ts`. Shared code (extract.ts, resolve.ts,
 * decision/questions.ts) must only ever reference the names defined here, never a
 * platform-specific representation, per AGENTS.md's platform-boundary rule.
 */

export const KNOWN_WEBSITES: Record<string, string> = {
  google: "https://www.google.com",
  youtube: "https://www.youtube.com",
  "youtube music": "https://music.youtube.com",
  github: "https://www.github.com",
  amazon: "https://www.amazon.com",
  wikipedia: "https://www.wikipedia.org",
  reddit: "https://www.reddit.com",
  gmail: "https://mail.google.com",
  maps: "https://maps.google.com",
  netflix: "https://www.netflix.com",
  twitter: "https://www.twitter.com",
  x: "https://www.x.com",
  facebook: "https://www.facebook.com",
  linkedin: "https://www.linkedin.com",
};

/**
 * When Chrome is already on a page whose hostname matches one of these
 * fragments, "search for X" searches that site directly (via a URL template,
 * no DOM access needed) instead of falling back to a generic Google search.
 * This is how "open youtube music" then "search for X" plays the right thing
 * without any multi-step planning: two ordinary sequential commands, and the
 * second one is simply hostname-aware.
 */
export const SITE_SEARCH_TEMPLATES: Array<{ hostnameIncludes: string; buildUrl: (query: string) => string }> = [
  { hostnameIncludes: "music.youtube.com", buildUrl: (q) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}` },
  { hostnameIncludes: "youtube.com", buildUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
  { hostnameIncludes: "amazon.", buildUrl: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}` },
  { hostnameIncludes: "github.com", buildUrl: (q) => `https://github.com/search?q=${encodeURIComponent(q)}` },
  { hostnameIncludes: "reddit.com", buildUrl: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}` },
  { hostnameIncludes: "wikipedia.org", buildUrl: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
  { hostnameIncludes: "netflix.com", buildUrl: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
  { hostnameIncludes: "x.com", buildUrl: (q) => `https://x.com/search?q=${encodeURIComponent(q)}` },
  { hostnameIncludes: "twitter.com", buildUrl: (q) => `https://x.com/search?q=${encodeURIComponent(q)}` },
];

/**
 * Canonical semantic key/shortcut names. Both `registry-macos.ts` and
 * `registry-windows.ts` must provide a `KEY_SPECS` entry for every name here —
 * `scripts/check-registries.ts`-style coverage is enforced at runtime in
 * `commands/registry.ts` (throws on a missing platform entry).
 */
export const KEY_PHRASE_NAMES: string[] = [
  "enter", "return", "escape", "tab", "space", "delete", "backspace", "delete word",
  "arrow up", "arrow down", "arrow left", "arrow right", "up", "down", "left", "right",
  "page up", "page down", "home", "end",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "copy", "cut", "paste", "select all", "undo", "redo", "save", "find",
  "new tab", "close tab", "close window", "quit", "refresh", "reload",
  "quick switcher",
];

export const SETTINGS_PANE_NAMES: string[] = [
  "sound", "volume", "wifi", "wi-fi", "network", "bluetooth", "displays", "display",
  "general", "privacy", "security", "battery", "keyboard", "mouse", "notifications",
];

export const LOCATION_NAMES: string[] = [
  "downloads", "documents", "desktop", "home", "pictures", "music", "applications", "trash",
];
