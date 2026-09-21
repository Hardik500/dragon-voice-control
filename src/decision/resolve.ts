import { SETTINGS_PANES, FINDER_LOCATIONS, KEY_PHRASES } from "../commands/registry";
import { Direction, ExtractedPayload, Intent, JevAnswerSummary, ResolvedCommand } from "../types/pipeline";
import { JevAnswers } from "./jev-client";

/** Intents that may execute from a confident interim transcript (closed, low-risk-of-truncation commands). */
export const INTERIM_ELIGIBLE_INTENTS: ReadonlySet<Intent> = new Set([
  "open_app",
  "activate_app",
  "hide_app",
  "quit_app",
  "switch_previous_app",
  "press_key",
  "shortcut",
  "window_minimize",
  "window_maximize",
  "window_fullscreen",
  "window_close",
  "volume_up",
  "volume_down",
  "volume_mute",
  "volume_unmute",
  "media_play_pause",
  "media_next",
  "media_previous",
  "chrome_back",
  "chrome_forward",
  "chrome_reload",
  "chrome_new_tab",
  "chrome_close_tab",
  "chrome_switch_tab",
  "chrome_scroll",
]);

export function summarizeAnswers(answers: JevAnswers): JevAnswerSummary {
  return {
    addressed: answers.addressed ? answers.addressed.noul : null,
    complete: answers.complete.noul,
    intent: answers.intent.choice as Intent,
    intentConfidence: answers.intent.confidence,
    target: answers.target.choice,
    targetConfidence: answers.target.confidence,
    direction: answers.direction.choice as Direction,
  };
}

function findAppNameForTarget(target: string, payload: ExtractedPayload): string | undefined {
  const cand = payload.appCandidates.find((c) => c.id === target);
  if (cand) return cand.appName;
  if (payload.appCandidates.length > 0) return payload.appCandidates[0].appName;
  return undefined;
}

function findElementIdForTarget(target: string, payload: ExtractedPayload): string | undefined {
  if (target.startsWith("element:")) {
    const id = target.slice("element:".length);
    if (payload.browserElementCandidates.some((c) => c.id === id)) return id;
  }
  if (payload.browserElementCandidates.length > 0) return payload.browserElementCandidates[0].id;
  return undefined;
}

/**
 * Combine Jev's typed decision with deterministically-extracted payload
 * spans into one concrete, executable command. Returns null when the
 * command cannot be resolved (missing required payload).
 */
export function resolveCommand(summary: JevAnswerSummary, payload: ExtractedPayload): ResolvedCommand | null {
  const { intent, target, direction } = summary;

  switch (intent) {
    case "open_app":
    case "activate_app":
    case "hide_app":
    case "quit_app": {
      const appName = findAppNameForTarget(target, payload);
      if (!appName) return null;
      return { kind: intent, appName };
    }
    case "switch_previous_app":
      return { kind: intent };
    case "type_text": {
      if (!payload.dictatedText) return null;
      return { kind: intent, text: payload.dictatedText };
    }
    case "press_key": {
      const key = payload.keyName;
      if (!key || !(key in KEY_PHRASES)) return null;
      return { kind: intent, keyName: key };
    }
    case "shortcut": {
      const key = payload.keyName;
      if (!key || !(key in KEY_PHRASES)) return null;
      return { kind: intent, keyName: key };
    }
    case "window_minimize":
    case "window_maximize":
    case "window_fullscreen":
    case "window_close":
      return { kind: intent };
    case "volume_up":
    case "volume_down":
    case "volume_mute":
    case "volume_unmute":
      return { kind: intent };
    case "volume_set": {
      if (payload.number == null) return null;
      return { kind: intent, amount: Math.max(0, Math.min(100, payload.number)) };
    }
    case "media_play_pause":
    case "media_next":
    case "media_previous":
      return { kind: intent };
    case "open_settings_pane": {
      const pane = payload.settingsPane;
      if (!pane || !(pane in SETTINGS_PANES)) return null;
      return { kind: intent, pane };
    }
    case "open_finder_location": {
      const loc = payload.finderLocation;
      if (!loc || !(loc in FINDER_LOCATIONS)) return null;
      return { kind: intent, location: loc };
    }
    case "chrome_open_url": {
      if (!payload.url) return null;
      return { kind: intent, url: payload.url };
    }
    case "chrome_search": {
      if (!payload.searchQuery) return null;
      return { kind: intent, query: payload.searchQuery };
    }
    case "chrome_click": {
      const elementId = findElementIdForTarget(target, payload);
      if (!elementId) return null;
      return { kind: intent, elementId };
    }
    case "chrome_type": {
      const elementId = findElementIdForTarget(target, payload);
      if (!elementId || !payload.dictatedText) return null;
      return { kind: intent, elementId, text: payload.dictatedText };
    }
    case "chrome_select": {
      const elementId = findElementIdForTarget(target, payload);
      if (!elementId) return null;
      return { kind: intent, elementId, text: payload.dictatedText ?? undefined };
    }
    case "chrome_scroll":
      return { kind: intent, direction };
    case "chrome_back":
    case "chrome_forward":
    case "chrome_reload":
    case "chrome_new_tab":
    case "chrome_close_tab":
      return { kind: intent };
    case "chrome_switch_tab":
      return { kind: intent, direction };
    case "none":
    default:
      return null;
  }
}
