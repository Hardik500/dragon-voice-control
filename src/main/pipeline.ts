import { randomUUID } from "crypto";
import { DeepgramFluxConnection } from "../stt/deepgram-client";
import { BrowserBridge } from "../browser/server";
import { logger } from "../logging/logger";
import * as macos from "../automation/macos";
import { extractPayload } from "../decision/extract";
import { buildQuestions, buildState, buildTargetCandidates } from "../decision/questions";
import { callJev, JevCancelledError, JevRequestError } from "../decision/jev-client";
import { INTERIM_ELIGIBLE_INTENTS, resolveCommand, summarizeAnswers } from "../decision/resolve";
import { BrowserAction } from "../types/browser-protocol";
import { HistoryEntry, OverlayUpdate, ResolvedCommand, TranscriptEvent } from "../types/pipeline";
import { DragonSettings } from "../types/settings";
import { HistoryStore } from "./history-store";

const MAX_IN_FLIGHT_JEV = 2;
const ADDRESSED_THRESHOLD = 0.55;
const INTENT_CONFIDENCE_THRESHOLD = 0.35;
const COMPLETE_THRESHOLD = 0.5;
const INTERIM_EXEC_INTENT_CONFIDENCE = 0.6;
const INTERIM_EXEC_COMPLETE = 0.6;

interface InFlight {
  utteranceId: string;
  controller: AbortController;
  startedAt: number;
}

