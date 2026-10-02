import { nativeImage, NativeImage } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DeepgramFluxConnection } from "../stt/deepgram-client";
import { BrowserBridge } from "../browser/server";
import { logger } from "../logging/logger";
import { automation } from "../automation";
import { extractDeleteScope, extractKeyName, extractPayload, extractReplacePair, extractWorkflowSteps, isStandaloneKeyboardCommand, shouldTypeDirectlyInInsertMode } from "../decision/extract";
import { buildQuestions, buildState, buildTargetCandidates } from "../decision/questions";
import { askDisambiguationChoice, callDecisionProvider, DecisionCancelledError, DecisionProviderConfig, DecisionRequestError } from "../decision/jev-client";
import { Box, dedupeMatches, LocatedPoint, locateElements, labelExact, labelMatches, labelTokens, readLabelAtPoint } from "../decision/vision-client";
import { INTERIM_ELIGIBLE_INTENTS, isDeterministicAppLaunch, isDeterministicScreenClick, resolveCommand, summarizeAnswers } from "../decision/resolve";
import { BrowserAction } from "../types/browser-protocol";
import { HistoryEntry, JevAnswerSummary, JevDecisionOutcome, JevDecisionTrace, OverlayUpdate, ResolvedCommand, TranscriptEvent } from "../types/pipeline";
import { DragonSettings } from "../types/settings";
import { HistoryStore } from "./history-store";

const MAX_IN_FLIGHT_DECISIONS = 2;
const JEV_ADDRESSED_THRESHOLD = 0.55;
const LAYA_ADDRESSED_THRESHOLD = 0.5;
const INTENT_CONFIDENCE_THRESHOLD = 0.35;
const COMPLETE_THRESHOLD = 0.5;
const INTERIM_EXEC_INTENT_CONFIDENCE = 0.6;
const INTERIM_EXEC_COMPLETE = 0.6;
const DEFAULT_DELETE_WORD_COUNT = 3;
const SCREEN_CLICK_DISAMBIGUATION_CONFIDENCE_THRESHOLD = 0.35; // mirrors INTENT_CONFIDENCE_THRESHOLD

type ScreenClickWindow = Awaited<ReturnType<typeof automation.captureFrontmostWindow>>;
type ScreenPoint = { x: number; y: number; label: string };
type ImageCrop = { imageBase64: string; width: number; height: number; offsetX: number; offsetY: number };

/** Crops `box` (clamped to the image) out of an already-decoded screenshot, as base64 JPEG.
 * Returns the crop's offset within the original image so the caller can translate points back. */
function cropImage(image: NativeImage, imageWidth: number, imageHeight: number, box: Box): ImageCrop {
  const offsetX = Math.min(imageWidth - 1, Math.max(0, Math.round(box.x0)));
  const offsetY = Math.min(imageHeight - 1, Math.max(0, Math.round(box.y0)));
  const width = Math.max(1, Math.min(imageWidth - offsetX, Math.round(box.x1) - offsetX));
  const height = Math.max(1, Math.min(imageHeight - offsetY, Math.round(box.y1) - offsetY));
  const cropped = image.crop({ x: offsetX, y: offsetY, width, height });
  const size = cropped.getSize();
  return { imageBase64: cropped.toJPEG(90).toString("base64"), width: size.width, height: size.height, offsetX, offsetY };
}

/** Box of ±margin (fraction of the full image's width/height) around a point. */
function boxAroundPoint(x: number, y: number, imageWidth: number, imageHeight: number, margin: { x: number; y: number }): Box {
  return { x0: x - imageWidth * margin.x, y0: y - imageHeight * margin.y, x1: x + imageWidth * margin.x, y1: y + imageHeight * margin.y };
}

/** Margins for the wide re-localization crop (used when the first point fails verification) vs
 * the narrow verification crop (used to independently read back what's actually at a point). */
const RELOCATE_CROP_MARGIN = { x: 0.25, y: 0.15 };
const VERIFY_CROP_MARGIN = { x: 0.06, y: 0.035 };
const VERIFY_BOX_PAD_PX = 8;
const DEBUG_IMAGE_PREFIX = "dragon-screenclick-";
const DEBUG_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Verification crop: the element's own box plus a small pad, but never smaller than the fixed
 * margin around its centre — so the read-back sees exactly the element the model claimed. */
function verifyBox(p: LocatedPoint, imageWidth: number, imageHeight: number): Box {
  const m = boxAroundPoint(p.x, p.y, imageWidth, imageHeight, VERIFY_CROP_MARGIN);
  return {
    x0: Math.min(m.x0, p.box.x0 - VERIFY_BOX_PAD_PX),
    y0: Math.min(m.y0, p.box.y0 - VERIFY_BOX_PAD_PX),
    x1: Math.max(m.x1, p.box.x1 + VERIFY_BOX_PAD_PX),
    y1: Math.max(m.y1, p.box.y1 + VERIFY_BOX_PAD_PX),
  };
}

/** Verifies all candidates concurrently. One failed read-back (timeout/5xx) only drops that
 * candidate; if every read-back fails, rethrows the first error so real API-key/network
 * problems stay visible instead of silently entering recovery. */
