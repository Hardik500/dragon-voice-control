/** Windows-specific closed vocabularies: app aliases, virtual-key specs, Settings URIs, folders. */

export interface WinAppAlias {
  /** Passed to `cmd /c start "" <token>` to launch — a bare command resolvable via PATH or
   * the Windows "App Paths" registry (what Win+R uses), a full path, or a URI. Windows has
   * no single equivalent of macOS's `open -a "<App Name>"`, so third-party apps here are
   * best-effort: they work if the app is on PATH or registered its own App Paths key (most
   * installers for well-known apps do; some per-user/appx installs don't). See PROGRESS.md. */
  launchToken: string;
  /** Base process name (no `.exe`) used to find an already-running window via `Get-Process`. */
  processName: string;
  /** Friendly display name for logs/overlay/voice replies. Falls back to `processName`. */
  label?: string;
}

export const APP_ALIASES: Record<string, WinAppAlias> = {
  notepad: { launchToken: "notepad", processName: "notepad", label: "Notepad" },
  chrome: { launchToken: "chrome", processName: "chrome", label: "Google Chrome" },
  "google chrome": { launchToken: "chrome", processName: "chrome", label: "Google Chrome" },
  browser: { launchToken: "chrome", processName: "chrome", label: "Google Chrome" },
  edge: { launchToken: "msedge", processName: "msedge", label: "Microsoft Edge" },
  firefox: { launchToken: "firefox", processName: "firefox", label: "Firefox" },
  finder: { launchToken: "explorer", processName: "explorer", label: "File Explorer" },
  explorer: { launchToken: "explorer", processName: "explorer", label: "File Explorer" },
  "file explorer": { launchToken: "explorer", processName: "explorer", label: "File Explorer" },
  terminal: { launchToken: "wt", processName: "WindowsTerminal", label: "Windows Terminal" },
  "command prompt": { launchToken: "cmd", processName: "cmd", label: "Command Prompt" },
  powershell: { launchToken: "powershell", processName: "powershell", label: "PowerShell" },
  calculator: { launchToken: "calc", processName: "CalculatorApp", label: "Calculator" },
  paint: { launchToken: "mspaint", processName: "mspaint", label: "Paint" },
  wordpad: { launchToken: "write", processName: "wordpad", label: "WordPad" },
  settings: { launchToken: "ms-settings:", processName: "SystemSettings", label: "Settings" },
  "system settings": { launchToken: "ms-settings:", processName: "SystemSettings", label: "Settings" },
  "system preferences": { launchToken: "ms-settings:", processName: "SystemSettings", label: "Settings" },
  photos: { launchToken: "ms-photos:", processName: "Photos", label: "Photos" },
  maps: { launchToken: "bingmaps:", processName: "Maps", label: "Maps" },
  "app store": { launchToken: "ms-windows-store:", processName: "WinStore.App", label: "Microsoft Store" },
  "microsoft store": { launchToken: "ms-windows-store:", processName: "WinStore.App", label: "Microsoft Store" },
  "task manager": { launchToken: "taskmgr", processName: "Taskmgr", label: "Task Manager" },
  activity: { launchToken: "taskmgr", processName: "Taskmgr", label: "Task Manager" },
  "activity monitor": { launchToken: "taskmgr", processName: "Taskmgr", label: "Task Manager" },
  spotify: { launchToken: "spotify", processName: "Spotify", label: "Spotify" },
  slack: { launchToken: "slack", processName: "slack", label: "Slack" },
  discord: { launchToken: "discord", processName: "Discord", label: "Discord" },
  zoom: { launchToken: "zoom", processName: "Zoom", label: "Zoom" },
  whatsapp: { launchToken: "whatsapp", processName: "WhatsApp", label: "WhatsApp" },
  telegram: { launchToken: "telegram", processName: "Telegram", label: "Telegram" },
  notion: { launchToken: "notion", processName: "Notion", label: "Notion" },
  obsidian: { launchToken: "obsidian", processName: "Obsidian", label: "Obsidian" },
  figma: { launchToken: "figma", processName: "Figma", label: "Figma" },
  postman: { launchToken: "postman", processName: "Postman", label: "Postman" },
  "visual studio code": { launchToken: "code", processName: "Code", label: "Visual Studio Code" },
  vscode: { launchToken: "code", processName: "Code", label: "Visual Studio Code" },
  code: { launchToken: "code", processName: "Code", label: "Visual Studio Code" },
  cursor: { launchToken: "cursor", processName: "Cursor", label: "Cursor" },
  antigravity: { launchToken: "Antigravity", processName: "Antigravity", label: "Antigravity" },
  "sublime text": { launchToken: "sublime_text", processName: "sublime_text", label: "Sublime Text" },
  sublime: { launchToken: "sublime_text", processName: "sublime_text", label: "Sublime Text" },
  warp: { launchToken: "warp", processName: "Warp", label: "Warp" },
  docker: { launchToken: "Docker Desktop", processName: "Docker Desktop", label: "Docker Desktop" },
  "docker desktop": { launchToken: "Docker Desktop", processName: "Docker Desktop", label: "Docker Desktop" },
  notes: { launchToken: "onenote:", processName: "ONENOTE", label: "OneNote" },
  teams: { launchToken: "ms-teams:", processName: "ms-teams", label: "Microsoft Teams" },
  "microsoft word": { launchToken: "winword", processName: "WINWORD", label: "Microsoft Word" },
  word: { launchToken: "winword", processName: "WINWORD", label: "Microsoft Word" },
  excel: { launchToken: "excel", processName: "EXCEL", label: "Microsoft Excel" },
  powerpoint: { launchToken: "powerpnt", processName: "POWERPNT", label: "Microsoft PowerPoint" },
  outlook: { launchToken: "outlook", processName: "OUTLOOK", label: "Microsoft Outlook" },
  mail: { launchToken: "outlookmail:", processName: "olk", label: "Mail" },
};

