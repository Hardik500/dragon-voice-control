import { nativeImage, NativeImage } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DeepgramFluxConnection } from "../stt/deepgram-client";
import { BrowserBridge } from "../browser/server";
import { logger } from "../logging/logger";
import { automation } from "../automation";
import { extractDeleteScope, extractKeyName, extractPayload, extractReplacePair, extractScreenPreviewTarget, extractWorkflowSteps, isStandaloneKeyboardCommand, shouldTypeDirectlyInInsertMode } from "../decision/extract";
import { buildQuestions, buildState, buildTargetCandidates } from "../decision/questions";
import { askDisambiguationChoice, callDecisionProvider, DecisionCancelledError, DecisionProviderConfig, DecisionRequestError } from "../decision/jev-client";
import { Box, dedupeMatches, LocatedPoint, locateElements, labelExact, labelMatches, labelTokens, readLabelAtPoint } from "../decision/vision-client";
import { INTERIM_ELIGIBLE_INTENTS, isDeterministicAppLaunch, isDeterministicScreenClick, resolveCommand, summarizeAnswers } from "../decision/resolve";
import { BrowserAction } from "../types/browser-protocol";
import { HistoryEntry, JevAnswerSummary, JevDecisionOutcome, JevDecisionTrace, OverlayUpdate, ResolvedCommand, ScreenTargetOverlay, TranscriptEvent } from "../types/pipeline";
import { DragonSettings } from "../types/settings";
import { SpeechConnectionStatus } from "../types/voice";
import { HistoryStore } from "./history-store";

const MAX_IN_FLIGHT_DECISIONS = 2;
const JEV_ADDRESSED_THRESHOLD = 0.55;
const LAYA_ADDRESSED_THRESHOLD = 0.5;
const INTENT_CONFIDENCE_THRESHOLD = 0.35;
const COMPLETE_THRESHOLD = 0.5;
const INTERIM_EXEC_INTENT_CONFIDENCE = 0.6;
const INTERIM_EXEC_COMPLETE = 0.6;
const DEFAULT_DELETE_WORD_COUNT = 3;
const MAX_REMEMBERED_UTTERANCES = 500;
const MAX_CACHED_ANSWERS = 100;
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
  | { type: "paragraph" }
  | { type: "punctuation"; text: string }
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
const POINT_HINT_TTL_MS = 5_000;

export class DragonPipeline {
  private deepgram: DeepgramFluxConnection | null = null;
  private lastActiveApp: string | null = null;
  private inFlight: InFlight[] = [];
  /** Serializes Jev work per utterance so EagerEndOfTurn cannot race the final EndOfTurn. */
  private decisionInFlightByUtterance = new Map<string, Promise<void>>();
  /** Emergency Stop invalidates decisions queued behind an in-flight eager turn too. */
  private decisionEpoch = 0;
  /** Preserve spoken command order, including provider decisions and local dictation edits. */
  private commandQueue: Promise<void> = Promise.resolve();
  private utteranceRevisions = new Map<string, number>();
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
  private streamingWanted = false;
  private streamGeneration = 0;
  private streamStartPromise: Promise<void> | null = null;
  private speechStatus: SpeechConnectionStatus = { state: "idle", message: null, reconnectAttempt: 0 };
  /** Failed recovery attempts reset only after a stable connection, not every brief open. */
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly STABLE_CONNECTION_MS = 30_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** A stopped push-to-talk session may deliver its final turn for at most 1.5 seconds. */
  private drainingConnection: DeepgramFluxConnection | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
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
  private pendingChoice: { app: string | null; expiresAt: number; options: { label: string; x: number; y: number }[]; preview: boolean; clicks: number; windowIdentity: string } | null = null;
  private screenTargets: ScreenTargetOverlay | null = null;
  private screenTargetTimer: NodeJS.Timeout | null = null;
  private lastOverlay: OverlayUpdate | null = null;
  /** Everything typed in the current dictation session, kept in sync with what's on screen
   * so "delete the last 3 words" / "replace X with Y" can compute exact backspace counts
   * instead of guessing. Cleared when dictation ends. */
  private dictationBuffer = "";
  /** The most recently appended chunk, for "delete that"/"undo that". */
  private lastDictationChunk = "";
  private dictationWindowIdentity: string | null = null;
  private dictationTrackingNotice: string | null = null;
  /** Browser workflow mode accepts sequential commands until toggled off or a step fails. */
  private workflowActive = false;
  private workflowStepCount = 0;
  private deterministicUtterances = new Set<string>();

  constructor(
    private getSettings: () => DragonSettings,
    private browserBridge: BrowserBridge,
    private publishOverlay: (update: OverlayUpdate) => void,
    private onSpeechStatus: (status: SpeechConnectionStatus) => void = () => {}
  ) {}

  /** Every pipeline update includes the current hints, so new speech cannot erase a picker. */
  private onOverlay(update: OverlayUpdate): void {
    this.lastOverlay = update;
    this.publishOverlay({ ...update, interactionMode: this.getInteractionMode(), screenTargets: this.screenTargets });
  }

  private clearScreenTargets(): void {
    if (this.screenTargetTimer) clearTimeout(this.screenTargetTimer);
    this.screenTargetTimer = null;
    const hadTargets = this.screenTargets !== null;
    this.screenTargets = null;
    this.pendingChoice = null;
    if (hadTargets && this.lastOverlay) this.onOverlay({ ...this.lastOverlay, status: null });
  }

  private showScreenTargets(targets: ScreenTargetOverlay): void {
    if (this.screenTargetTimer) clearTimeout(this.screenTargetTimer);
    this.screenTargets = targets;
    this.screenTargetTimer = setTimeout(() => this.clearScreenTargets(), Math.max(0, targets.expiresAt - Date.now()));
    this.screenTargetTimer.unref();
    if (this.lastOverlay) this.onOverlay(this.lastOverlay);
  }

