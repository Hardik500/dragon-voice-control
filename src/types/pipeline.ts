/** Shared types for the transcript -> decision -> action pipeline. */

export interface TranscriptEvent {
  utteranceId: string;
  turnIndex: number;
  event: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  transcript: string;
  isFinal: boolean;
  endOfTurnConfidence: number;
  receivedAt: number;
}

export interface BrowserElementCandidate {
  id: string;
  tag: string;
  role: string;
  text: string;
  score: number;
}

export interface BrowserPageState {
  connected: boolean;
  url: string;
  title: string;
  focusedElementId: string | null;
  elements: BrowserElementCandidate[];
}

export interface AppCandidate {
  id: string;
  /** Friendly display name (for Jev target descriptions, overlay, history, voice replies). */
  label: string;
  /** The matched registry alias key (e.g. "chrome"), passed to `automation.*` for execution.
   * Each platform resolves this to its own executable representation independently. */
  appAlias: string;
  score: number;
}

export interface ExtractedPayload {
  appCandidates: AppCandidate[];
  dictatedText: string | null;
  url: string | null;
  /** Set when Chrome is on a known site (e.g. music.youtube.com) whose own search should be
   * used instead of a generic Google search for this utterance's search query. */
  siteSearchUrl: string | null;
  searchQuery: string | null;
  number: number | null;
  keyName: string | null;
  browserElementCandidates: BrowserElementCandidate[];
  settingsPane: string | null;
  finderLocation: string | null;
  /** delete_text: how many trailing words, if a number/word-count was spoken. */
  deleteWordCount: number | null;
  /** replace_text: [find, replacement], extracted verbatim from "replace X with Y". */
  replacePair: [string, string] | null;
}

export type Intent =
  | "open_app"
  | "activate_app"
  | "hide_app"
  | "quit_app"
  | "switch_previous_app"
  | "type_text"
  | "press_key"
  | "shortcut"
  | "window_minimize"
  | "window_maximize"
  | "window_fullscreen"
  | "window_close"
  | "volume_up"
  | "volume_down"
  | "volume_set"
  | "volume_mute"
  | "volume_unmute"
  | "media_play_pause"
  | "media_next"
  | "media_previous"
  | "open_settings_pane"
  | "open_finder_location"
  | "chrome_open_url"
  | "chrome_search"
  | "chrome_click"
  | "chrome_type"
  | "chrome_select"
  | "chrome_scroll"
  | "chrome_back"
  | "chrome_forward"
  | "chrome_reload"
  | "chrome_new_tab"
  | "chrome_close_tab"
  | "chrome_switch_tab"
  | "delete_text"
  | "replace_text"
  | "insert_newline"
  | "search_in_app"
  | "none";

/** How much of the current dictation buffer a `delete_text` command should remove. */
export type DeleteScope = "words" | "last_dictation" | "all";

export type Direction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "next"
  | "previous"
  | "increase"
  | "decrease"
  | "top"
  | "bottom"
  | "none";

export interface JevAnswerSummary {
  addressed: number | null;
  complete: number;
  intent: Intent;
  intentConfidence: number;
  target: string;
  targetConfidence: number;
  direction: Direction;
}

export interface ResolvedCommand {
  kind: Intent;
  /** Friendly display name (overlay/history/voice replies). */
  appName?: string;
  /** Registry alias key passed to `automation.*` for execution. */
  appAlias?: string;
  text?: string;
  url?: string;
  query?: string;
  amount?: number;
  keyName?: string;
  elementId?: string;
  direction?: Direction;
  pane?: string;
  location?: string;
  /** delete_text */
  deleteScope?: DeleteScope;
  wordCount?: number;
  /** replace_text */
  find?: string;
  replacement?: string;
}

export interface PipelineStageTiming {
  sttMs?: number;
  decisionMs?: number;
  executionMs?: number;
}

export interface OverlayUpdate {
  utteranceId: string;
  state: "listening" | "thinking" | "executing" | "done" | "error" | "idle";
  transcript: string;
  isFinal: boolean;
  action: string | null;
  status: string | null;
  latencyMs: number | null;
  activationMode: string;
}

export interface HistoryEntry {
  utteranceId: string;
  timestamp: number;
  transcript: string;
  intent: Intent;
  action: string;
  status: "success" | "error" | "ignored";
  detail: string;
}
