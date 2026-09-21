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
  label: string;
  appName: string;
  score: number;
}

export interface ExtractedPayload {
  appCandidates: AppCandidate[];
  dictatedText: string | null;
  url: string | null;
  searchQuery: string | null;
  number: number | null;
  keyName: string | null;
  browserElementCandidates: BrowserElementCandidate[];
  settingsPane: string | null;
  finderLocation: string | null;
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
  | "none";

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
  appName?: string;
  text?: string;
  url?: string;
  query?: string;
  amount?: number;
  keyName?: string;
  elementId?: string;
  direction?: Direction;
  pane?: string;
  location?: string;
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