  private async readWindowIdentity(signal: AbortSignal): Promise<string> {
    this.assertNotCancelled(signal);
    const identity = await automation.getActiveWindowIdentity().catch(() => null);
    this.assertNotCancelled(signal);
    if (!identity) throw new Error("Could not verify the focused window. Focus the target window and try again.");
    return identity;
  }

  private async assertWindowIdentity(expected: string, signal: AbortSignal): Promise<void> {
    if (await this.readWindowIdentity(signal) !== expected) {
      throw new Error("The focused window moved or changed. Name the target again.");
    }
  }

  private async finishScreenTarget(point: { x: number; y: number; label: string }, preview: boolean, signal: AbortSignal, clicks: number, windowIdentity: string): Promise<void> {
    this.assertNotCancelled(signal);
    await this.assertWindowIdentity(windowIdentity, signal);
    if (preview) {
      this.showScreenTargets({ kind: "point", targets: [point], expiresAt: Date.now() + POINT_HINT_TTL_MS });
      logger.event("screen_click.preview", { label: point.label, x: point.x, y: point.y });
      return Promise.resolve();
    }
    return automation.clickAt(point.x, point.y, clicks);
  }

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

  private invalidatePendingCommands(): void {
    this.decisionEpoch += 1;
    for (const request of this.inFlight) request.controller.abort();
    this.inFlight = [];
    this.executingUtteranceId = null;
  }