async function verifyCandidates(
  description: string,
  candidates: LocatedPoint[],
  verify: (p: LocatedPoint) => Promise<string>
): Promise<{ verified: ScreenPoint[]; readbacks: string[] }> {
  if (candidates.length === 0) return { verified: [], readbacks: [] };
  const results = await Promise.allSettled(candidates.map(verify));
  if (results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  const readbacks = results.map((r) => (r.status === "fulfilled" ? r.value : ""));
  const verified = candidates.flatMap((p, i) => (results[i].status === "fulfilled" && labelMatches(description, readbacks[i]) ? [{ x: p.x, y: p.y, label: readbacks[i] }] : []));
  return { verified, readbacks };
}

/** Saves the (frontmost-window-only) screenshot of a failed/ambiguous screen_click to the OS
 * temp dir for offline model comparison, and deletes ones older than 24h. Never uploaded. */
function saveScreenClickDebugImage(imageBase64: string, description: string, reason: string): void {
  const dir = os.tmpdir();
  const file = path.join(dir, `${DEBUG_IMAGE_PREFIX}${Date.now()}.jpg`);
  fs.promises
    .writeFile(file, Buffer.from(imageBase64, "base64"))
    .then(() => logger.event("screen_click.debug_image", { description, reason, path: file }))
    .catch(() => {});
  fs.promises
    .readdir(dir)
    .then((names) => {
      for (const n of names) {
        const ts = Number(n.slice(DEBUG_IMAGE_PREFIX.length, -4));
        if (n.startsWith(DEBUG_IMAGE_PREFIX) && Date.now() - ts > DEBUG_IMAGE_TTL_MS) fs.promises.unlink(path.join(dir, n)).catch(() => {});
      }
    })
    .catch(() => {});
}

/** Coarse positional description of a point within the window image, used to give Jev enough
 * context to tell apart multiple verified screen_click matches with the same/similar label
 * (e.g. two "General" rows in different panes) — see PROGRESS.md 2026-09-29. */
function describeRegion(x: number, y: number, imageWidth: number, imageHeight: number): string {
  const xPct = (x / imageWidth) * 100;
  const yPct = (y / imageHeight) * 100;
  const vert = yPct < 33 ? "near the top" : yPct < 66 ? "in the vertical middle" : "near the bottom";
  const horiz = xPct < 33 ? "on the left" : xPct < 66 ? "in the horizontal center" : "on the right";
  return `(${vert}, ${horiz} of the window)`;
}

function normalizeDecisionText(text: string): string {
  return text.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
}

/** Exact media-control commands that are unambiguous enough to bypass the addressed gate in
 * always-listening mode. Without this, Jev can correctly recognize "Pause." as media control
 * while still scoring it as incidental speech because "pause" is also an ordinary English word. */
const EXPLICIT_MEDIA_CONTROL_PATTERN = /^(?:play|pause|play\s*\/\s*pause|next(?:\s+track)?|previous(?:\s+track)?)[.!?]?$/i;

function isExplicitMediaControl(turn: TranscriptEvent, summary: JevAnswerSummary): boolean {
  if (!turn.isFinal || summary.intentConfidence < 0.9) return false;
  if (!EXPLICIT_MEDIA_CONTROL_PATTERN.test(turn.transcript.trim())) return false;
  return (
    summary.intent === "media_play_pause" ||
    summary.intent === "media_next" ||
    summary.intent === "media_previous"
  );
}

interface InFlight {
  utteranceId: string;
  controller: AbortController;
  startedAt: number;
}

type DictationControl =
  | { type: "start" }
  | { type: "stop" }
  | { type: "workflow_start" }
  | { type: "workflow_stop" }
  | { type: "key"; keyName: string }
  | { type: "browser_new_tab" }
  | { type: "newline" }
  | { type: "delete_all" }
  | { type: "delete_last_chunk" }
  | { type: "delete_words"; count: number }
  | { type: "replace"; find: string; replacement: string };

/** Used when a dictation edit is executed via the normal Jev-recognized path (e.g. the
 * deterministic fast-path in `onTurn` didn't match, but Jev independently recognized
 * `delete_text`/`replace_text`) — `runDictationControl` needs a `TranscriptEvent` shape for
 * its logging/overlay calls, but there's no real one at that call site. */
const SYNTHETIC_TURN: TranscriptEvent = {
  utteranceId: "",
  turnIndex: -1,
  event: "EndOfTurn",
  transcript: "",
  isFinal: true,
  endOfTurnConfidence: 1,
  turnStartedAt: Date.now(),
  receivedAt: Date.now(),
};

function deleteScopeToControl(scope: ReturnType<typeof extractDeleteScope>): DictationControl | null {
  if (!scope) return null;
  if (scope.scope === "all") return { type: "delete_all" };
  if (scope.scope === "words") return { type: "delete_words", count: scope.count ?? DEFAULT_DELETE_WORD_COUNT };
  return { type: "delete_last_chunk" };
}

function keepsDictationOpen(kind: ResolvedCommand["kind"]): boolean {
  return (
    kind === "type_text" ||
    kind === "insert_newline" ||
    kind === "press_key" ||
    kind === "shortcut" ||
    kind === "delete_text" ||
    kind === "replace_text"
  );
}

/** Thrown when the accessibility lookup found nothing; "auto" mode falls back to vision on it. */
class AccessibilityMissError extends Error {}
/** Not a failure: the click is ambiguous and `pendingChoice` now awaits a spoken number. */
class ChoiceRequiredError extends Error {}
const PENDING_CHOICE_TTL_MS = 15_000;

export class DragonPipeline {
  private deepgram: DeepgramFluxConnection | null = null;
  private lastActiveApp: string | null = null;
  private inFlight: InFlight[] = [];
  /** Serializes Jev work per utterance so EagerEndOfTurn cannot race the final EndOfTurn. */
  private decisionInFlightByUtterance = new Map<string, Promise<void>>();
  private executedUtterances = new Set<string>();
  /** Set while a resolved command is actually running (between the "executing" and "done"/
   * "error" overlay updates). Deepgram keeps streaming ambient audio during a slow command
   * (e.g. screen_click's screenshot+vision+click round trip), which fires StartOfTurn/Update
   * events for incidental noise — without this guard, onTurn's "listening" overlay push for
   * those events overwrote "Executing" almost immediately, making the loading state look like
   * it vanished before the command actually finished. Purely cosmetic: only gates the overlay
   * push, not turn processing. */
  private executingUtteranceId: string | null = null;
  private ignoredLoggedUtterances = new Set<string>();
  private utteranceCounter = 0;
  private micStreaming = false;
  /** Set right before an intentional close so the connection's `onClose` handler knows not
   * to auto-reconnect (see startStreaming's onClose callback). */
  private intentionalClose = false;
  /** Bumped on every startStreaming() call so a stale connection's delayed close (e.g. from
   * a graceful push-to-talk stop) can't trigger a reconnect after a newer one has already
   * taken over. */
  private streamGeneration = 0;
  /** Consecutive auto-reconnect attempts since the last successful connection; capped so a
   * persistently failing connection (bad key, network down) doesn't retry forever. */
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private history = new HistoryStore();
  /** Avoids asking Jev the exact same question twice for one utterance (e.g. EagerEndOfTurn
   * then EndOfTurn arriving with identical transcript text). Keyed by `${utteranceId}::${text}`. */
  private jevAnswerCache = new Map<string, JevAnswerSummary>();
  /** Bounded, session-only dashboard data. This is observability UI state, not command history. */
  private jevDecisionTraces: JevDecisionTrace[] = [];
  private static readonly MAX_JEV_DECISION_TRACES = 50;

  // --- Dictation session state (see DECISIONS.md "voice dictation") -----------------------
  /** True once "type X" has executed; lets subsequent utterances that Jev doesn't recognize
   * as any other command continue being typed verbatim, without repeating "type" each time. */
  private dictationActive = false;
  /** Ambiguous screen_click awaiting a spoken number; screen coordinates, cleared on next utterance. */
  private pendingChoice: { app: string | null; expiresAt: number; options: { label: string; x: number; y: number }[] } | null = null;
  /** Everything typed in the current dictation session, kept in sync with what's on screen
   * so "delete the last 3 words" / "replace X with Y" can compute exact backspace counts
   * instead of guessing. Cleared when dictation ends. */
  private dictationBuffer = "";
  /** The most recently appended chunk, for "delete that"/"undo that". */
  private lastDictationChunk = "";
  /** Browser workflow mode accepts sequential commands until toggled off or a step fails. */
  private workflowActive = false;
  private workflowStepCount = 0;
  private deterministicUtterances = new Set<string>();

  constructor(
    private getSettings: () => DragonSettings,
    private browserBridge: BrowserBridge,
    private onOverlay: (update: OverlayUpdate) => void
  ) {}

  getHistory(): HistoryEntry[] {
    return this.history.list();
  }

  clearHistory() {
    this.history.clear();
  }

  isInsertModeActive(): boolean {
    return this.dictationActive;
  }

  isWorkflowModeActive(): boolean {
    return this.workflowActive;
  }

  getWorkflowStepCount(): number {
    return this.workflowStepCount;
  }

  getInteractionMode(): "normal" | "insert" | "workflow" {
    if (this.workflowActive) return "workflow";
    if (this.dictationActive) return "insert";
    return "normal";
  }

  toggleInsertMode(): boolean {
    if (this.dictationActive) {
      this.endDictation();
    } else {
      this.workflowActive = false;
      this.workflowStepCount = 0;
      this.dictationActive = true;
      this.dictationBuffer = "";
      this.lastDictationChunk = "";
    }
    const active = this.dictationActive;
    logger.event("insert_mode.toggled", { active });
    this.onOverlay(this.baseOverlay(this.isStreaming() ? "listening" : "idle", active ? "Insert Mode enabled" : "Insert Mode disabled"));
    return active;
  }

  toggleWorkflowMode(): boolean {
    if (this.workflowActive) {
      this.stopWorkflow();
    } else {
      this.endDictation();
      this.workflowActive = true;
      this.workflowStepCount = 0;
    }
    const active = this.workflowActive;
    logger.event("workflow_mode.toggled", { active });
    this.onOverlay(this.baseOverlay(this.isStreaming() ? "listening" : "idle", active ? "Workflow Mode enabled" : "Workflow Mode disabled"));
    return active;
  }

  getJevDecisionTraces(): JevDecisionTrace[] {
    return this.jevDecisionTraces;
  }

  private recordJevDecision(trace: JevDecisionTrace) {
    this.jevDecisionTraces.unshift(trace);
    if (this.jevDecisionTraces.length > DragonPipeline.MAX_JEV_DECISION_TRACES) {
      this.jevDecisionTraces.length = DragonPipeline.MAX_JEV_DECISION_TRACES;
    }
  }

  private updateJevDecisionOutcome(
    utteranceId: string,
    outcome: JevDecisionOutcome,
    detail: string | null,
    resolvedAction: string | null = null,
    executionMs: number | null = null
  ) {
    for (const trace of this.jevDecisionTraces) {
      if (trace.utteranceId !== utteranceId) continue;
      trace.outcome = outcome;
      trace.outcomeDetail = detail;
      if (resolvedAction !== null) trace.resolvedAction = resolvedAction;
      trace.executionMs = executionMs;
    }
  }

  private newUtteranceId(): string {
    this.utteranceCounter += 1;
    return `utt_${Date.now()}_${this.utteranceCounter}`;
  }

  /** Starts (or restarts) a Deepgram connection and marks the mic as streaming. */
  async startStreaming(): Promise<void> {
    if (this.micStreaming) return;
    const settings = this.getSettings();
    if (!settings.deepgramApiKey) {
      logger.event("pipeline.missing_deepgram_key", {});
      this.onOverlay(this.baseOverlay("error", "Deepgram API key is not set"));
      return;
    }
    this.intentionalClose = false;
    this.streamGeneration += 1;
    const myGeneration = this.streamGeneration;
    this.deepgram = new DeepgramFluxConnection(
      settings.deepgramApiKey,
      (turn) => this.onTurn(turn),
      (err) => {
        logger.error("pipeline.stt_error", err);
        this.onOverlay(this.baseOverlay("error", err.message));
      },
      (hadOpened) => {
        const wasIntentional = this.intentionalClose;
        const isStaleGeneration = myGeneration !== this.streamGeneration;
        this.micStreaming = false;
        this.deepgram = null;
        // Reconnect automatically after an unexpected drop (network blip, idle
        // timeout, etc.) so the mic (still capturing in the hidden renderer)
        // doesn't end up silently talking to a dead socket while the tray/UI
        // still reads as "listening". Requires the connection to have actually
        // opened at least once — a connection that never opened (bad key, DNS
        // failure, etc.) will just fail again immediately, so retrying would
        // spin forever hammering the API. Also skip if a newer connection has
        // already taken over (e.g. a rapid push-to-talk toggle raced this close).
        if (!wasIntentional && !isStaleGeneration && hadOpened) {
          if (this.reconnectAttempts >= DragonPipeline.MAX_RECONNECT_ATTEMPTS) {
            logger.event("stt.reconnect_giving_up", { attempts: this.reconnectAttempts });
            this.onOverlay(this.baseOverlay("error", "Lost connection to Deepgram repeatedly; stopped retrying"));
            return;
          }
          this.reconnectAttempts += 1;
          logger.event("stt.unexpected_close_reconnecting", { attempt: this.reconnectAttempts });
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.micStreaming) this.startStreaming();
          }, 1000);
        }
      },
      () => this.newUtteranceId()
    );
    try {
      await this.deepgram.connect();
      this.micStreaming = true;
      this.reconnectAttempts = 0;
      this.onOverlay(this.baseOverlay("listening", ""));
    } catch (err) {
      logger.error("pipeline.stt_connect_failed", err);
      this.onOverlay(this.baseOverlay("error", err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Stops streaming. When `graceful` is set (push-to-talk release), asks Flux to end the
   * current turn immediately via `ForceEndTurn` and gives it a moment to flush the resulting
   * `EndOfTurn` (and therefore the Jev decision for whatever was just said) before actually
   * closing the socket, instead of yanking the connection and dropping the last utterance.
   */
  stopStreaming(opts: { graceful?: boolean } = {}): void {
    // Cancel any pending auto-reconnect (e.g. the user stopped listening in the brief gap
    // between an unexpected drop and the scheduled retry) even if we're not "streaming"
    // right now by this method's own bookkeeping.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (!this.micStreaming) {
      this.onOverlay(this.baseOverlay("idle", ""));
      return;
    }
    this.intentionalClose = true;
    const dg = this.deepgram;
    this.deepgram = null;
    this.micStreaming = false;
    if (dg) {
      if (opts.graceful) {
        dg.forceEndTurn();
        setTimeout(() => dg.close(), 1500);
      } else {
        dg.close();
      }
    }
    this.onOverlay(this.baseOverlay("idle", ""));
  }

  isStreaming(): boolean {
    return this.micStreaming;
  }

  handleMicChunk(chunk: Buffer): void {
    this.deepgram?.sendAudio(chunk);
  }

  /** Aborts in-flight decisions, stops any spoken reply, and stops streaming. Bound to the emergency-stop shortcut. */
  emergencyStop(): void {
    for (const f of this.inFlight) f.controller.abort();
    this.inFlight = [];
    automation.stopSpeaking();
    this.endDictation();
    this.stopWorkflow();
    this.stopStreaming();
    logger.event("pipeline.emergency_stop", {});
  }

  private baseOverlay(state: OverlayUpdate["state"], status: string): OverlayUpdate {
    return {
      utteranceId: "",
      state,
      transcript: "",
      isFinal: false,
      action: null,
      status: status || (this.workflowActive ? `Workflow · Step ${this.workflowStepCount}` : null),
      latencyMs: null,
      activationMode: this.getSettings().activationMode,
      interactionMode: this.getInteractionMode(),
    };
  }

  // --- Dictation session helpers -----------------------------------------------------------

  private startOrContinueDictation(chunk: string) {
    this.dictationActive = true;
    this.dictationBuffer = this.dictationBuffer.length > 0 ? `${this.dictationBuffer} ${chunk}` : chunk;
    this.lastDictationChunk = chunk;
  }

  private appendDictationRaw(text: string) {
    // For control-inserted text (e.g. a newline) that shouldn't get an extra joining space.
    this.dictationActive = true;
    this.dictationBuffer += text;
    this.lastDictationChunk = text;
  }

  private stopWorkflow() {
    this.workflowActive = false;
    this.workflowStepCount = 0;
  }

  private endDictation() {
    this.dictationActive = false;
    this.dictationBuffer = "";
    this.lastDictationChunk = "";
  }

  /** Deterministic dictation-editing commands, matched and executed without a Jev round trip
   * for speed and reliability. Only checked while a dictation session is active. */
  private matchDictationControl(effectiveText: string): DictationControl | null {
    const trimmed = effectiveText.trim();
    const lower = trimmed.toLowerCase().replace(/[.!?]+$/, "");

    if (
      /^(?:start|begin|enter|switch\s+to|go\s+to)\s+workflow(?:\s+mode)?$/.test(lower)
    ) {
      return { type: "workflow_start" };
    }
    if (
      /^(?:stop|end|finish|exit)\s+workflow(?:\s+mode)?$/.test(lower)
    ) {
      return { type: "workflow_stop" };
    }
    if (
      /^(?:start|begin|enter|switch\s+to|go\s+to)\s+(?:typing|dictation|writing|insert\s+mode|type\s+mode|write\s+mode|writing\s+mode)$/.test(lower) ||
      lower === "insert mode" ||
      lower === "type mode" ||
      lower === "write mode" ||
      lower === "writing mode"
    ) {
      return { type: "start" };
    }
    if (
      /^(?:stop|end|exit)\s+(?:dictation|typing|dictating|writing|insert\s+mode|type\s+mode)$/.test(lower) ||
      lower === "done" ||
      lower === "that's it" ||
      lower === "stop typing" ||
      lower === "stop writing"
    ) {
      return { type: "stop" };
    }
    if (/^(?:please\s+)?(?:open\s+(?:a\s+)?)?new\s+tab[.!?]?$/.test(lower)) return { type: "browser_new_tab" };
    if (/^(?:new|next)\s+line$/.test(lower)) return { type: "newline" };
    const keyName = extractKeyName(trimmed);
    if (keyName && isStandaloneKeyboardCommand(trimmed, keyName)) return { type: "key", keyName };
    const deleteScope = deleteScopeToControl(extractDeleteScope(trimmed));
    if (deleteScope) return deleteScope;
    if (/^replace\b/i.test(trimmed)) {
      const pair = extractReplacePair(trimmed);
      if (pair) return { type: "replace", find: pair[0], replacement: pair[1] };
    }
    return null;
  }

  private async runDictationControl(turn: TranscriptEvent, control: DictationControl, settings: DragonSettings): Promise<void> {
    this.deterministicUtterances.add(turn.utteranceId);
    this.updateJevDecisionOutcome(
      turn.utteranceId,
      "cancelled",
      "Handled by deterministic local control"
    );

    const startedAt = Date.now();
    let actionLabel = "";
    let execError: string | null = null;
    try {
      switch (control.type) {
        case "workflow_start":
          actionLabel = this.workflowActive ? "Workflow Mode already active" : "Start workflow";
          this.endDictation();
          this.workflowActive = true;
          this.workflowStepCount = 0;
          break;
        case "workflow_stop":
          actionLabel = "Stop workflow";
          this.stopWorkflow();
          break;
        case "start":
          actionLabel = this.dictationActive ? "Insert mode already active" : "Start typing";
          this.workflowActive = false;
          this.workflowStepCount = 0;
          if (!this.dictationActive) {
            this.dictationActive = true;
            this.dictationBuffer = "";
            this.lastDictationChunk = "";
          }
          break;
        case "key":
          actionLabel = `Press ${control.keyName}`;
          await automation.pressNamedKey(control.keyName);
          break;
        case "browser_new_tab":
          actionLabel = "Open new tab";
          await this.requireBrowserAction({ kind: "new_tab" });
          break;
        case "stop":
          actionLabel = "Stop dictation";
          this.endDictation();
          break;
        case "newline":
          actionLabel = "New line";
          await automation.typeText("\n");
          this.appendDictationRaw("\n");
          break;
        case "delete_all": {
          actionLabel = "Delete everything typed";
          await automation.deleteBackward(this.dictationBuffer.length);
          this.dictationBuffer = "";
          this.lastDictationChunk = "";
          break;
        }
        case "delete_last_chunk": {
          actionLabel = "Delete that";
          const chunk = this.lastDictationChunk;
          if (chunk) {
            const joiner = this.dictationBuffer.length > chunk.length ? 1 : 0;
            await automation.deleteBackward(chunk.length + joiner);
            this.dictationBuffer = this.dictationBuffer.slice(0, Math.max(0, this.dictationBuffer.length - chunk.length - joiner));
          }
          this.lastDictationChunk = "";
          break;
        }
        case "delete_words": {
          actionLabel = `Delete last ${control.count} word(s)`;
          const words = this.dictationBuffer.trim().split(/\s+/).filter(Boolean);
          const newWords = words.slice(0, Math.max(0, words.length - control.count));
          const newBuffer = newWords.join(" ");
          const deleteChars = this.dictationBuffer.length - newBuffer.length;
          await automation.deleteBackward(Math.max(0, deleteChars));
          this.dictationBuffer = newBuffer;
          this.lastDictationChunk = "";
          break;
        }
        case "replace": {
          actionLabel = `Replace "${control.find}" with "${control.replacement}"`;
          const idx = this.dictationBuffer.toLowerCase().lastIndexOf(control.find.toLowerCase());
          if (idx === -1) {
            throw new Error(`Nothing matching "${control.find}" in what was typed recently`);
          }
          const before = this.dictationBuffer.slice(0, idx);
          const after = this.dictationBuffer.slice(idx + control.find.length);
          const newBuffer = before + control.replacement + after;
          let prefixLen = 0;
          const minLen = Math.min(this.dictationBuffer.length, newBuffer.length);
          while (prefixLen < minLen && this.dictationBuffer[prefixLen] === newBuffer[prefixLen]) prefixLen++;
          await automation.deleteBackward(this.dictationBuffer.length - prefixLen);
          const retype = newBuffer.slice(prefixLen);
          if (retype) await automation.typeText(retype);
          this.dictationBuffer = newBuffer;
          this.lastDictationChunk = "";
          break;
        }
      }
    } catch (err) {
      execError = err instanceof Error ? err.message : String(err);
    }
    const totalMs = Date.now() - startedAt;

    logger.event("pipeline.dictation_control", {
      utteranceId: turn.utteranceId,
      control: control.type,
      totalMs,
      error: execError,
    });

    this.onOverlay({
      utteranceId: turn.utteranceId,
      state: execError ? "error" : "done",
      transcript: turn.transcript,
      isFinal: true,
      action: actionLabel,
      status: execError,
      latencyMs: totalMs,
      activationMode: settings.activationMode,
    });

    this.history.add({
      utteranceId: turn.utteranceId,
      timestamp: Date.now(),
      transcript: turn.transcript,
      intent: control.type === "key" ? "press_key" : control.type === "browser_new_tab" ? "chrome_new_tab" : control.type.startsWith("delete") || control.type === "replace" ? "delete_text" : "type_text",
      action: actionLabel,
      status: execError ? "error" : "success",
      detail: execError ?? "",
    });
  }

  private async onTurn(turn: TranscriptEvent): Promise<void> {
    const settings = this.getSettings();
    automation.stopSpeaking(); // barge-in: new speech interrupts any spoken reply.

    if (turn.event === "TurnResumed") {
      // The previous eager transcript for this turn is stale; drop any in-flight decision for it.
      this.abortUtterance(turn.utteranceId);
      return;
    }
    if (turn.event === "StartOfTurn" || turn.event === "Update") {
      if (this.executingUtteranceId == null) {
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: "listening",
          transcript: turn.transcript,
          isFinal: false,
          action: null,
          status: null,
          latencyMs: null,
          activationMode: settings.activationMode,
        });
      }
      return; // Only EagerEndOfTurn/EndOfTurn trigger decisions (debounces interim noise).
    }

    const effectiveText = turn.transcript;
    if (effectiveText.trim().length === 0) return;

    // Fast path: deterministic insert-mode/editing commands skip Jev entirely for speed and
    // reliability. Mode entry is allowed outside an active session; edit controls require one.
    const control = this.matchDictationControl(effectiveText);
    const controlAllowed = control && (
      control.type === "browser_new_tab"
        ? !this.dictationActive
        : this.dictationActive || control.type === "start" || control.type === "workflow_start" || control.type === "workflow_stop"
    );
    if (controlAllowed) {
      this.abortUtterance(turn.utteranceId);
      if (!turn.isFinal) {
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: "listening",
          transcript: turn.transcript,
          isFinal: false,
          action: null,
          status: "waiting for final confirmation",
          latencyMs: null,
          activationMode: settings.activationMode,
        });
        return;
      }
      if (this.executedUtterances.has(turn.utteranceId)) return;
      this.executedUtterances.add(turn.utteranceId);
      await this.runDictationControl(turn, control, settings);
      return;
    }

    if (this.workflowActive && turn.isFinal) {
      const workflowSteps = extractWorkflowSteps(effectiveText);
      if (workflowSteps) {
        await this.runWorkflowPlan(turn, workflowSteps, settings);
        return;
      }
    }

    await this.runDecision(turn, effectiveText, settings);
  }

  private abortUtterance(utteranceId: string) {
    this.inFlight = this.inFlight.filter((f) => {
      if (f.utteranceId === utteranceId) {
        f.controller.abort();
        return false;
      }
      return true;
    });
  }

  private pruneCacheForUtterance(utteranceId: string) {
    const prefix = `${utteranceId}::`;
    for (const key of this.jevAnswerCache.keys()) {
      if (key.startsWith(prefix)) this.jevAnswerCache.delete(key);
    }
  }

  private registerInFlight(utteranceId: string): AbortController {
    // Reliability control (not a guardrail): cap concurrent Jev requests and
    // cancel the oldest once the cap is exceeded, per PROGRESS.md policy.
    while (this.inFlight.length >= MAX_IN_FLIGHT_DECISIONS) {
      const oldest = this.inFlight.shift();
      oldest?.controller.abort();
    }
    const controller = new AbortController();
    this.inFlight.push({ utteranceId, controller, startedAt: Date.now() });
    return controller;
  }

  private unregisterInFlight(controller: AbortController) {
    this.inFlight = this.inFlight.filter((f) => f.controller !== controller);
  }

  private async runWorkflowPlan(turn: TranscriptEvent, steps: string[], settings: DragonSettings): Promise<void> {
    logger.event("workflow.plan_detected", {
      utteranceId: turn.utteranceId,
      stepCount: steps.length,
      steps,
    });

    for (let index = 0; index < steps.length; index++) {
      if (!this.workflowActive) break;
      const text = steps[index];
      const now = Date.now();
      const stepTurn: TranscriptEvent = {
        ...turn,
        utteranceId: `${turn.utteranceId}_workflow_${index + 1}`,
        turnIndex: index + 1,
        event: "EndOfTurn",
        transcript: text,
        isFinal: true,
        turnStartedAt: now,
        receivedAt: now,
      };
      logger.event("workflow.step_started", {
        utteranceId: stepTurn.utteranceId,
        step: index + 1,
        stepCount: steps.length,
        text,
      });
      this.onOverlay({
        utteranceId: stepTurn.utteranceId,
        state: "thinking",
        transcript: text,
        isFinal: true,
        action: `Workflow step ${index + 1} of ${steps.length}`,
        status: null,
        latencyMs: null,
        activationMode: settings.activationMode,
      });
      await this.runDecision(stepTurn, text, settings);
      logger.event(this.workflowActive ? "workflow.step_completed" : "workflow.step_failed", {
        utteranceId: stepTurn.utteranceId,
        step: index + 1,
        stepCount: steps.length,
        text,
      });
    }

    if (this.workflowActive) {
      this.onOverlay({
        utteranceId: turn.utteranceId,
        state: "done",
        transcript: turn.transcript,
        isFinal: true,
        action: `Workflow complete · ${steps.length} steps`,
        status: null,
        latencyMs: null,
        activationMode: settings.activationMode,
      });
    }
  }

  private async runDecision(turn: TranscriptEvent, effectiveText: string, settings: DragonSettings): Promise<void> {
    // Serialize decisions per utterance so an EagerEndOfTurn and the EndOfTurn behind it can't
    // both spend a provider call on the same sentence. The chaining has to happen
    // synchronously: reading `previous` and only then storing `current` left a window where two
    // turns arriving in the same tick both read the same `previous`, both resumed when it
    // settled, and both ran — three concurrent provider calls for one utterance were logged on
    // 2026-09-25, and a response derived from a stale interim transcript could win that race.
    const previous = this.decisionInFlightByUtterance.get(turn.utteranceId);
    const run = () => this.runDecisionInternal(turn, effectiveText, settings);
    const current = previous ? previous.then(run, run) : run();
    this.decisionInFlightByUtterance.set(turn.utteranceId, current);
    try {
      await current;
    } finally {
      if (this.decisionInFlightByUtterance.get(turn.utteranceId) === current) {
        this.decisionInFlightByUtterance.delete(turn.utteranceId);
      }
    }
  }

  private async runDecisionInternal(turn: TranscriptEvent, effectiveText: string, settings: DragonSettings): Promise<void> {
    const startedAt = Date.now();
    const sttTurnMs = Math.max(0, turn.receivedAt - turn.turnStartedAt);
    const sttToDecisionMs = startedAt - turn.receivedAt;
    /** Split of the pre-provider work, logged so the latency budget is measurable rather than
     * inferred from `decisionMs - jevMs`. See the Promise.all in the try block below. */
    let activeAppMs = 0;
    let snapshotMs = 0;
    const controller = this.registerInFlight(turn.utteranceId);

    this.onOverlay({
      utteranceId: turn.utteranceId,
      state: "thinking",
      transcript: effectiveText,
      isFinal: turn.isFinal,
      action: null,
      status: null,
      latencyMs: null,
      activationMode: settings.activationMode,
    });

    if (this.pendingChoice && Date.now() > this.pendingChoice.expiresAt) this.pendingChoice = null;
    if (this.pendingChoice) {
      // A live picker owns the next utterance: a partial "2" must not reach Jev.
      if (!turn.isFinal) {
        this.unregisterInFlight(controller);
        return;
      }
      if (this.executedUtterances.has(turn.utteranceId)) {
        this.unregisterInFlight(controller);
        return;
      }
      const handled = await this.handlePendingChoice(effectiveText);
      if (handled) {
        this.executedUtterances.add(turn.utteranceId);
        this.unregisterInFlight(controller);
        this.history.add({ utteranceId: turn.utteranceId, timestamp: Date.now(), transcript: effectiveText, intent: "screen_click", action: "Choose option", status: handled.error ? "error" : "success", detail: handled.error ?? "" });
        this.onOverlay({ utteranceId: turn.utteranceId, state: handled.error ? "error" : "done", transcript: effectiveText, isFinal: true, action: "Choose option", status: handled.error, latencyMs: Date.now() - startedAt, activationMode: settings.activationMode });
        return;
      }
    }

    if (
      this.dictationActive &&
      shouldTypeDirectlyInInsertMode(effectiveText, extractKeyName(effectiveText))
    ) {
      this.unregisterInFlight(controller);
      if (!turn.isFinal) {
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: "listening",
          transcript: effectiveText,
          isFinal: false,
          action: null,
          status: "waiting for more speech",
          latencyMs: null,
          activationMode: settings.activationMode,
        });
        return;
      }
      logger.event("pipeline.dictation_direct_text", {
        utteranceId: turn.utteranceId,
        reason: "text_first",
        sttTurnMs,
      });
      await this.continueDictation(turn, effectiveText, settings, Date.now() - startedAt, sttToDecisionMs);
      return;
    }

    try {
      // Hoisted above every await: the cache key depends only on the utterance, provider and
      // normalized text, so a hit can be detected without first paying for the reads below.
      const cacheKey = `${turn.utteranceId}::${settings.decisionProvider}:${settings.layaModel}::${normalizeDecisionText(effectiveText)}::${settings.activationMode}`;
      const cached = this.jevAnswerCache.get(cacheKey);

      // The OS active-app read spawns a `powershell.exe` that compiles the User32 P/Invoke
      // block on every call. That measured at ~700ms — more than the LLM request itself — and
      // it was running before the cache check, so all 19 cache hits in one session paid for a
      // read only the provider path needs (the app context in the prompt). Skip it on a hit.
      //
      // The page snapshot is still needed on both paths, because `payload` drives the addressed
      // gate and the resolver even for a cached answer (a cached chrome_click still has to
      // resolve an element id). The two reads are independent, so overlap them: previously they
      // were sequential.
      const activeAppStarted = Date.now();
      const snapshotStarted = Date.now();
      const [activeApp, browserPage] = await Promise.all([
        (cached ? Promise.resolve(null) : automation.getActiveAppName()).then((value) => {
          activeAppMs = Date.now() - activeAppStarted;
          return value;
        }),
        (this.browserBridge.isConnected() ? this.browserBridge.requestSnapshot() : Promise.resolve(null)).then((value) => {
          snapshotMs = Date.now() - snapshotStarted;
          return value;
        }),
      ]);
      // Chrome page elements only make sense when Chrome is frontmost. Otherwise "click add
      // device" in WhatsApp matched stale Chrome tab elements, became chrome_click and clicked
      // nothing (2026-10-02). Cache hits skip the app read, so reuse the last known one.
      if (activeApp) this.lastActiveApp = activeApp;
      const frontApp = activeApp ?? this.lastActiveApp;
      const chromeFront = !frontApp || /chrome/i.test(frontApp);
      const payload = extractPayload(effectiveText, chromeFront ? browserPage : null);
      let summary: JevAnswerSummary;
      let decisionMs: number;
      let jevMs: number | null = null;

      if (cached) {
        // Same utterance, same text, same mode as an already-answered request (typically
        // EagerEndOfTurn immediately followed by an EndOfTurn with no new words) — reuse the
        // answer instead of spending another Jev call on an identical question.
        this.unregisterInFlight(controller);
        logger.event("pipeline.decision_cache_hit", {
          utteranceId: turn.utteranceId,
          turnEvent: turn.event,
          activeAppMs,
          snapshotMs,
        });
        summary = cached;
        decisionMs = Date.now() - startedAt;
      } else {
        // Only the provider path needs the target candidates, the question set and the state
        // built from the active app / page snapshot, so build them here rather than above.
        const targetCandidates = buildTargetCandidates(payload);
        const questions = buildQuestions({
          includeAddressed: settings.activationMode === "always_listening",
          targetCandidates,
        });
        const state = buildState({ transcript: effectiveText, activeApp, browserPage });

        logger.event("pipeline.decision_request", {
          utteranceId: turn.utteranceId,
          turnEvent: turn.event,
          activeApp,
          activeAppMs,
          snapshotMs,
          effectiveText,
          provider: settings.decisionProvider,
          sttTurnMs,
          sttToDecisionMs,
          appCandidates: payload.appCandidates.map((c) => c.label),
          elementCandidates: payload.browserElementCandidates.length,
        });

        const result = await callDecisionProvider(
          {
            provider: settings.decisionProvider,
            openRouterApiKey: settings.openRouterApiKey,
            layaBaseUrl: settings.layaBaseUrl,
            layaModel: settings.layaModel,
          },
          state,
          questions,
          controller.signal
        );
        this.unregisterInFlight(controller);
        jevMs = result.timingMs;

        const deterministicControl = this.deterministicUtterances.has(turn.utteranceId);
        this.recordJevDecision({
          utteranceId: turn.utteranceId,
          timestamp: Date.now(),
          transcript: effectiveText,
          activeApp,
          activationMode: settings.activationMode,
          turnEvent: turn.event,
          provider: result.provider,
          model: result.model,
          sttTurnMs,
          sttToDecisionMs,
          jevMs: result.timingMs,
          decisionMs: Date.now() - startedAt,
          outcome: deterministicControl ? "cancelled" : "pending",
          outcomeDetail: deterministicControl ? "Handled by deterministic local control" : null,
          resolvedAction: null,
          executionMs: null,
          complete: result.answers.complete.noul,
          addressed: result.answers.addressed?.noul ?? null,
          choices: {
            intent: {
              choice: result.answers.intent.choice,
              confidence: result.answers.intent.confidence,
              probabilities: result.answers.intent.probabilities,
            },
            target: {
              choice: result.answers.target.choice,
              confidence: result.answers.target.confidence,
              probabilities: result.answers.target.probabilities,
            },
            direction: {
              choice: result.answers.direction.choice,
              confidence: result.answers.direction.confidence,
              probabilities: result.answers.direction.probabilities,
            },
          },
        });

        summary = summarizeAnswers(result.answers);
        decisionMs = Date.now() - startedAt;
        this.jevAnswerCache.set(cacheKey, summary);
      }
      if (turn.isFinal) this.pruneCacheForUtterance(turn.utteranceId);

      // Skip the "addressed" gate entirely while actively dictating: continued natural speech
      // ("How are you doing?") reads as not-addressed-to-an-assistant almost by definition,
      // but during an active dictation session it should be typed, not discarded — the user
      // already explicitly started dictating with a real command. See DECISIONS.md.
      //
      // The other exemptions are utterances that are commands by shape alone and so can't be
      // incidental speech: a bare key name ("Escape.", "Backspace."), and a plain "open <known
      // app>" ("Open Warp."). Both were being scored not_addressed in always-listening mode and
      // silently dropped even though the intent was right (observed 2026-09-25).
      const standaloneKeyboardCommand = isStandaloneKeyboardCommand(effectiveText, payload.keyName);
      if (
        settings.activationMode === "always_listening" &&
        !this.dictationActive &&
        !this.workflowActive &&
        !isExplicitMediaControl(turn, summary) &&
        !standaloneKeyboardCommand &&
        !isDeterministicAppLaunch(effectiveText, payload) &&
        !(turn.isFinal && isDeterministicScreenClick(effectiveText, payload))
      ) {
        const addressedThreshold = settings.decisionProvider === "laya" ? LAYA_ADDRESSED_THRESHOLD : JEV_ADDRESSED_THRESHOLD;
        if (summary.addressed == null || summary.addressed < addressedThreshold) {
          this.updateJevDecisionOutcome(turn.utteranceId, "ignored", "Not addressed to Dragon");
          this.logIgnored(turn, "not_addressed", summary.intent);
          return;
        }
      }

      const keyboardIntent = summary.intent === "press_key" || summary.intent === "shortcut";
      if (this.dictationActive && keyboardIntent && (!turn.isFinal || !standaloneKeyboardCommand)) {
        if (turn.isFinal) {
          logger.event("pipeline.dictation_text_override", {
            utteranceId: turn.utteranceId,
            reason: "embedded_keyboard_phrase",
            jevIntent: summary.intent,
          });
          await this.continueDictation(turn, effectiveText, settings, decisionMs, sttToDecisionMs);
          return;
        }
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: "listening",
          transcript: effectiveText,
          isFinal: false,
          action: null,
          status: "waiting for more speech",
          latencyMs: decisionMs,
          activationMode: settings.activationMode,
        });
        return;
      }

      const isReady =
        turn.isFinal ||
        (turn.event === "EagerEndOfTurn" &&
          INTERIM_ELIGIBLE_INTENTS.has(summary.intent) &&
          summary.intentConfidence >= INTERIM_EXEC_INTENT_CONFIDENCE &&
          summary.complete >= INTERIM_EXEC_COMPLETE);

      if (!isReady) {
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: "listening",
          transcript: effectiveText,
          isFinal: false,
          action: null,
          status: "waiting for more speech",
          latencyMs: decisionMs,
          activationMode: settings.activationMode,
        });
        return;
      }

      // "complete" is Jev's judgment of sentence completeness, not speech completeness —
      // on a final turn (EndOfTurn already told us the speaker is done), a short-but-final
      // utterance like "Open Slack?" can score low on "complete" while still being a fully
      // spoken, entirely executable command. Only enforce the completeness gate on turns
      // that *aren't* final yet, where it protects against acting on a truncated interim.
      const incomplete = !turn.isFinal && summary.complete < COMPLETE_THRESHOLD;
      const deterministicClick = turn.isFinal && !this.dictationActive && !this.workflowActive && isDeterministicScreenClick(effectiveText, payload);
      const noCommand = !deterministicClick && (summary.intent === "none" || summary.intentConfidence < INTENT_CONFIDENCE_THRESHOLD || incomplete);

      if (noCommand) {
        if (this.workflowActive) {
          this.stopWorkflow();
          this.updateJevDecisionOutcome(turn.utteranceId, "ignored", "Workflow step was not recognized");
          this.logIgnored(turn, "low_confidence_or_incomplete", summary.intent);
          return;
        }
        if (this.dictationActive && turn.isFinal && effectiveText.trim().length > 0) {
          // Jev didn't recognize a command; while actively dictating, treat this as more
          // dictated text so the user doesn't have to say "type" again for every sentence.
          await this.continueDictation(turn, effectiveText, settings, decisionMs, sttToDecisionMs);
          return;
        }
        this.updateJevDecisionOutcome(turn.utteranceId, "ignored", "No confident command recognized");
        this.logIgnored(turn, "low_confidence_or_incomplete", summary.intent);
        return;
      }

      if (this.executedUtterances.has(turn.utteranceId)) {
        logger.event("pipeline.duplicate_suppressed", { utteranceId: turn.utteranceId });
        return;
      }
      this.executedUtterances.add(turn.utteranceId);

      const resolved = resolveCommand(summary, payload, effectiveText);
      if (!resolved) {
        if (this.workflowActive) this.stopWorkflow();
        const browserTargetFailure =
          (summary.intent === "chrome_click" || summary.intent === "chrome_type" || summary.intent === "chrome_select") &&
          payload.browserElementCandidates.length === 0;
        const detail = browserTargetFailure
          ? "No matching clickable element was found on the current page."
          : "Jev decision could not be resolved.";
        const reason = browserTargetFailure ? "browser_target_missing" : "resolution_failed";
        this.updateJevDecisionOutcome(turn.utteranceId, "ignored", detail);
        this.logIgnored(turn, reason, summary.intent, detail);
        return;
      }

      this.updateJevDecisionOutcome(
        turn.utteranceId,
        "pending",
        null,
        describeCommand(resolved)
      );
      this.onOverlay({
        utteranceId: turn.utteranceId,
        state: "executing",
        transcript: effectiveText,
        isFinal: true,
        action: describeCommand(resolved),
        status: null,
        latencyMs: decisionMs,
        activationMode: settings.activationMode,
      });

      const execStarted = Date.now();
      this.executingUtteranceId = turn.utteranceId;
      let execError: string | null = null;
      let choicePrompt: string | null = null;
      try {
        await this.executeCommand(resolved, effectiveText, controller.signal);
      } catch (err) {
        if (err instanceof ChoiceRequiredError) choicePrompt = err.message;
        else execError = err instanceof Error ? err.message : String(err);
      }
      // If the user spoke again before this (slow) command finished, a newer utterance's own
      // execution may have already overwritten executingUtteranceId with its own id — in that
      // case this command is stale: don't reclaim the flag (it belongs to the newer command
      // now) and don't push this command's "done"/"error" overlay below, since it would
      // overwrite whatever the newer command has since displayed with old information (visible
      // as a brief jitter to a stale state before the newer command's own update corrects it).
      const isCurrentExecution = this.executingUtteranceId === turn.utteranceId;
      if (isCurrentExecution) this.executingUtteranceId = null;
      const executionMs = Date.now() - execStarted;
      if (choicePrompt) {
        // Not a failure: awaiting a spoken number (see handlePendingChoice).
        this.unregisterInFlight(controller);
        this.updateJevDecisionOutcome(turn.utteranceId, "ignored", choicePrompt, describeCommand(resolved), executionMs);
        logger.event("pipeline.choice_prompt", { utteranceId: turn.utteranceId, executionMs });
        if (isCurrentExecution) {
          this.onOverlay({ utteranceId: turn.utteranceId, state: "listening", transcript: effectiveText, isFinal: true, action: describeCommand(resolved), status: choicePrompt, latencyMs: sttToDecisionMs + decisionMs + executionMs, activationMode: settings.activationMode });
        }
        return;
      }

      this.updateJevDecisionOutcome(
        turn.utteranceId,
        execError ? "error" : "success",
        execError,
        describeCommand(resolved),
        executionMs
      );
      const totalMs = sttToDecisionMs + decisionMs + executionMs;

      // Dictation session bookkeeping: typing/newline continue it; any other successfully
      // recognized command (the confidence/completeness gates above already passed) means
      // the user deliberately switched to something else, so end the session. Workflow mode
      // instead keeps the sequence open and advances one step per successful command.
      if (execError && this.workflowActive) {
        this.stopWorkflow();
      } else if (!execError) {
        if (this.workflowActive) {
          this.workflowStepCount += 1;
        } else if (resolved.kind === "type_text") {
          this.startOrContinueDictation(resolved.text!);
        } else if (resolved.kind === "insert_newline") {
          this.appendDictationRaw("\n");
        } else if (!keepsDictationOpen(resolved.kind)) {
          this.endDictation();
        }
      }

      logger.event("pipeline.execution", {
        utteranceId: turn.utteranceId,
        intent: resolved.kind,
        provider: settings.decisionProvider,
        sttTurnMs,
        sttToDecisionMs,
        activeAppMs,
        snapshotMs,
        decisionMs,
        jevMs,
        executionMs,
        totalMs,
        error: execError,
      });

      if (isCurrentExecution) {
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: execError ? "error" : "done",
          transcript: effectiveText,
          isFinal: true,
          action: describeCommand(resolved),
          status: execError || (this.workflowActive ? `Workflow · Step ${this.workflowStepCount}` : null),
          latencyMs: totalMs,
          activationMode: settings.activationMode,
        });
      }

      this.history.add({
        utteranceId: turn.utteranceId,
        timestamp: Date.now(),
        transcript: effectiveText,
        intent: resolved.kind,
        action: describeCommand(resolved),
        status: execError ? "error" : "success",
        detail: execError ?? "",
      });

      if (settings.voiceReplyEnabled && !execError) {
        automation.say(shortReplyFor(resolved));
      } else if (settings.voiceReplyEnabled && execError) {
        automation.say("Sorry, that did not work.");
      }
    } catch (err) {
      this.unregisterInFlight(controller);
      if (err instanceof DecisionCancelledError) {
        logger.event("pipeline.decision_cancelled", { utteranceId: turn.utteranceId });
        return;
      }
      const message = err instanceof DecisionRequestError ? err.message : err instanceof Error ? err.message : String(err);
      if (this.workflowActive) this.stopWorkflow();
      this.updateJevDecisionOutcome(turn.utteranceId, "error", message);
      logger.error("pipeline.decision_failed", err, { utteranceId: turn.utteranceId });
      this.onOverlay({
        utteranceId: turn.utteranceId,
        state: "error",
        transcript: effectiveText,
        isFinal: turn.isFinal,
        action: null,
        status: message,
        latencyMs: Date.now() - startedAt,
        activationMode: settings.activationMode,
      });
    }
  }

  /** Jev didn't recognize a command for this utterance while a dictation session is active:
   * type it verbatim and fold it into the tracked buffer instead of discarding it. */
  private async continueDictation(
    turn: TranscriptEvent,
    effectiveText: string,
    settings: DragonSettings,
    decisionMs: number,
    sttToDecisionMs: number
  ): Promise<void> {
    if (this.executedUtterances.has(turn.utteranceId)) return;
    this.executedUtterances.add(turn.utteranceId);

    const execStarted = Date.now();
    const sttTurnMs = Math.max(0, turn.receivedAt - turn.turnStartedAt);
    let execError: string | null = null;
    try {
      await automation.typeText(effectiveText);
      this.startOrContinueDictation(effectiveText);
    } catch (err) {
      execError = err instanceof Error ? err.message : String(err);
    }
    const executionMs = Date.now() - execStarted;
    this.updateJevDecisionOutcome(
      turn.utteranceId,
      execError ? "error" : "success",
      execError,
      "Continue typing",
      executionMs
    );
    const totalMs = sttToDecisionMs + decisionMs + executionMs;

    logger.event("pipeline.dictation_continue", {
      utteranceId: turn.utteranceId,
      sttTurnMs,
      sttToDecisionMs,
      decisionMs,
      executionMs,
      totalMs,
      error: execError,
    });

    this.onOverlay({
      utteranceId: turn.utteranceId,
      state: execError ? "error" : "done",
      transcript: effectiveText,
      isFinal: true,
      action: "Continue typing",
      status: execError,
      latencyMs: totalMs,
      activationMode: settings.activationMode,
    });

    this.history.add({
      utteranceId: turn.utteranceId,
      timestamp: Date.now(),
      transcript: effectiveText,
      intent: "type_text",
      action: `Type "${effectiveText}"`,
      status: execError ? "error" : "success",
      detail: execError ?? "",
    });
    // Deliberately no voice reply here — a spoken "Done" after every dictated sentence would
    // be exhausting; only explicit commands get acknowledged out loud.
  }

  private logIgnored(turn: TranscriptEvent, reason: string, intent: string, status = "No command recognized") {
    if (this.ignoredLoggedUtterances.has(turn.utteranceId) && !turn.isFinal) return;
    if (turn.isFinal) this.ignoredLoggedUtterances.add(turn.utteranceId);
    logger.event("pipeline.ignored", { utteranceId: turn.utteranceId, reason, intent });
    this.onOverlay({
      utteranceId: turn.utteranceId,
      state: "idle",
      transcript: turn.transcript,
      isFinal: turn.isFinal,
      action: null,
      status: reason === "not_addressed" ? null : status,
      latencyMs: null,
      activationMode: this.getSettings().activationMode,
    });
  }

  private async executeCommand(cmd: ResolvedCommand, transcript: string, signal: AbortSignal): Promise<void> {
    switch (cmd.kind) {
      case "open_app":
        return automation.openApp(cmd.appAlias!);
      case "activate_app":
        return automation.activateApp(cmd.appAlias!);
      case "hide_app":
        return automation.hideApp(cmd.appAlias!);
      case "quit_app":
        return automation.quitApp(cmd.appAlias!);
      case "switch_previous_app":
        return automation.switchToPreviousApp();
      case "type_text":
        return automation.typeText(cmd.text!);
      case "insert_newline":
        return automation.typeText("\n");
      case "press_key":
      case "shortcut":
        return automation.pressNamedKey(cmd.keyName!);
      case "window_minimize":
        return automation.windowMinimize();
      case "window_maximize":
        return automation.windowMaximize();
      case "window_fullscreen":
        return automation.windowFullscreen();
      case "window_close":
        return automation.windowClose();
      case "volume_up":
        return automation.volumeUp();
      case "volume_down":
        return automation.volumeDown();
      case "volume_set":
        return automation.volumeSet(cmd.amount!);
      case "volume_mute":
        return automation.volumeMute();
      case "volume_unmute":
        return automation.volumeUnmute();
      case "media_play_pause":
        return automation.mediaPlayPause();
      case "media_next":
        return automation.mediaNext();
      case "media_previous":
        return automation.mediaPrevious();
      case "open_settings_pane":
        return automation.openSettingsPane(cmd.pane!);
      case "open_finder_location":
        return automation.openFinderLocation(cmd.location!);
      case "chrome_open_url":
        return this.openUrlPreferringExistingTab(cmd.url!);
      case "chrome_search":
        return this.openUrlPreferringExistingTab(
          cmd.url ?? `https://www.google.com/search?q=${encodeURIComponent(cmd.query!)}`
        );
      case "chrome_click":
        return this.requireBrowserAction({ kind: "click", elementId: cmd.elementId! });
      case "chrome_type":
        return this.requireBrowserAction({ kind: "type", elementId: cmd.elementId!, text: cmd.text! });
      case "chrome_select":
        return this.requireBrowserAction({ kind: "select", elementId: cmd.elementId!, text: cmd.text });
      case "chrome_scroll":
        return this.requireBrowserAction({ kind: "scroll", direction: cmd.direction ?? "down" });
      case "chrome_back":
        return this.requireBrowserAction({ kind: "back" });
      case "chrome_forward":
        return this.requireBrowserAction({ kind: "forward" });
      case "chrome_reload":
        return this.requireBrowserAction({ kind: "reload" });
      case "chrome_new_tab":
        return this.requireBrowserAction({ kind: "new_tab" });
      case "chrome_close_tab":
        return this.requireBrowserAction({ kind: "close_tab" });
      case "chrome_switch_tab":
        return this.requireBrowserAction({ kind: "switch_tab", direction: cmd.direction ?? "next" });
      case "screen_click":
        return this.executeScreenClick(cmd.text!, transcript, signal);
      case "search_in_app":
        return this.executeSearchInApp(cmd.query!);
      case "replace_text": {
        if (!this.dictationActive) {
          throw new Error("Nothing to replace — say \"type ...\" first to dictate something.");
        }
        await this.runDictationControl(
          SYNTHETIC_TURN,
          { type: "replace", find: cmd.find!, replacement: cmd.replacement! },
          this.getSettings()
        );
        return;
      }
      case "delete_text": {
        if (!this.dictationActive) {
          throw new Error("Nothing to delete — say \"type ...\" first to dictate something.");
        }
        const control: DictationControl =
          cmd.deleteScope === "all"
            ? { type: "delete_all" }
            : cmd.deleteScope === "words"
              ? { type: "delete_words", count: cmd.wordCount ?? DEFAULT_DELETE_WORD_COUNT }
              : { type: "delete_last_chunk" };
        await this.runDictationControl(SYNTHETIC_TURN, control, this.getSettings());
        return;
      }
      default:
        throw new Error(`Unhandled command kind: ${cmd.kind}`);
    }
  }

  /**
   * "Open my existing tabs" / avoiding duplicate tabs: when the extension is connected, ask
   * it to focus a tab that already matches this URL/hostname instead of always opening a new
   * one. Falls back to the plain OS-level open (which always creates a new tab/window) when
   * the extension isn't loaded/connected — no DOM access required either way.
   */
  private async openUrlPreferringExistingTab(url: string): Promise<void> {
    if (this.browserBridge.isConnected()) {
      const res = await this.browserBridge.sendAction({ kind: "focus_or_open", url });
      if (res.ok) return;
      logger.event("pipeline.focus_or_open_failed_fallback", { error: res.error });
    }
    await automation.openUrlInChrome(url);
  }

  /** Generic "search inside the current non-browser app" via its quick-open/jump-to shortcut
   * (Cmd/Ctrl+K — Slack, Notion, VS Code, Discord, Linear, and many other apps all use this
   * convention). Not app-specific automation; just the one nearly-universal shortcut. */
  private async executeSearchInApp(query: string): Promise<void> {
    await automation.pressNamedKey("quick switcher");
    await new Promise((r) => setTimeout(r, 300));
    await automation.typeText(query);
    await new Promise((r) => setTimeout(r, 200));
    await automation.pressNamedKey("enter");
  }

  /** Vision-based click: screenshots the frontmost window only, discovers every on-screen match
   * for the description, independently verifies each one, disambiguates if more than one survives
   * verification, then moves+clicks at the corresponding absolute screen coordinate (window
   * bounds + relative offset). */
  private async executeScreenClick(description: string, transcript: string, signal: AbortSignal): Promise<void> {
    const settings = this.getSettings();
    if (settings.screenClickMethod === "accessibility") return this.executeAccessibilityClick(description, transcript, settings, signal);
    if (settings.screenClickMethod === "auto") {
      try {
        return await this.executeAccessibilityClick(description, transcript, settings, signal);
      } catch (err) {
        if (signal.aborted || !(err instanceof AccessibilityMissError)) throw err;
        logger.event("screen_click.fallback", { description, fallback: "accessibility_miss" });
      }
    }
    const window = await automation.captureFrontmostWindow();
    // Decode once per click; every verify/relocate crop reuses it.
    const image = nativeImage.createFromBuffer(Buffer.from(window.imageBase64, "base64"));
    const rawMatches = await locateElements(settings.openRouterApiKey, window.imageBase64, description, window.imageWidth, window.imageHeight);
    if (rawMatches.length === 0) {
      saveScreenClickDebugImage(window.imageBase64, description, "no_match");
      throw new Error(`Could not find "${description}" on screen.`);
    }
    const candidates = dedupeMatches(rawMatches);

    // The model's own `label` field turned out to be self-consistently unreliable as a
    // verification signal — it can echo back the requested description even when its
    // coordinates land on a completely different row (grounding failure, not a wrong-row pick).
    // So verify each reported match independently: crop tightly around it and ask a
    // separately-framed "what text is here?" question with no hint of the target — if that
    // doesn't match, the point itself is wrong regardless of what the first call's label
    // claimed. See PROGRESS.md 2026-09-28.
    const verify = (p: LocatedPoint) =>
      readLabelAtPoint(settings.openRouterApiKey, cropImage(image, window.imageWidth, window.imageHeight, verifyBox(p, window.imageWidth, window.imageHeight)).imageBase64);

    const { verified } = await verifyCandidates(description, candidates, verify);

    let point: ScreenPoint;
    let retried = false;
    let disambiguated = false;
    if (verified.length === 0) {
      // None of the reported matches survived independent verification — fall back to the
      // recovery path (tight relocate-crop retry + one fresh full-image attempt, concurrently)
      // using the model's best guess as the starting point.
      retried = true;
      saveScreenClickDebugImage(window.imageBase64, description, "unverified");
      point = await this.recoverScreenClickPoint(description, candidates[0], window, image, settings, verify);
    } else if (verified.length === 1) {
      point = verified[0];
    } else {
      // Multiple genuinely distinct matches survived verification (e.g. several people named
      // "Harshit", or repeated "General" rows across panes) — a single vision call can't tell
      // which one the user meant, so ask Jev to pick using the full utterance's intent. See
      // PROGRESS.md 2026-09-29.
      disambiguated = true;
      saveScreenClickDebugImage(window.imageBase64, description, "ambiguous");
      point = await this.disambiguateScreenClickCandidates(description, transcript, verified, { width: window.imageWidth, height: window.imageHeight }, (p) => ({ x: window.bounds.x + p.x * (window.bounds.width / window.imageWidth), y: window.bounds.y + p.y * (window.bounds.height / window.imageHeight) }), settings, signal);
    }

    // The vision model's point is in the sent image's pixel space, which can differ from
    // bounds' point space (Retina scaling and/or downscaling for cost/latency) — scale back
    // rather than assuming a 1:1 ratio.
    const scaleX = window.bounds.width / window.imageWidth;
    const scaleY = window.bounds.height / window.imageHeight;
    const screenX = window.bounds.x + point.x * scaleX;
    const screenY = window.bounds.y + point.y * scaleY;
    logger.event("automation.click_at", {
      description,
      bounds: window.bounds,
      imageWidth: window.imageWidth,
      imageHeight: window.imageHeight,
      imagePoint: point,
      verifiedLabel: point.label,
      matchCount: rawMatches.length,
      dedupedCount: candidates.length,
      verifiedCount: verified.length,
      retried,
      disambiguated,
      screenX,
      screenY,
    });
    await automation.clickAt(screenX, screenY);
  }

  /** screen_click via the OS accessibility tree instead of a screenshot: exact element frames,
   * no vision call. Only labelled elements are findable; unlabelled icons need Vision mode. */
  private async executeAccessibilityClick(description: string, transcript: string, settings: DragonSettings, signal: AbortSignal): Promise<void> {
    const tokens = labelTokens(description);
    const terms = tokens.filter((t) => t.length >= 3).length ? tokens.filter((t) => t.length >= 3) : tokens;
    if (!terms.length) throw new Error(`Nothing to look up for "${description}".`);
    const { window, elements } = await automation.findAccessibleElements(terms);
    // Window-relative, and only on-screen: scrolled-away list rows stay in the tree. Labels are
    // capped because some rows' AXDescription carries a message preview (Slack Activity).
    const located = elements
      .filter((e) => e.width > 0 && e.height > 0)
      .map((e) => ({ label: e.label.slice(0, 80), x: e.x - window.x + e.width / 2, y: e.y - window.y + e.height / 2, box: { x0: e.x - window.x, y0: e.y - window.y, x1: e.x - window.x + e.width, y1: e.y - window.y + e.height } }));
    const onScreen = located.filter((p) => p.x >= 0 && p.y >= 0 && p.x <= window.width && p.y <= window.height);
    const inWindow = onScreen.filter((p) => labelMatches(description, p.label));
    const candidates = dedupeMatches(inWindow);
    // Logged on EVERY accessibility lookup, hit or miss. Without it a failure and a stale build are
    // indistinguishable: both "just don't work", and `auto` mode swallows the miss by falling back
    // to vision. `matchCount` is the number of labels UIA returned and `candidateCount` what
    // survived the window-bounds + labelMatches filters, which splits the two failure modes apart.
    logger.event("screen_click.ax_lookup", {
      description,
      terms,
      matchCount: elements.length,
      locatedCount: located.length,
      onScreenCount: onScreen.length,
      labelMatchCount: inWindow.length,
      candidateCount: candidates.length,
      window,
      // Capped: enough to see which labels were found and where they sit relative to the window.
      labels: located.slice(0, 12).map((p) => ({ label: p.label, x: Math.round(p.x), y: Math.round(p.y) })),
    });
    if (candidates.length === 0) {
      // Two very different situations used to produce one indistinguishable message. Found but
      // off-screen means the row exists and is scrolled out of view -- clicking its stored
      // coordinates would hit whatever is at that spot instead, so refusing is correct, but
      // "scroll it into view first" is the fix, not "try Vision mode" (observed 2026-10-02: a
      // restored 1415x641 Settings window kept several sidebar rows out of view, and every one of
      // them was reported as "could not find ... in the accessibility tree").
      if (inWindow.length === 0 && onScreen.length > 0) {
        throw new AccessibilityMissError(`Found "${description}" but its label does not match the target — try naming it more exactly.`);
      }
      if (located.length > 0 && onScreen.length === 0) {
        throw new AccessibilityMissError(`Found "${description}" but it is scrolled out of view — scroll it into view and say that again.`);
      }
      throw new AccessibilityMissError(`Could not find "${description}" in the accessibility tree — try Vision screen-click mode.`);
    }
    const point =
      candidates.length === 1 ? candidates[0] : await this.disambiguateScreenClickCandidates(description, transcript, candidates, window, (p) => ({ x: window.x + p.x, y: window.y + p.y }), settings, signal);
    const screenX = window.x + point.x;
    const screenY = window.y + point.y;
    logger.event("automation.click_at", { description, method: "accessibility", bounds: window, matchCount: elements.length, candidateCount: candidates.length, label: point.label, screenX, screenY });
    await automation.clickAt(screenX, screenY);
  }

  /** Recovery path for when zero of `locateElements`' reported matches survive independent
   * verification: a tight relocate-crop retry around the model's best guess and one fresh
   * full-image attempt, run concurrently (same call budget as running them in sequence, one
   * round trip instead of two). The relocate-crop result wins if both verify. */
  private async recoverScreenClickPoint(
    description: string,
    bestGuess: LocatedPoint,
    window: ScreenClickWindow,
    image: NativeImage,
    settings: DragonSettings,
    verify: (p: LocatedPoint) => Promise<string>
  ): Promise<ScreenPoint> {
    // Two different failure modes need two different retries: a *close but imprecise* miss is
    // fixed by re-asking on a tighter crop around the same point (less competing UI per
    // pixel); a *wrong region entirely* miss (e.g. landed on a tab bar instead of the list
    // below it) means the target isn't even inside that crop — that case needs a fresh
    // full-image attempt instead.
    const relocateCrop = cropImage(image, window.imageWidth, window.imageHeight, boxAroundPoint(bestGuess.x, bestGuess.y, window.imageWidth, window.imageHeight, RELOCATE_CROP_MARGIN));
    const toFullImage = (m: LocatedPoint): LocatedPoint => ({
      x: relocateCrop.offsetX + m.x,
      y: relocateCrop.offsetY + m.y,
      label: m.label,
      box: { x0: relocateCrop.offsetX + m.box.x0, y0: relocateCrop.offsetY + m.box.y0, x1: relocateCrop.offsetX + m.box.x1, y1: relocateCrop.offsetY + m.box.y1 },
    });
    const attempts = await Promise.allSettled([
      locateElements(settings.openRouterApiKey, relocateCrop.imageBase64, description, relocateCrop.width, relocateCrop.height).then((ms) =>
        verifyCandidates(description, ms.slice(0, 1).map(toFullImage), verify)
      ),
      locateElements(settings.openRouterApiKey, window.imageBase64, description, window.imageWidth, window.imageHeight).then((ms) =>
        verifyCandidates(description, ms.slice(0, 1), verify)
      ),
    ]);
    if (attempts.every((a) => a.status === "rejected")) throw (attempts[0] as PromiseRejectedResult).reason;

    const results = attempts.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
    const winner = results.find((r) => r.verified.length > 0);
    if (winner) return winner.verified[0];
    const found = results.flatMap((r) => r.readbacks).find(Boolean) ?? "";
    throw new Error(`Could not confidently locate "${description}" on screen (found "${found}" instead).`);
  }

  /** Disambiguates among several independently-verified on-screen matches for the same
   * description by asking Jev to choose using the full utterance's context (same "give Jev N
   * candidates, let it choose" pattern as `buildTargetCandidates`/the `target` question — see
   * PROGRESS.md 2026-09-29). Falls back to a deterministic pick (natural reading order: topmost,
   * then leftmost) whenever Jev can't be asked, times out, or isn't confident enough — a click
   * should still happen even with no disambiguating signal. */
  private async disambiguateScreenClickCandidates(
    description: string,
    transcript: string,
    candidates: ScreenPoint[],
    area: { width: number; height: number },
    toScreen: (p: ScreenPoint) => { x: number; y: number },
    settings: DragonSettings,
    signal: AbortSignal
  ): Promise<ScreenPoint> {
    // Exactly one read-back equals the spoken target (e.g. "Harshit" vs "Harshit Agarwal") —
    // no need to ask Jev.
    const exact = candidates.filter((c) => labelExact(description, c.label));
    if (exact.length === 1) {
      logger.event("screen_click.disambiguation", { description, candidateCount: candidates.length, chosenLabel: exact[0].label, usedExactLabelMatch: true });
      return exact[0];
    }

    const criteria: Record<string, string> = {};
    candidates.forEach((c, i) => {
      criteria[String(i)] = `"${c.label}" ${describeRegion(c.x, c.y, area.width, area.height)}`;
    });

    const config: DecisionProviderConfig = {
      provider: settings.decisionProvider,
      openRouterApiKey: settings.openRouterApiKey,
      layaBaseUrl: settings.layaBaseUrl,
      layaModel: settings.layaModel,
    };
    const state = buildState({ transcript, activeApp: null, browserPage: null });
    const instructions = `The user asked to click "${description}", and multiple matching on-screen elements were found. Which one did they mean, based on the full transcript?`;

    const answer = await askDisambiguationChoice(config, state, instructions, criteria, signal);
    const idx = answer ? Number(answer.choice) : NaN;
    const confident = !!answer && answer.confidence >= SCREEN_CLICK_DISAMBIGUATION_CONFIDENCE_THRESHOLD && Number.isInteger(idx) && !!candidates[idx];

    logger.event("screen_click.disambiguation", {
      description,
      candidateCount: candidates.length,
      criteria,
      chosen: answer?.choice ?? null,
      confidence: answer?.confidence ?? null,
      askedUser: !confident,
    });

    if (confident) return candidates[idx];

    // Still ambiguous: don't guess, ask. The next final utterance "1".."5" picks (see
    // `handlePendingChoice`); anything else clears it.
    const ordered = [...candidates].sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 5);
    this.pendingChoice = {
      app: await automation.getActiveAppName().catch(() => null),
      expiresAt: Date.now() + PENDING_CHOICE_TTL_MS,
      options: ordered.map((c) => ({ label: c.label, ...toScreen(c) })),
    };
    const list = ordered.map((c, i) => `${i + 1}: "${c.label}" ${describeRegion(c.x, c.y, area.width, area.height)}`).join("; ");
    throw new ChoiceRequiredError(`Which one? Say a number — ${list}`);
  }

  /** Consumes a pending numbered choice. Returns true when the utterance was handled (picked
   * or cancelled); false when there is no live choice or the utterance is something else. */
  private async handlePendingChoice(text: string): Promise<{ error: string | null } | false> {
    const pending = this.pendingChoice;
    if (!pending) return false;
    this.pendingChoice = null;
    if (Date.now() > pending.expiresAt) return false;
    const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
    if (/^(?:cancel|never ?mind|stop)$/.test(t)) return { error: null };
    const m = t.match(/^(?:number |option )?(\d|one|won|two|to|too|three|four|for|five)$/);
    if (!m) return false;
    const words: Record<string, number> = { one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5 };
    const n = /\d/.test(m[1]) ? Number(m[1]) : words[m[1]];
    const choice = pending.options[n - 1];
    if (!choice) return false;
    try {
      // Coordinates are absolute; if the user switched apps meanwhile they're stale.
      if (pending.app && (await automation.getActiveAppName()) !== pending.app) {
        return { error: "Window changed, try again" };
      }
      logger.event("screen_click.choice_picked", { n, label: choice.label });
      await automation.clickAt(choice.x, choice.y);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async requireBrowserAction(action: BrowserAction): Promise<void> {
    if (!this.browserBridge.isConnected()) {
      throw new Error("Chrome extension is not connected. Load the unpacked extension and reload the page.");
    }
    const res = await this.browserBridge.sendAction(action);
    if (!res.ok) throw new Error(res.error ?? "Browser action failed");
  }
}

function describeCommand(cmd: ResolvedCommand): string {
  switch (cmd.kind) {
    case "open_app":
      return `Open ${cmd.appName}`;
    case "activate_app":
      return `Activate ${cmd.appName}`;
    case "hide_app":
      return `Hide ${cmd.appName}`;
    case "quit_app":
      return `Quit ${cmd.appName}`;
    case "type_text":
      return `Type "${cmd.text}"`;
    case "volume_set":
      return `Set volume to ${cmd.amount}`;
    case "chrome_open_url":
      return `Open ${cmd.url}`;
    case "chrome_search":
      return `Search for "${cmd.query}"`;
    case "search_in_app":
      return `Search for "${cmd.query}" in app`;
    case "screen_click":
      return `Click "${cmd.text}"`;
    case "replace_text":
      return `Replace "${cmd.find}" with "${cmd.replacement}"`;
    default:
      return cmd.kind.replace(/_/g, " ");
  }
}

function shortReplyFor(cmd: ResolvedCommand): string {
  switch (cmd.kind) {
    case "open_app":
      return `Opening ${cmd.appName}`;
    case "activate_app":
      return `Switching to ${cmd.appName}`;
    case "quit_app":
      return `Quitting ${cmd.appName}`;
    case "type_text":
      return "Typed";
    case "volume_set":
      return `Volume ${cmd.amount}`;
    case "volume_mute":
      return "Muted";
    case "chrome_search":
      return "Searching";
    case "screen_click":
      return "Clicking";
    case "chrome_open_url":
      return "Opening";
    default:
      return "Done";
  }
}
