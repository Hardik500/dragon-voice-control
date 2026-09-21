import { AppCandidate, BrowserElementCandidate, BrowserPageState, ExtractedPayload, Intent } from "../types/pipeline";

/** Descriptions shown to Jev for the `intent` Choice question. Keep atomic and mutually exclusive. */
export const INTENT_CRITERIA: Record<Intent, string> = {
  open_app: "Launch or open a named application that may not be running yet.",
  activate_app: "Bring an already-relevant named application to the foreground.",
  hide_app: "Hide the named or current application from view without quitting it.",
  quit_app: "Quit/close the named or current application entirely.",
  switch_previous_app: "Switch focus back to the previously used application (command+tab style).",
  type_text: "Type or enter specific dictated text into the currently focused text field.",
  press_key: "Press a single named key such as enter, escape, tab, an arrow, or a function key.",
  shortcut: "Perform a known keyboard shortcut such as copy, cut, paste, select all, undo, redo, save, or find.",
  window_minimize: "Minimize the active window.",
  window_maximize: "Maximize/zoom the active window.",
  window_fullscreen: "Toggle fullscreen for the active window.",
  window_close: "Close the active window.",
  volume_up: "Increase the system output volume by a step.",
  volume_down: "Decrease the system output volume by a step.",
  volume_set: "Set the system output volume to a specific percentage mentioned in the transcript.",
  volume_mute: "Mute system audio output.",
  volume_unmute: "Unmute system audio output.",
  media_play_pause: "Toggle play/pause of the current media player.",
  media_next: "Skip to the next media track.",
  media_previous: "Go to the previous media track.",
  open_settings_pane: "Open a named macOS System Settings pane.",
  open_finder_location: "Open a named Finder location such as Downloads or Desktop.",
  chrome_open_url: "Open a specific URL or a named website in Chrome.",
  chrome_search: "Perform a web search (or search the current site) in Chrome.",
  chrome_click: "Click a specific visible link, button, or other interactive element in the Chrome page.",
  chrome_type: "Type dictated text into a specific visible field in the Chrome page.",
  chrome_select: "Select an option in a specific visible dropdown/select element in the Chrome page.",
  chrome_scroll: "Scroll the current Chrome page up, down, to the top, or to the bottom.",
  chrome_back: "Navigate the current Chrome tab back in history.",
  chrome_forward: "Navigate the current Chrome tab forward in history.",
  chrome_reload: "Reload the current Chrome tab.",
  chrome_new_tab: "Open a new Chrome tab.",
  chrome_close_tab: "Close the current Chrome tab.",
  chrome_switch_tab: "Switch to the next or previous Chrome tab.",
  none: "The transcript is not a recognizable command from this list, or is incidental speech.",
};

export const DIRECTION_CRITERIA: Record<string, string> = {
  up: "Upward, increase, or scroll toward the top.",
  down: "Downward, decrease, or scroll toward the bottom.",
  left: "Toward the left.",
  right: "Toward the right.",
  next: "The next item, e.g. next tab or next track.",
  previous: "The previous item, e.g. previous tab or previous track.",
  increase: "Increase a value such as volume.",
  decrease: "Decrease a value such as volume.",
  top: "All the way to the top/beginning.",
  bottom: "All the way to the bottom/end.",
  none: "No direction applies to this command.",
};

export interface TargetCandidateMeta {
  id: string;
  description: string;
}

export function buildTargetCandidates(payload: ExtractedPayload): TargetCandidateMeta[] {
  const out: TargetCandidateMeta[] = [];
  for (const app of payload.appCandidates as AppCandidate[]) {
    out.push({ id: app.id, description: `Application named "${app.appName}" mentioned in the transcript.` });
  }
  for (const el of payload.browserElementCandidates as BrowserElementCandidate[]) {
    const label = el.text.slice(0, 80) || "(unlabeled)";
    out.push({ id: `element:${el.id}`, description: `${el.role || el.tag} on the current Chrome page labeled "${label}".` });
  }
  out.push({ id: "none", description: "No specific application or page element is targeted by this command." });
  return out;
}

export interface JevQuestionSet {
  addressed?: { type: "noul"; instructions: string };
  complete: { type: "noul"; instructions: string };
  intent: { type: "choice"; instructions: string; criteria: Record<string, string> };
  target: { type: "choice"; instructions: string; criteria: Record<string, string> };
  direction: { type: "choice"; instructions: string; criteria: Record<string, string> };
}

export function buildQuestions(opts: {
  includeAddressed: boolean;
  targetCandidates: TargetCandidateMeta[];
}): JevQuestionSet {
  const targetCriteria: Record<string, string> = {};
  for (const c of opts.targetCandidates) targetCriteria[c.id] = c.description;

  const questions: JevQuestionSet = {
    complete: {
      type: "noul",
      instructions:
        "The transcript is a complete, executable command with no missing target or trailing hesitation (not cut off mid-sentence).",
    },
    intent: {
      type: "choice",
      instructions: "What action does the transcript ask the assistant to perform?",
      criteria: INTENT_CRITERIA,
    },
    target: {
      type: "choice",
      instructions:
        "Which candidate target (application or page element extracted from the transcript/page) does the command refer to, if any?",
      criteria: targetCriteria,
    },
    direction: {
      type: "choice",
      instructions: "What direction or amount, if any, applies to the command (scrolling, volume, tabs, media)?",
      criteria: DIRECTION_CRITERIA,
    },
  };

  if (opts.includeAddressed) {
    questions.addressed = {
      type: "noul",
      instructions:
        'The speech is a direct command addressed to a voice assistant named "Dragon", not incidental background conversation or speech directed at another person.',
    };
  }

  return questions;
}

export function buildState(opts: {
  transcript: string;
  activeApp: string | null;
  browserPage: BrowserPageState | null;
}): string {
  const lines: string[] = [`Transcript: "${opts.transcript}"`];
  if (opts.activeApp) lines.push(`Active application: ${opts.activeApp}`);
  if (opts.browserPage?.connected) {
    lines.push(`Chrome page URL: ${opts.browserPage.url}`);
    lines.push(`Chrome page title: ${opts.browserPage.title}`);
  }
  return lines.join("\n");
}