export interface WinKeySpec {
  vk?: number; // explicit virtual-key code, for non-letter keys
  char?: string; // single letter; VK code is its uppercase ASCII code (a documented Windows quirk)
  modifiers: Array<"ctrl" | "alt" | "shift" | "win">;
}

/** Must cover every name in `commands/registry-common.ts`'s `KEY_PHRASE_NAMES`. */
export const KEY_SPECS: Record<string, WinKeySpec> = {
  enter: { vk: 0x0d, modifiers: [] },
  return: { vk: 0x0d, modifiers: [] },
  escape: { vk: 0x1b, modifiers: [] },
  tab: { vk: 0x09, modifiers: [] },
  space: { vk: 0x20, modifiers: [] },
  delete: { vk: 0x2e, modifiers: [] },
  backspace: { vk: 0x08, modifiers: [] },
  "delete word": { vk: 0x08, modifiers: ["ctrl"] },
  "arrow up": { vk: 0x26, modifiers: [] },
  "arrow down": { vk: 0x28, modifiers: [] },
  "arrow left": { vk: 0x25, modifiers: [] },
  "arrow right": { vk: 0x27, modifiers: [] },
  up: { vk: 0x26, modifiers: [] },
  down: { vk: 0x28, modifiers: [] },
  left: { vk: 0x25, modifiers: [] },
  right: { vk: 0x27, modifiers: [] },
  "page up": { vk: 0x21, modifiers: [] },
  "page down": { vk: 0x22, modifiers: [] },
  home: { vk: 0x24, modifiers: [] },
  end: { vk: 0x23, modifiers: [] },
  f1: { vk: 0x70, modifiers: [] },
  f2: { vk: 0x71, modifiers: [] },
  f3: { vk: 0x72, modifiers: [] },
  f4: { vk: 0x73, modifiers: [] },
  f5: { vk: 0x74, modifiers: [] },
  f6: { vk: 0x75, modifiers: [] },
  f7: { vk: 0x76, modifiers: [] },
  f8: { vk: 0x77, modifiers: [] },
  f9: { vk: 0x78, modifiers: [] },
  f10: { vk: 0x79, modifiers: [] },
  f11: { vk: 0x7a, modifiers: [] },
  f12: { vk: 0x7b, modifiers: [] },
  copy: { char: "c", modifiers: ["ctrl"] },
  cut: { char: "x", modifiers: ["ctrl"] },
  paste: { char: "v", modifiers: ["ctrl"] },
  "select all": { char: "a", modifiers: ["ctrl"] },
  undo: { char: "z", modifiers: ["ctrl"] },
  redo: { char: "y", modifiers: ["ctrl"] },
  save: { char: "s", modifiers: ["ctrl"] },
  find: { char: "f", modifiers: ["ctrl"] },
  "new tab": { char: "t", modifiers: ["ctrl"] },
  "close tab": { char: "w", modifiers: ["ctrl"] },
  "close window": { vk: 0x73, modifiers: ["alt"] }, // Alt+F4: no universal Ctrl+W-style "close window" on Windows
  quit: { vk: 0x73, modifiers: ["alt"] }, // Windows has no universal quit shortcut either; Alt+F4 is the closest equivalent
  refresh: { vk: 0x74, modifiers: [] }, // F5 is the universal Windows refresh key (browsers, Explorer, etc.)
  reload: { vk: 0x74, modifiers: [] },
  "quick switcher": { char: "k", modifiers: ["ctrl"] },
};

/** Voice phrase -> `ms-settings:` URI (best effort; some pages moved/renamed across Windows releases). */
export const SETTINGS_PANES: Record<string, string> = {
  sound: "ms-settings:sound",
  volume: "ms-settings:sound",
  wifi: "ms-settings:network-wifi",
  "wi-fi": "ms-settings:network-wifi",
  network: "ms-settings:network",
  bluetooth: "ms-settings:bluetooth",
  displays: "ms-settings:display",
  display: "ms-settings:display",
  general: "ms-settings:",
  privacy: "ms-settings:privacy",
  security: "ms-settings:windowsdefender",
  battery: "ms-settings:batterysaver",
  keyboard: "ms-settings:easeofaccess-keyboard",
  mouse: "ms-settings:mousetouchpad",
  notifications: "ms-settings:notifications",
};

/**
 * Voice phrase -> File Explorer location. A plain string is a folder under the user's
 * profile; a `shell:` value is passed to `explorer.exe` as-is (a special shell namespace).
 */
export const LOCATIONS: Record<string, string> = {
  downloads: "Downloads",
  documents: "Documents",
  desktop: "Desktop",
  home: "",
  pictures: "Pictures",
  music: "Music",
  applications: "shell:AppsFolder",
  trash: "shell:RecycleBinFolder",
};
