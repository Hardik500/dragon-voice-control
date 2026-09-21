export type ActivationMode = "push_to_talk" | "wake_word" | "always_listening";

export type LogVerbosity = "normal" | "verbose";

export interface DragonSettings {
  openRouterApiKey: string;
  deepgramApiKey: string;
  activationMode: ActivationMode;
  pushToTalkShortcut: string;
  emergencyStopShortcut: string;
  wakePhrase: string;
  voiceReplyEnabled: boolean;
  logVerbosity: LogVerbosity;
  overlayVisible: boolean;
}

export const DEFAULT_SETTINGS: DragonSettings = {
  openRouterApiKey: "",
  deepgramApiKey: "",
  activationMode: "push_to_talk",
  pushToTalkShortcut: "Alt+Space",
  emergencyStopShortcut: "Alt+Escape",
  wakePhrase: "Dragon",
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