  toggleInsertMode(): boolean {
    this.invalidatePendingCommands();
    this.clearScreenTargets();
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
    this.invalidatePendingCommands();
    this.clearScreenTargets();
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

  getSpeechStatus(): SpeechConnectionStatus {
    return { ...this.speechStatus };
  }

  private setSpeechStatus(state: SpeechConnectionStatus["state"], message: string | null = null): void {
    this.speechStatus = { state, message, reconnectAttempt: this.reconnectAttempts };
    this.onSpeechStatus(this.getSpeechStatus());
  }

  private closeDrainingConnection(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const connection = this.drainingConnection;
    this.drainingConnection = null;
    connection?.close();
  }

  /** Starts one voice session; repeated starts share its pending connection attempt. */
  startStreaming(): Promise<void> {
    if (this.streamingWanted) {
      if (this.streamStartPromise) return this.streamStartPromise;
      if (this.micStreaming || this.reconnectTimer) return Promise.resolve();
    }
    this.closeDrainingConnection();
    this.streamingWanted = true;
    this.reconnectAttempts = 0;
    return this.connectStreaming(false);
  }

  private scheduleReconnect(detail: string): void {
    if (!this.streamingWanted || this.reconnectTimer) return;
    if (this.reconnectAttempts >= DragonPipeline.MAX_RECONNECT_ATTEMPTS) {
      this.streamingWanted = false;
      const message = "Lost connection to Deepgram; stopped after 5 recovery attempts. Try listening again.";
      logger.event("stt.reconnect_giving_up", { attempts: this.reconnectAttempts });
      this.setSpeechStatus("error", message);
      this.onOverlay(this.baseOverlay("error", message));
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 8000);
    const generation = this.streamGeneration;
    const message = `Reconnecting to Deepgram (attempt ${this.reconnectAttempts} of ${DragonPipeline.MAX_RECONNECT_ATTEMPTS})`;
    logger.event("stt.unexpected_close_reconnecting", { attempt: this.reconnectAttempts, delayMs, detail });
    this.setSpeechStatus("reconnecting", message);
    this.onOverlay(this.baseOverlay("idle", message));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.streamingWanted && generation === this.streamGeneration && !this.deepgram) {
        void this.connectStreaming(true);
      }
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private connectStreaming(isReconnect: boolean): Promise<void> {
    const settings = this.getSettings();
    if (!settings.deepgramApiKey) {
      this.streamingWanted = false;
      logger.event("pipeline.missing_deepgram_key", {});
      this.setSpeechStatus("error", "Deepgram API key is not set");
      this.onOverlay(this.baseOverlay("error", "Deepgram API key is not set"));
      return Promise.resolve();
    }
    const myGeneration = ++this.streamGeneration;
    let connectedAt: number | null = null;
    let lastError: string | null = null;
    const isGenerationCurrent = () => myGeneration === this.streamGeneration && this.streamingWanted;
    const isCurrent = () => isGenerationCurrent() && this.deepgram === connection;
    const connection = new DeepgramFluxConnection(
      settings.deepgramApiKey,
      (turn) => {
        // Only a graceful stop may still deliver a final turn. Restart/emergency clears it.
        if (isCurrent() || (this.drainingConnection === connection && turn.isFinal)) {
          void this.onTurn(turn);
        }
      },
      (err) => {
        if (!isCurrent()) return;
        lastError = err.message;
        logger.error("pipeline.stt_error", err);
      },
      (hadOpened) => {
        // A superseded close must never clear a newer connection's fields.
        if (!isCurrent()) return;
        this.micStreaming = false;
        this.deepgram = null;
        if (connectedAt !== null && Date.now() - connectedAt >= DragonPipeline.STABLE_CONNECTION_MS) {
          this.reconnectAttempts = 0;
        }
        // An explicit initial failure stops; failed recovery handshakes keep the same budget.
        if (hadOpened || isReconnect) {
          this.scheduleReconnect(lastError ?? "Deepgram connection closed");
        }
      },
      () => this.newUtteranceId()
    );
    this.deepgram = connection;
    this.setSpeechStatus(isReconnect ? "reconnecting" : "connecting",
      isReconnect ? `Reconnecting to Deepgram (attempt ${this.reconnectAttempts} of ${DragonPipeline.MAX_RECONNECT_ATTEMPTS})` : "Connecting to Deepgram");
    this.onOverlay(this.baseOverlay("idle", this.speechStatus.message ?? ""));
    const attempt = connection.connect()
      .then(() => {
        if (!isCurrent()) {
          connection.close();
          return;
        }
        connectedAt = Date.now();
        this.micStreaming = true;
        this.setSpeechStatus("connected");
        this.onOverlay(this.baseOverlay("listening", ""));
      })
      .catch((err) => {
        if (!isGenerationCurrent()) return;
        logger.error("pipeline.stt_connect_failed", err);
        if (this.deepgram === connection) this.deepgram = null;
        this.micStreaming = false;
        connection.close();
        const message = err instanceof Error ? err.message : String(err);
        if (isReconnect) {
          this.scheduleReconnect(message);
        } else {
          this.streamingWanted = false;
          this.setSpeechStatus("error", message);
          this.onOverlay(this.baseOverlay("error", message));
        }
      })
      .finally(() => {
        if (this.streamStartPromise === attempt) this.streamStartPromise = null;
      });
    this.streamStartPromise = attempt;
    return attempt;
  }

  /**
   * A graceful push-to-talk stop flushes only the final turn before closing. Every stop
   * invalidates pending handshakes immediately, including stop during connection setup.
   */
  stopStreaming(opts: { graceful?: boolean } = {}): void {
    this.streamingWanted = false;
    this.streamGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.streamStartPromise = null;
    this.closeDrainingConnection();
    const connection = this.deepgram;
    const wasStreaming = this.micStreaming;
    this.deepgram = null;
    this.micStreaming = false;
    if (connection && opts.graceful && wasStreaming) {
      this.drainingConnection = connection;
      try {
        connection.forceEndTurn();
      } catch (err) {
        logger.error("pipeline.stt_flush_failed", err);
      }
      this.drainTimer = setTimeout(() => {
        if (this.drainingConnection === connection) this.closeDrainingConnection();
      }, 1500);
      this.drainTimer.unref();
    } else {
      connection?.close();
    }
    this.setSpeechStatus("idle");
    this.onOverlay(this.baseOverlay("idle", ""));
  }

  isStreaming(): boolean {
    return this.micStreaming;
  }

  handleMicChunk(chunk: Buffer): void {
    this.deepgram?.sendAudio(chunk);
  }

  /** Capture failures keep the dictation session but replace any stale target prompt. */
  reportMicrophoneError(message: string): void {
    this.clearScreenTargets();
    this.onOverlay(this.baseOverlay("error", message));
  }

  /** Aborts in-flight decisions, stops any spoken reply, and stops streaming. Bound to the emergency-stop shortcut. */
  emergencyStop(): void {
    this.invalidatePendingCommands();
    this.clearScreenTargets();
    this.executingUtteranceId = null;
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

  private assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new DecisionCancelledError("Command cancelled");
  }

  private rememberUtterance(set: Set<string>, utteranceId: string): void {
    set.add(utteranceId);
    while (set.size > MAX_REMEMBERED_UTTERANCES) set.delete(set.values().next().value!);
  }

  /** Track the exact inserted bytes, including joining spaces, punctuation and line breaks. */
  private appendDictationRaw(text: string): void {
    this.dictationActive = true;
    this.dictationBuffer += text;
    this.lastDictationChunk = text;
  }

  private dictationInsertion(chunk: string): string {
    const needsSpace = this.dictationBuffer.length > 0 && !/[\s(\[{“]$/.test(this.dictationBuffer) &&
      !/^[\s.,!?;:)}\]"'’”]/.test(chunk);
    return needsSpace ? ` ${chunk}` : chunk;
  }

  private async syncDictationWindow(signal: AbortSignal): Promise<string | null> {
    this.assertNotCancelled(signal);
    const identity = await automation.getActiveWindowIdentity().catch(() => null);
    this.assertNotCancelled(signal);
    this.dictationTrackingNotice = null;
    if (!identity || this.dictationWindowIdentity && identity !== this.dictationWindowIdentity) {
      this.clearDictationTail();
      this.dictationTrackingNotice = identity ? "Text tracking restarted in the new window" : "Typed text cannot be tracked until the focused window can be verified";
    }
    this.dictationWindowIdentity = identity;
    return identity;
  }

  private async dictationWindowUnchanged(expected: string | null, signal: AbortSignal): Promise<boolean> {
    this.assertNotCancelled(signal);
    const identity = await automation.getActiveWindowIdentity().catch(() => null);
    this.assertNotCancelled(signal);
    if (!expected || identity !== expected) {
      this.clearDictationTail();
      this.dictationWindowIdentity = identity;
      this.dictationTrackingNotice = "Focused window changed; text tracking restarted";
      return false;
    }
    return true;
  }

  private async typeDictation(chunk: string, signal: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    if (this.workflowActive) {
      await automation.typeText(chunk);
      this.assertNotCancelled(signal);
      return;
    }
    const identity = await this.syncDictationWindow(signal);
    const inserted = this.dictationInsertion(chunk);
    try {
      await automation.typeText(inserted);
    } catch (error) {
      this.clearDictationTail();
      throw error;
    }
    this.assertNotCancelled(signal);
    this.dictationActive = true;
    if (await this.dictationWindowUnchanged(identity, signal)) this.appendDictationRaw(inserted);
  }

  private clearDictationTail(): void {
    this.dictationBuffer = "";
    this.lastDictationChunk = "";
    this.dictationWindowIdentity = null;
  }

  private deletionCount(text: string): number {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  }

  private async pressTrackedKey(keyName: string, signal: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    const identity = this.dictationActive ? await this.syncDictationWindow(signal) : null;
    try {
      await automation.pressNamedKey(keyName);
    } catch (error) {
      this.clearDictationTail();
      throw error;
    }
    this.assertNotCancelled(signal);
    if (!this.dictationActive) return;
    if (keyName === "space") {
      if (await this.dictationWindowUnchanged(identity, signal)) this.appendDictationRaw(" ");
    }
    // No app text/caret reads: after selection, navigation, submission or an external edit,
    // the old suffix can no longer be edited by a known number of Backspaces.
    else if (keyName !== "copy" && keyName !== "save") this.clearDictationTail();
  }

  private stopWorkflow() {
    this.workflowActive = false;
    this.workflowStepCount = 0;
  }

  private endDictation() {
    this.dictationActive = false;
    this.clearDictationTail();
    this.dictationTrackingNotice = null;
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
    if (/^(?:new|next)\s+paragraph$/.test(lower)) return { type: "paragraph" };
    const punctuation: Record<string, string> = {
      comma: ",", period: ".", "full stop": ".", "question mark": "?",
      "exclamation mark": "!", "exclamation point": "!", colon: ":", semicolon: ";",
      "open quote": "“", "close quote": "”", "open parenthesis": "(", "close parenthesis": ")",
    };
    if (punctuation[lower]) return { type: "punctuation", text: punctuation[lower] };
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

  private async runDictationControl(turn: TranscriptEvent, control: DictationControl, settings: DragonSettings, signal: AbortSignal, record = true): Promise<void> {
    this.assertNotCancelled(signal);
    this.clearScreenTargets();
    if (record) this.rememberUtterance(this.deterministicUtterances, turn.utteranceId);
    this.updateJevDecisionOutcome(
      turn.utteranceId,
      "cancelled",
      "Handled by deterministic local control"
    );

    const startedAt = Date.now();
    let actionLabel = "";
    let execError: string | null = null;
    let mutationStarted = false;
    try {
      const edits = ["newline", "paragraph", "punctuation", "delete_all", "delete_last_chunk", "delete_words", "replace"];
      const windowIdentity = edits.includes(control.type) ? await this.syncDictationWindow(signal) : null;
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
          await this.pressTrackedKey(control.keyName, signal);
          break;
        case "browser_new_tab":
          actionLabel = "Open new tab";
          await this.requireBrowserAction({ kind: "new_tab" });
          this.assertNotCancelled(signal);
          break;
        case "stop":
          actionLabel = "Stop dictation";
          this.endDictation();
          break;
        case "newline":
        case "paragraph":
        case "punctuation": {
          const raw = control.type === "newline" ? "\n" : control.type === "paragraph" ? "\n\n" : control.text;
          const text = control.type === "punctuation" && (raw === "“" || raw === "(") ? this.dictationInsertion(raw) : raw;
          actionLabel = control.type === "newline" ? "New line" : control.type === "paragraph" ? "New paragraph" : `Insert ${text}`;
          mutationStarted = true;
          await automation.typeText(text);
          this.assertNotCancelled(signal);
          if (await this.dictationWindowUnchanged(windowIdentity, signal)) this.appendDictationRaw(text);
          break;
        }
        case "delete_all": {
          actionLabel = "Delete everything typed";
          if (!this.dictationBuffer) throw new Error("No tracked text to delete. Dictate text in the current field first.");
          mutationStarted = true;
          await automation.deleteBackward(this.deletionCount(this.dictationBuffer));
          this.assertNotCancelled(signal);
          this.clearDictationTail();
          this.dictationWindowIdentity = windowIdentity;
          break;
        }
        case "delete_last_chunk": {
          actionLabel = "Delete that";
          const chunk = this.lastDictationChunk;
          if (!chunk) throw new Error("No tracked dictation to undo. Dictate text in the current field first.");
          mutationStarted = true;
          await automation.deleteBackward(this.deletionCount(chunk));
          this.assertNotCancelled(signal);
          if (await this.dictationWindowUnchanged(windowIdentity, signal)) {
            this.dictationBuffer = this.dictationBuffer.slice(0, -chunk.length);
            this.lastDictationChunk = "";
          }
          break;
        }
        case "delete_words": {
          actionLabel = `Delete last ${control.count} word(s)`;
          if (!this.dictationBuffer) throw new Error("No tracked text to delete. Dictate text in the current field first.");
          const words = Array.from(this.dictationBuffer.matchAll(/\S+/gu));
          const keep = Math.max(0, words.length - Math.max(0, control.count));
          const last = words[keep - 1];
          const keepEnd = last ? last.index! + last[0].length : 0;
          const newBuffer = control.count <= 0 ? this.dictationBuffer : this.dictationBuffer.slice(0, keepEnd);
          mutationStarted = true;
          await automation.deleteBackward(this.deletionCount(this.dictationBuffer.slice(newBuffer.length)));
          this.assertNotCancelled(signal);
          if (await this.dictationWindowUnchanged(windowIdentity, signal)) {
            this.dictationBuffer = newBuffer;
            this.lastDictationChunk = "";
          }
          break;
        }
        case "replace": {
          actionLabel = `Replace "${control.find}" with "${control.replacement}"`;
          // Match on the original string: lowercasing can expand characters (e.g. İ),
          // so indexes from a lowercased copy cannot safely slice the typed text.
          const escaped = control.find.replace(/[.*+?^{}()|[\]\\$]/g, "\\$&");
          const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;
          const needleCharacters = Array.from(control.find);
          let match: RegExpMatchArray | undefined;
          for (const candidate of this.dictationBuffer.matchAll(new RegExp(escaped, "giu"))) {
            const index = candidate.index!;
            const previous = Array.from(this.dictationBuffer.slice(0, index)).at(-1) ?? "";
            const next = Array.from(this.dictationBuffer.slice(index + candidate[0].length))[0] ?? "";
            if (wordCharacter.test(needleCharacters[0] ?? "") && wordCharacter.test(previous)) continue;
            if (wordCharacter.test(needleCharacters.at(-1) ?? "") && wordCharacter.test(next)) continue;
            match = candidate;
          }
          if (!match) throw new Error(`Nothing matching "${control.find}" in what was typed recently`);
          const before = this.dictationBuffer.slice(0, match.index!);
          const after = this.dictationBuffer.slice(match.index! + match[0].length);
          const newBuffer = before + control.replacement + after;
          let prefixLen = 0;
          const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
          const beforeSegments = Array.from(segmenter.segment(this.dictationBuffer), (part) => part.segment);
          const afterSegments = Array.from(segmenter.segment(newBuffer), (part) => part.segment);
          for (let i = 0; i < Math.min(beforeSegments.length, afterSegments.length) && beforeSegments[i] === afterSegments[i]; i++) {
            prefixLen += beforeSegments[i].length;
          }
          mutationStarted = true;
          await automation.deleteBackward(this.deletionCount(this.dictationBuffer.slice(prefixLen)));
          this.assertNotCancelled(signal);
          if (!await this.dictationWindowUnchanged(windowIdentity, signal)) throw new Error("Focused window changed during replacement. Focus the original field and dictate again.");
          // Track the confirmed prefix while retyping; an interrupted edit invalidates the tail.
          this.dictationBuffer = this.dictationBuffer.slice(0, prefixLen);
          this.lastDictationChunk = "";
          const retype = newBuffer.slice(prefixLen);
          if (retype) {
            await automation.typeText(retype);
            this.assertNotCancelled(signal);
            if (await this.dictationWindowUnchanged(windowIdentity, signal)) this.dictationBuffer += retype;
          }
          break;
        }
      }
    } catch (err) {
      if (mutationStarted) this.clearDictationTail();
      if (signal.aborted || err instanceof DecisionCancelledError) throw new DecisionCancelledError("Command cancelled");
      if (!record) throw err;
      execError = err instanceof Error ? err.message : String(err);
    }
    this.assertNotCancelled(signal);
    if (!record) return;
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
      status: execError ?? this.dictationTrackingNotice,
      latencyMs: totalMs,
      activationMode: settings.activationMode,
    });

    this.history.add({
      utteranceId: turn.utteranceId,
      timestamp: Date.now(),
      transcript: turn.transcript,
      intent: control.type === "key" ? "press_key" : control.type === "browser_new_tab" ? "chrome_new_tab" : control.type === "replace" ? "replace_text" : control.type.startsWith("delete") ? "delete_text" : "type_text",
      action: actionLabel,
      status: execError ? "error" : "success",
      detail: execError ?? "",
    });
  }