export class DragonPipeline {
  private deepgram: DeepgramFluxConnection | null = null;
  private inFlight: InFlight[] = [];
  private executedUtterances = new Set<string>();
  private ignoredLoggedUtterances = new Set<string>();
  private utteranceCounter = 0;
  private micStreaming = false;
  private history = new HistoryStore();

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
    this.deepgram = new DeepgramFluxConnection(
      settings.deepgramApiKey,
      (turn) => this.onTurn(turn),
      (err) => {
        logger.error("pipeline.stt_error", err);
        this.onOverlay(this.baseOverlay("error", err.message));
      },
      () => {
        this.micStreaming = false;
      },
      () => this.newUtteranceId()
    );
    try {
      await this.deepgram.connect();
      this.micStreaming = true;
      this.onOverlay(this.baseOverlay("listening", ""));
    } catch (err) {
      logger.error("pipeline.stt_connect_failed", err);
      this.onOverlay(this.baseOverlay("error", err instanceof Error ? err.message : String(err)));
    }
  }

  stopStreaming(): void {
    this.deepgram?.close();
    this.deepgram = null;
    this.micStreaming = false;
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
    macos.stopSpeaking();
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
      status: status || null,
      latencyMs: null,
      activationMode: this.getSettings().activationMode,
    };
  }

  private stripWakeWord(transcript: string, wakePhrase: string): string | null {
    const idx = transcript.toLowerCase().indexOf(wakePhrase.toLowerCase());
    if (idx === -1) return null;
    return transcript.slice(idx + wakePhrase.length).trim();
  }

  private async onTurn(turn: TranscriptEvent): Promise<void> {
    const settings = this.getSettings();
    macos.stopSpeaking(); // barge-in: new speech interrupts any spoken reply.

    if (turn.event === "TurnResumed") {
      // The previous eager transcript for this turn is stale; drop any in-flight decision for it.
      this.abortUtterance(turn.utteranceId);
      return;
    }
    if (turn.event === "StartOfTurn" || turn.event === "Update") {
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
      return; // Only EagerEndOfTurn/EndOfTurn trigger decisions (debounces interim noise).
    }

    let effectiveText = turn.transcript;
    if (settings.activationMode === "wake_word") {
      const stripped = this.stripWakeWord(turn.transcript, settings.wakePhrase);
      if (stripped == null || stripped.length === 0) {
        return; // Wake phrase not present (yet); ignore this turn.
      }
      effectiveText = stripped;
    }
    if (effectiveText.trim().length === 0) return;

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

  private registerInFlight(utteranceId: string): AbortController {
    // Reliability control (not a guardrail): cap concurrent Jev requests and
    // cancel the oldest once the cap is exceeded, per PROGRESS.md policy.
    while (this.inFlight.length >= MAX_IN_FLIGHT_JEV) {
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
    const startedAt = Date.now();
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

    try {
      const activeApp = await macos.getActiveAppName();
      const isChromeActive = activeApp === "Google Chrome";
      const browserPage = isChromeActive ? await this.browserBridge.requestSnapshot() : null;
      const payload = extractPayload(effectiveText, browserPage);
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
        effectiveText,
        appCandidates: payload.appCandidates.map((c) => c.appName),
        elementCandidates: payload.browserElementCandidates.length,
      });

      const result = await callJev(settings.openRouterApiKey, state, questions, controller.signal);
      this.unregisterInFlight(controller);

      const summary = summarizeAnswers(result.answers);
      const decisionMs = Date.now() - startedAt;

      if (settings.activationMode === "always_listening") {
        if (summary.addressed == null || summary.addressed < ADDRESSED_THRESHOLD) {
          this.logIgnored(turn, "not_addressed", summary.intent);
          return;
        }
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

      if (summary.intent === "none" || summary.intentConfidence < INTENT_CONFIDENCE_THRESHOLD || summary.complete < COMPLETE_THRESHOLD) {
        this.logIgnored(turn, "low_confidence_or_incomplete", summary.intent);
        return;
      }

      if (this.executedUtterances.has(turn.utteranceId)) {
        logger.event("pipeline.duplicate_suppressed", { utteranceId: turn.utteranceId });
        return;
      }
      this.executedUtterances.add(turn.utteranceId);

      const resolved = resolveCommand(summary, payload);
      if (!resolved) {
        this.logIgnored(turn, "resolution_failed", summary.intent);
        return;
      }

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
      let execError: string | null = null;
      try {
        await this.executeCommand(resolved, isChromeActive);
      } catch (err) {
        execError = err instanceof Error ? err.message : String(err);
      }
      const executionMs = Date.now() - execStarted;

      logger.event("pipeline.execution", {
        utteranceId: turn.utteranceId,
        intent: resolved.kind,
        decisionMs,
        executionMs,
        error: execError,
      });

      this.onOverlay({
        utteranceId: turn.utteranceId,
        state: execError ? "error" : "done",
        transcript: effectiveText,
        isFinal: true,
        action: describeCommand(resolved),
        status: execError,
        latencyMs: decisionMs + executionMs,
        activationMode: settings.activationMode,
      });

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
        macos.say(shortReplyFor(resolved));
      } else if (settings.voiceReplyEnabled && execError) {
        macos.say("Sorry, that did not work.");
      }
    } catch (err) {
      this.unregisterInFlight(controller);
      if (err instanceof JevCancelledError) {
        logger.event("pipeline.decision_cancelled", { utteranceId: turn.utteranceId });
        return;
      }
      const message = err instanceof JevRequestError ? err.message : err instanceof Error ? err.message : String(err);
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

  private logIgnored(turn: TranscriptEvent, reason: string, intent: string) {
    if (this.ignoredLoggedUtterances.has(turn.utteranceId) && !turn.isFinal) return;
    if (turn.isFinal) this.ignoredLoggedUtterances.add(turn.utteranceId);
    logger.event("pipeline.ignored", { utteranceId: turn.utteranceId, reason, intent });
    this.onOverlay({
      utteranceId: turn.utteranceId,
      state: "idle",
      transcript: turn.transcript,
      isFinal: turn.isFinal,
      action: null,
      status: reason === "not_addressed" ? null : "No command recognized",
      latencyMs: null,
      activationMode: this.getSettings().activationMode,
    });
  }

  private async executeCommand(cmd: ResolvedCommand, isChromeActive: boolean): Promise<void> {
    switch (cmd.kind) {
      case "open_app":
        return macos.openApp(cmd.appName!);
      case "activate_app":
        return macos.activateApp(cmd.appName!);
      case "hide_app":
        return macos.hideApp(cmd.appName!);
      case "quit_app":
        return macos.quitApp(cmd.appName!);
      case "switch_previous_app":
        return macos.switchToPreviousApp();
      case "type_text":
        return macos.typeText(cmd.text!);
      case "press_key":
      case "shortcut":
        return macos.pressNamedKey(cmd.keyName!);
      case "window_minimize":
        return macos.windowMinimize();
      case "window_maximize":
        return macos.windowMaximize();
      case "window_fullscreen":
        return macos.windowFullscreen();
      case "window_close":
        return macos.windowClose();
      case "volume_up":
        return macos.volumeUp();
      case "volume_down":
        return macos.volumeDown();
      case "volume_set":
        return macos.volumeSet(cmd.amount!);
      case "volume_mute":
        return macos.volumeMute();
      case "volume_unmute":
        return macos.volumeUnmute();
      case "media_play_pause":
        return macos.mediaPlayPause();
      case "media_next":
        return macos.mediaNext();
      case "media_previous":
        return macos.mediaPrevious();
      case "open_settings_pane":
        return macos.openSettingsPane(cmd.pane!);
      case "open_finder_location":
        return macos.openFinderLocation(cmd.location!);
      case "chrome_open_url":
        return macos.openUrlInChrome(cmd.url!);
      case "chrome_search":
        return macos.openUrlInChrome(`https://www.google.com/search?q=${encodeURIComponent(cmd.query!)}`);
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
      default:
        throw new Error(`Unhandled command kind: ${cmd.kind}`);
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
    case "chrome_open_url":
      return "Opening";
    default:
      return "Done";
  }
}
