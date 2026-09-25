export type ActivationMode = "push_to_talk" | "always_listening";
export type DecisionProvider = "jev" | "laya";

export type LogVerbosity = "normal" | "verbose";

export interface DragonSettings {
  openRouterApiKey: string;
  deepgramApiKey: string;
  activationMode: ActivationMode;
  decisionProvider: DecisionProvider;
  layaBaseUrl: string;
  layaModel: string;
  pushToTalkShortcut: string;
  emergencyStopShortcut: string;
  insertModeShortcut: string;
  workflowModeShortcut: string;
  voiceReplyEnabled: boolean;
  logVerbosity: LogVerbosity;
  overlayVisible: boolean;
}

// macOS's Alt+Space/Alt+Escape defaults conflict with common Windows shortcuts (Alt+Space
// opens the window system menu on Windows), so Windows gets its own defaults per DECISIONS.md.
// Settings already saved before an upgrade keep whatever was persisted; this only affects a
// fresh install's first-run values.
const DEFAULT_PUSH_TO_TALK_SHORTCUT = process.platform === "win32" ? "Control+Alt+D" : "Alt+Space";
const DEFAULT_EMERGENCY_STOP_SHORTCUT = process.platform === "win32" ? "Control+Alt+Escape" : "Alt+Escape";
const DEFAULT_INSERT_MODE_SHORTCUT = "Control+Alt+I";
const DEFAULT_WORKFLOW_MODE_SHORTCUT = "Control+Alt+Shift+W";

export const DEFAULT_SETTINGS: DragonSettings = {
  openRouterApiKey: "",
  deepgramApiKey: "",
  activationMode: "push_to_talk",
  decisionProvider: "jev",
  layaBaseUrl: "http://127.0.0.1:8000",
  layaModel: "laya",
  pushToTalkShortcut: DEFAULT_PUSH_TO_TALK_SHORTCUT,
  emergencyStopShortcut: DEFAULT_EMERGENCY_STOP_SHORTCUT,
  insertModeShortcut: DEFAULT_INSERT_MODE_SHORTCUT,
  workflowModeShortcut: DEFAULT_WORKFLOW_MODE_SHORTCUT,
  voiceReplyEnabled: true,
  logVerbosity: "normal",
  overlayVisible: true,
};

/** Settings sent to renderer windows never include secret key material verbatim. */
export interface RendererSafeSettings extends Omit<DragonSettings, "openRouterApiKey" | "deepgramApiKey"> {
  hasOpenRouterKey: boolean;
  hasDeepgramKey: boolean;
}

export function toRendererSafe(settings: DragonSettings): RendererSafeSettings {
  const { openRouterApiKey, deepgramApiKey, ...rest } = settings;
  return {
    ...rest,
    hasOpenRouterKey: openRouterApiKey.trim().length > 0,
    hasDeepgramKey: deepgramApiKey.trim().length > 0,
  };
}
