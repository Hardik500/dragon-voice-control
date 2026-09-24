import { KEY_PHRASE_NAMES, LOCATION_NAMES, SETTINGS_PANE_NAMES } from "../commands/registry";
import { AppCandidate, Direction, ExtractedPayload, Intent, JevAnswerSummary, ResolvedCommand } from "../types/pipeline";
import { extractDeleteScope } from "./extract";
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
  "insert_newline",
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

function findAppCandidateForTarget(target: string, payload: ExtractedPayload): AppCandidate | undefined {
  const cand = payload.appCandidates.find((c) => c.id === target);
  if (cand) return cand;
  if (payload.appCandidates.length > 0) return payload.appCandidates[0];
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

/** "open/launch/start/switch to X" where X matched a known app alias is such an unambiguous,
 * extremely common pattern that we trust the deterministic extraction over an occasional Jev
 * misclassification (observed: "open cursor" sometimes scored intent "none" or "shortcut" at
 * low confidence, likely because "cursor" also reads as a UI concept). This is a deterministic
 * code override for one specific closed pattern, not a guardrail or a planner. */
const OPEN_APP_PATTERN = /^\s*(?:please\s+)?(?:open|launch|start|switch to|go to)\b/i;

function clickElementOverride(effectiveText: string, payload: ExtractedPayload): ResolvedCommand | null {
  if (payload.browserElementCandidates.length === 0) return null;
  if (!/^\s*(?:please\s+)?click\s+on\b/i.test(effectiveText)) return null;
  return { kind: "chrome_click", elementId: payload.browserElementCandidates[0].id };
}

function openAppOverride(effectiveText: string, payload: ExtractedPayload): ResolvedCommand | null {
  if (payload.appCandidates.length === 0) return null;
  // A URL is a more specific, more certain signal than an app-name substring match — without
  // this, "Open right.com on Chrome" matched "chrome" as an app candidate and the override
  // hijacked it into just re-activating Chrome, silently dropping the actual navigation.
  if (payload.url) return null;
  if (!OPEN_APP_PATTERN.test(effectiveText)) return null;
  const cand = payload.appCandidates[0];
  return { kind: "activate_app", appName: cand.label, appAlias: cand.appAlias };
}

/**
 * Combine Jev's typed decision with deterministically-extracted payload
 * spans into one concrete, executable command. Returns null when the
 * command cannot be resolved (missing required payload).
 */
export function resolveCommand(
  summary: JevAnswerSummary,
  payload: ExtractedPayload,
  effectiveText: string
): ResolvedCommand | null {
  const { intent, target, direction } = summary;

  // Deterministic override applies before Jev's intent is even trusted, but only for the
  // specific low-risk pattern above, and only when Jev didn't already choose a different,
  // clearly-intentional app-lifecycle intent (don't override "quit cursor"/"hide cursor").
  if (intent !== "quit_app" && intent !== "hide_app") {
    const override = openAppOverride(effectiveText, payload);
    if (override) return override;
  }

  // Jev occasionally labels an explicit "click on X" phrase as open_app when the page
  // element list is noisy. A page-element candidate makes the browser-click meaning concrete.
  if (intent !== "chrome_click") {
    const clickOverride = clickElementOverride(effectiveText, payload);
    if (clickOverride) return clickOverride;
  }

  switch (intent) {
    case "open_app":
    case "activate_app": {
      // "open X" with a concrete navigable target (a real URL/site was extracted) should
      // navigate there, not focus an app whose alias merely appears in the sentence as a
      // locative ("open right.com *on chrome*"). When there's no URL it's genuinely an app.
      if (payload.url) {
        return { kind: "chrome_open_url", url: payload.url };
      }
      const cand = findAppCandidateForTarget(target, payload);
      if (!cand) return null;
      return { kind: intent, appName: cand.label, appAlias: cand.appAlias };
    }
    case "hide_app":
    case "quit_app": {
      const cand = findAppCandidateForTarget(target, payload);
      if (!cand) return null;
      return { kind: intent, appName: cand.label, appAlias: cand.appAlias };
    }
    case "switch_previous_app":
      return { kind: intent };
    case "type_text": {
      if (!payload.dictatedText) return null;
      return { kind: intent, text: payload.dictatedText };
    }
    case "press_key": {
      const key = payload.keyName;
      if (!key || !KEY_PHRASE_NAMES.includes(key)) return null;
      return { kind: intent, keyName: key };
    }
    case "shortcut": {
      const key = payload.keyName;
      if (!key || !KEY_PHRASE_NAMES.includes(key)) return null;
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
      if (!pane || !SETTINGS_PANE_NAMES.includes(pane)) return null;
      return { kind: intent, pane };
    }
    case "open_finder_location": {
      const loc = payload.finderLocation;
      if (!loc || !LOCATION_NAMES.includes(loc)) return null;
      return { kind: intent, location: loc };
    }
    case "chrome_open_url": {
      if (!payload.url) return null;
      return { kind: intent, url: payload.url };
    }
    case "chrome_search": {
      if (!payload.searchQuery) return null;
      return { kind: intent, query: payload.searchQuery, url: payload.siteSearchUrl ?? undefined };
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
    case "insert_newline":
      return { kind: intent };
    case "search_in_app": {
      if (!payload.searchQuery) return null;
      return { kind: intent, query: payload.searchQuery };
    }
    case "delete_text": {
      // Usually handled deterministically in the pipeline's dictation fast-path (skips Jev
      // entirely); this is the fallback for when Jev recognized delete_text on a phrasing the
      // fast path's regexes didn't (e.g. an interim turn, or wording outside that closed set).
      // The pipeline still requires an active dictation session before actually executing —
      // there's nothing safe to delete otherwise without reading the target app's content.
      const scope = extractDeleteScope(effectiveText);
      if (!scope) return null;
      return { kind: intent, deleteScope: scope.scope, wordCount: scope.count };
    }
    case "replace_text": {
      if (!payload.replacePair) return null;
      const [find, replacement] = payload.replacePair;
      return { kind: intent, find, replacement };
    }
    case "none":
    default:
      return null;
  }
}