  private async onTurn(turn: TranscriptEvent): Promise<void> {
    const settings = this.getSettings();
    automation.stopSpeaking(); // barge-in: new speech interrupts any spoken reply.

    if (turn.event === "TurnResumed") {
      this.utteranceRevisions.set(turn.utteranceId, (this.utteranceRevisions.get(turn.utteranceId) ?? 0) + 1);
      while (this.utteranceRevisions.size > MAX_REMEMBERED_UTTERANCES) this.utteranceRevisions.delete(this.utteranceRevisions.keys().next().value!);
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
    const epoch = this.decisionEpoch;
    const revision = this.utteranceRevisions.get(turn.utteranceId) ?? 0;
    const work = this.commandQueue.then(async () => {
      if (epoch !== this.decisionEpoch || revision !== (this.utteranceRevisions.get(turn.utteranceId) ?? 0)) {
        logger.event("pipeline.queued_decision_cancelled", { utteranceId: turn.utteranceId, turnEvent: turn.event });
        return;
      }
      await this.processCommandTurn(turn, effectiveText, settings);
    });
    this.commandQueue = work.catch((err) => {
      if (!(err instanceof DecisionCancelledError)) logger.error("pipeline.local_command_failed", err, { utteranceId: turn.utteranceId });
    });
    await this.commandQueue;
  }

  private async processCommandTurn(turn: TranscriptEvent, effectiveText: string, settings: DragonSettings): Promise<void> {
    if (this.executedUtterances.has(turn.utteranceId)) {
      if (turn.isFinal) this.pruneCacheForUtterance(turn.utteranceId);
      return;
    }
    if (turn.isFinal && this.screenTargets?.kind === "point") this.clearScreenTargets();
    if (!this.dictationActive && !/^\s*(?:please\s+)?(?:type|write|dictate|enter)\b/i.test(effectiveText) && extractWorkflowSteps(effectiveText)) {
      if (turn.isFinal) {
        this.rememberUtterance(this.executedUtterances, turn.utteranceId);
        this.logIgnored(turn, "compound_command", "none", "Speak one command at a time. Wait for it to finish, then say the next command.");
      }
      return;
    }

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
      this.rememberUtterance(this.executedUtterances, turn.utteranceId);
      const controller = this.registerInFlight(turn.utteranceId);
      try {
        await this.runDictationControl(turn, control, settings, controller.signal);
      } finally {
        this.unregisterInFlight(controller);
      }
      return;
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

  private async runDecision(turn: TranscriptEvent, effectiveText: string, settings: DragonSettings): Promise<void> {
    // Serialize decisions per utterance so an EagerEndOfTurn and the EndOfTurn behind it can't
    // both spend a provider call on the same sentence. The chaining has to happen
    // synchronously: reading `previous` and only then storing `current` left a window where two
    // turns arriving in the same tick both read the same `previous`, both resumed when it
    // settled, and both ran — three concurrent provider calls for one utterance were logged on
    // 2026-09-25, and a response derived from a stale interim transcript could win that race.
    const epoch = this.decisionEpoch;
    const previous = this.decisionInFlightByUtterance.get(turn.utteranceId);
    const run = () => {
      if (epoch !== this.decisionEpoch) {
        logger.event("pipeline.queued_decision_cancelled", { utteranceId: turn.utteranceId, turnEvent: turn.event });
        return Promise.resolve();
      }
      return this.runDecisionInternal(turn, effectiveText, settings);
    };
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

    if (this.pendingChoice && Date.now() > this.pendingChoice.expiresAt) this.clearScreenTargets();
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
      const handled = await this.handlePendingChoice(effectiveText, controller.signal);
      if (handled) {
        if (handled.cancelled || controller.signal.aborted) {
          this.unregisterInFlight(controller);
          return;
        }
        this.rememberUtterance(this.executedUtterances, turn.utteranceId);
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
      if (!turn.isFinal) {
        this.unregisterInFlight(controller);
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
      try {
        await this.continueDictation(turn, effectiveText, settings, Date.now() - startedAt, sttToDecisionMs, controller.signal);
      } finally {
        this.unregisterInFlight(controller);
      }
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
      if (controller.signal.aborted) throw new DecisionCancelledError("Command cancelled");
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
        while (this.jevAnswerCache.size > MAX_CACHED_ANSWERS) this.jevAnswerCache.delete(this.jevAnswerCache.keys().next().value!);
      }
      if (turn.isFinal) this.pruneCacheForUtterance(turn.utteranceId);
      if (controller.signal.aborted) throw new DecisionCancelledError("Command cancelled");

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
          await this.continueDictation(turn, effectiveText, settings, decisionMs, sttToDecisionMs, controller.signal);
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
        (!extractScreenPreviewTarget(effectiveText) &&
          turn.event === "EagerEndOfTurn" &&
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
      const deterministicClick = turn.isFinal && !this.dictationActive &&
        (!this.workflowActive || extractScreenPreviewTarget(effectiveText) !== null) && isDeterministicScreenClick(effectiveText, payload);
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
          await this.continueDictation(turn, effectiveText, settings, decisionMs, sttToDecisionMs, controller.signal);
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
      if (controller.signal.aborted) throw new DecisionCancelledError("Command cancelled");
      this.rememberUtterance(this.executedUtterances, turn.utteranceId);

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
        this.assertNotCancelled(controller.signal);
      } catch (err) {
        if (controller.signal.aborted || err instanceof DecisionCancelledError) throw new DecisionCancelledError("Command cancelled");
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
          status: execError || (this.workflowActive ? `Workflow · Step ${this.workflowStepCount}` : this.dictationTrackingNotice),
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
        if (this.executingUtteranceId === turn.utteranceId) this.executingUtteranceId = null;
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
    } finally {
      this.unregisterInFlight(controller);
    }
  }

  /** Jev didn't recognize a command for this utterance while a dictation session is active:
   * type it verbatim and fold it into the tracked buffer instead of discarding it. */
  private async continueDictation(
    turn: TranscriptEvent,
    effectiveText: string,
    settings: DragonSettings,
    decisionMs: number,
    sttToDecisionMs: number,
    signal: AbortSignal
  ): Promise<void> {
    if (this.executedUtterances.has(turn.utteranceId)) return;
    this.rememberUtterance(this.executedUtterances, turn.utteranceId);

    const execStarted = Date.now();
    const sttTurnMs = Math.max(0, turn.receivedAt - turn.turnStartedAt);
    let execError: string | null = null;
    try {
      await this.typeDictation(effectiveText, signal);
    } catch (err) {
      if (signal.aborted || err instanceof DecisionCancelledError) throw new DecisionCancelledError("Command cancelled");
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
      status: execError ?? this.dictationTrackingNotice,
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
    if (turn.isFinal) this.rememberUtterance(this.ignoredLoggedUtterances, turn.utteranceId);
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
    if (signal.aborted) throw new DecisionCancelledError("Command cancelled");
    this.clearScreenTargets();
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
        return this.typeDictation(cmd.text!, signal);
      case "insert_newline": {
        if (this.workflowActive) {
          await automation.typeText("\n");
          this.assertNotCancelled(signal);
          return;
        }
        const identity = await this.syncDictationWindow(signal);
        await automation.typeText("\n");
        this.assertNotCancelled(signal);
        this.dictationActive = true;
        if (await this.dictationWindowUnchanged(identity, signal)) this.appendDictationRaw("\n");
        return;
      }
      case "press_key":
      case "shortcut":
        return this.pressTrackedKey(cmd.keyName!, signal);
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
        return this.openUrlPreferringExistingTab(cmd.url!, signal);
      case "chrome_search":
        return this.openUrlPreferringExistingTab(
          cmd.url ?? `https://www.google.com/search?q=${encodeURIComponent(cmd.query!)}`, signal
        );
      case "chrome_click":
        return this.requireBrowserAction({ kind: "click", elementId: cmd.elementId! });
      case "chrome_type":
        return this.requireBrowserAction({ kind: "type", elementId: cmd.elementId!, text: cmd.text! });
      case "chrome_select":
        return this.requireBrowserAction({ kind: "select", elementId: cmd.elementId!, text: cmd.text });
      case "chrome_scroll": {
        const activeApp = await automation.getActiveAppName().catch(() => null);
        this.assertNotCancelled(signal);
        if (activeApp && /chrome/i.test(activeApp) && this.browserBridge.isConnected()) {
          return this.requireBrowserAction({ kind: "scroll", direction: cmd.direction ?? "down" });
        }
        const keys: Record<string, string> = {
          up: "page up", down: "page down", left: "arrow left", right: "arrow right",
          top: "beginning of document", bottom: "end of document",
        };
        return this.pressTrackedKey(keys[cmd.direction ?? "down"] ?? "page down", signal);
      }
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
        return this.requireBrowserAction({ kind: "switch_tab", direction: cmd.direction ?? "next", index: cmd.amount, title: cmd.query });
      case "screen_click":
        return this.executeScreenClick(cmd.text!, transcript, signal, cmd.double ? 2 : 1, cmd.preview ?? false);
      case "search_in_app":
        return this.executeSearchInApp(cmd.query!, signal);
      case "replace_text": {
        if (!this.dictationActive) {
          throw new Error("Nothing to replace — say \"type ...\" first to dictate something.");
        }
        await this.runDictationControl(
          SYNTHETIC_TURN,
          { type: "replace", find: cmd.find!, replacement: cmd.replacement! },
          this.getSettings(), signal, false
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
        await this.runDictationControl(SYNTHETIC_TURN, control, this.getSettings(), signal, false);
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
  private async openUrlPreferringExistingTab(url: string, signal: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    if (this.browserBridge.isConnected()) {
      const res = await this.browserBridge.sendAction({ kind: "focus_or_open", url });
      this.assertNotCancelled(signal);
      if (res.ok) return;
      logger.event("pipeline.focus_or_open_failed_fallback", { error: res.error });
    }
    this.assertNotCancelled(signal);
    await automation.openUrlInChrome(url);
  }

  /** Generic "search inside the current non-browser app" via its quick-open/jump-to shortcut
   * (Cmd/Ctrl+K — Slack, Notion, VS Code, Discord, Linear, and many other apps all use this
   * convention). Not app-specific automation; just the one nearly-universal shortcut. */
  private async executeSearchInApp(query: string, signal: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    await automation.pressNamedKey("quick switcher");
    await this.delay(300, signal);
    await automation.typeText(query);
    await this.delay(200, signal);
    await automation.pressNamedKey("enter");
    this.assertNotCancelled(signal);
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new DecisionCancelledError("Command cancelled")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Vision-based click: screenshots the frontmost window only, discovers every on-screen match
   * for the description, independently verifies each one, disambiguates if more than one survives
   * verification, then moves+clicks at the corresponding absolute screen coordinate (window
   * bounds + relative offset). */
  private async executeScreenClick(description: string, transcript: string, signal: AbortSignal, clicks = 1, preview = false): Promise<void> {
    // Clear markers before lookup/capture so Dragon's hints never appear in its own image.
    this.clearScreenTargets();
    if (signal.aborted) throw new DecisionCancelledError("Screen target request cancelled");
    const settings = this.getSettings();
    const windowIdentity = await this.readWindowIdentity(signal);
    if (settings.screenClickMethod === "accessibility") return this.executeAccessibilityClick(description, transcript, settings, signal, clicks, preview, windowIdentity);
    if (settings.screenClickMethod === "auto") {
      try {
        return await this.executeAccessibilityClick(description, transcript, settings, signal, clicks, preview, windowIdentity);
      } catch (err) {
        if (signal.aborted || !(err instanceof AccessibilityMissError)) throw err;
        logger.event("screen_click.fallback", { description, fallback: "accessibility_miss" });
      }
    }
    await this.assertWindowIdentity(windowIdentity, signal);
    const window = await automation.captureFrontmostWindow();
    if (signal.aborted) throw new DecisionCancelledError("Screen target request cancelled");
    // Decode once per click; every verify/relocate crop reuses it.
    const image = nativeImage.createFromBuffer(Buffer.from(window.imageBase64, "base64"));
    const rawMatches = await locateElements(settings.openRouterApiKey, window.imageBase64, description, window.imageWidth, window.imageHeight, signal);
    if (rawMatches.length === 0) {
      saveScreenClickDebugImage(window.imageBase64, description, "no_match");
      throw new Error(`Could not find "${description}" on screen.`);
    }
    this.assertNotCancelled(signal);
    const candidates = dedupeMatches(rawMatches);

    // The model's own `label` field turned out to be self-consistently unreliable as a
    // verification signal — it can echo back the requested description even when its
    // coordinates land on a completely different row (grounding failure, not a wrong-row pick).
    // So verify each reported match independently: crop tightly around it and ask a
    // separately-framed "what text is here?" question with no hint of the target — if that
    // doesn't match, the point itself is wrong regardless of what the first call's label
    // claimed. See PROGRESS.md 2026-09-28.
    const verify = (p: LocatedPoint) =>
      readLabelAtPoint(settings.openRouterApiKey, cropImage(image, window.imageWidth, window.imageHeight, verifyBox(p, window.imageWidth, window.imageHeight)).imageBase64, signal);

    const { verified } = await verifyCandidates(description, candidates, verify);
    this.assertNotCancelled(signal);

    let point: ScreenPoint;
    let retried = false;
    let disambiguated = false;
    if (verified.length === 0) {
      // None of the reported matches survived independent verification — fall back to the
      // recovery path (tight relocate-crop retry + one fresh full-image attempt, concurrently)
      // using the model's best guess as the starting point.
      retried = true;
      saveScreenClickDebugImage(window.imageBase64, description, "unverified");
      point = await this.recoverScreenClickPoint(description, candidates[0], window, image, settings, verify, signal);
    } else if (verified.length === 1) {
      point = verified[0];
    } else {
      // Multiple genuinely distinct matches survived verification (e.g. several people named
      // "Harshit", or repeated "General" rows across panes) — a single vision call can't tell
      // which one the user meant, so ask Jev to pick using the full utterance's intent. See
      // PROGRESS.md 2026-09-29.
      disambiguated = true;
      saveScreenClickDebugImage(window.imageBase64, description, "ambiguous");
      point = await this.disambiguateScreenClickCandidates(description, transcript, verified, { width: window.imageWidth, height: window.imageHeight }, (p) => ({ x: window.bounds.x + p.x * (window.bounds.width / window.imageWidth), y: window.bounds.y + p.y * (window.bounds.height / window.imageHeight) }), settings, signal, clicks, preview, windowIdentity);
    }

    // The vision model's point is in the sent image's pixel space, which can differ from
    // bounds' point space (Retina scaling and/or downscaling for cost/latency) — scale back
    // rather than assuming a 1:1 ratio.
    const scaleX = window.bounds.width / window.imageWidth;
    const scaleY = window.bounds.height / window.imageHeight;
    const screenX = window.bounds.x + point.x * scaleX;
    const screenY = window.bounds.y + point.y * scaleY;
    logger.event(preview ? "screen_click.preview_located" : "automation.click_at", {
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
    await this.finishScreenTarget({ x: screenX, y: screenY, label: point.label }, preview, signal, clicks, windowIdentity);
  }

  /** screen_click via the OS accessibility tree instead of a screenshot: exact element frames,
   * no vision call. Only labelled elements are findable; unlabelled icons need Vision mode. */
  private async executeAccessibilityClick(description: string, transcript: string, settings: DragonSettings, signal: AbortSignal, clicks = 1, preview = false, windowIdentity: string): Promise<void> {
    const tokens = labelTokens(description);
    const terms = tokens.filter((t) => t.length >= 3).length ? tokens.filter((t) => t.length >= 3) : tokens;
    if (!terms.length) throw new Error(`Nothing to look up for "${description}".`);
    const { window, elements } = await automation.findAccessibleElements(terms);
    if (signal.aborted) throw new DecisionCancelledError("Screen target request cancelled");
    // Window-relative, and only on-screen: scrolled-away list rows stay in the tree. Labels are
    // capped because some rows' AXDescription carries a message preview (Slack Activity).
    const located = elements
      .filter((e) => e.width > 0 && e.height > 0)
      .map((e) => ({ menu: e.menu, label: e.label.slice(0, 80), x: e.x - window.x + e.width / 2, y: e.y - window.y + e.height / 2, box: { x0: e.x - window.x, y0: e.y - window.y, x1: e.x - window.x + e.width, y1: e.y - window.y + e.height } }));
    const onScreen = located.filter((p) => p.menu || p.x >= 0 && p.y >= 0 && p.x <= window.width && p.y <= window.height);
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
      candidates.length === 1 ? candidates[0] : await this.disambiguateScreenClickCandidates(description, transcript, candidates, window, (p) => ({ x: window.x + p.x, y: window.y + p.y }), settings, signal, clicks, preview, windowIdentity);
    const screenX = window.x + point.x;
    const screenY = window.y + point.y;
    logger.event(preview ? "screen_click.preview_located" : "automation.click_at", { description, method: "accessibility", bounds: window, matchCount: elements.length, candidateCount: candidates.length, label: point.label, screenX, screenY });
    await this.finishScreenTarget({ x: screenX, y: screenY, label: point.label }, preview, signal, clicks, windowIdentity);
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
    verify: (p: LocatedPoint) => Promise<string>,
    signal: AbortSignal
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
      locateElements(settings.openRouterApiKey, relocateCrop.imageBase64, description, relocateCrop.width, relocateCrop.height, signal).then((ms) =>
        verifyCandidates(description, ms.slice(0, 1).map(toFullImage), verify)
      ),
      locateElements(settings.openRouterApiKey, window.imageBase64, description, window.imageWidth, window.imageHeight, signal).then((ms) =>
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
   * PROGRESS.md 2026-09-29). Shows numbered choices when the model cannot distinguish the
   * matching elements. */
  private async disambiguateScreenClickCandidates(
    description: string,
    transcript: string,
    candidates: ScreenPoint[],
    area: { width: number; height: number },
    toScreen: (p: ScreenPoint) => { x: number; y: number },
    settings: DragonSettings,
    signal: AbortSignal,
    clicks = 1,
    preview = false,
    windowIdentity: string
  ): Promise<ScreenPoint> {
    if (signal.aborted) throw new DecisionCancelledError("Screen target request cancelled");
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
    if (signal.aborted) throw new DecisionCancelledError("Screen target request cancelled");
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
    await this.assertWindowIdentity(windowIdentity, signal);
    const app = await automation.getActiveAppName().catch(() => null);
    if (signal.aborted) throw new DecisionCancelledError("Screen target request cancelled");
    const expiresAt = Date.now() + PENDING_CHOICE_TTL_MS;
    this.pendingChoice = {
      app,
      expiresAt,
      options: ordered.map((c) => ({ label: c.label, ...toScreen(c) })),
      preview,
      clicks,
      windowIdentity,
    };
    this.showScreenTargets({
      kind: "choice",
      targets: this.pendingChoice.options.map((c, i) => ({ ...c, number: i + 1 })),
      expiresAt,
    });
    const list = ordered.map((c, i) => `${i + 1}: "${c.label}" ${describeRegion(c.x, c.y, area.width, area.height)}`).join("; ");
    throw new ChoiceRequiredError(`Which one? Say a number — ${list}`);
  }

  /** Consumes a pending numbered choice. Returns true when the utterance was handled (picked
   * or cancelled); false when there is no live choice or the utterance is something else. */
  private async handlePendingChoice(text: string, signal: AbortSignal): Promise<{ error: string | null; cancelled?: boolean } | false> {
    const pending = this.pendingChoice;
    if (!pending) return false;
    this.clearScreenTargets();
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
      await this.assertWindowIdentity(pending.windowIdentity, signal);
      if (signal.aborted) return { error: null, cancelled: true };
      logger.event("screen_click.choice_picked", { n, label: choice.label });
      await this.finishScreenTarget(choice, pending.preview, signal, pending.clicks, pending.windowIdentity);
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
      return `${cmd.preview ? "Highlight" : cmd.double ? "Double click" : "Click"} "${cmd.text}"`;
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
      return cmd.preview ? "Highlighted" : "Clicking";
    case "chrome_open_url":
      return "Opening";
    default:
      return "Done";
  }
}
