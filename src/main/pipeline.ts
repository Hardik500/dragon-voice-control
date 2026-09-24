import { DeepgramFluxConnection } from "../stt/deepgram-client";
import { BrowserBridge } from "../browser/server";
import { logger } from "../logging/logger";
import { automation } from "../automation";
import { extractDeleteScope, extractPayload, extractReplacePair } from "../decision/extract";
import { buildQuestions, buildState, buildTargetCandidates } from "../decision/questions";
import { callJev, JevCancelledError, JevRequestError } from "../decision/jev-client";
import { INTERIM_ELIGIBLE_INTENTS, resolveCommand, summarizeAnswers } from "../decision/resolve";
import { BrowserAction } from "../types/browser-protocol";
import { HistoryEntry, JevAnswerSummary, JevDecisionTrace, OverlayUpdate, ResolvedCommand, TranscriptEvent } from "../types/pipeline";
import { DragonSettings } from "../types/settings";
import { HistoryStore } from "./history-store";

const MAX_IN_FLIGHT_JEV = 2;
const ADDRESSED_THRESHOLD = 0.55;
const INTENT_CONFIDENCE_THRESHOLD = 0.35;
const COMPLETE_THRESHOLD = 0.5;
const INTERIM_EXEC_INTENT_CONFIDENCE = 0.6;
const INTERIM_EXEC_COMPLETE = 0.6;
const DEFAULT_DELETE_WORD_COUNT = 3;

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
  | { type: "stop" }
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
  receivedAt: Date.now(),
};

function deleteScopeToControl(scope: ReturnType<typeof extractDeleteScope>): DictationControl | null {
  if (!scope) return null;
  if (scope.scope === "all") return { type: "delete_all" };
  if (scope.scope === "words") return { type: "delete_words", count: scope.count ?? DEFAULT_DELETE_WORD_COUNT };
  return { type: "delete_last_chunk" };
}

export class DragonPipeline {
  private deepgram: DeepgramFluxConnection | null = null;
  private inFlight: InFlight[] = [];
  private executedUtterances = new Set<string>();
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
  /** Everything typed in the current dictation session, kept in sync with what's on screen
   * so "delete the last 3 words" / "replace X with Y" can compute exact backspace counts
   * instead of guessing. Cleared when dictation ends. */
  private dictationBuffer = "";
  /** The most recently appended chunk, for "delete that"/"undo that". */
  private lastDictationChunk = "";

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

  getJevDecisionTraces(): JevDecisionTrace[] {
    return this.jevDecisionTraces;
  }

  private recordJevDecision(trace: JevDecisionTrace) {
    this.jevDecisionTraces.unshift(trace);
    if (this.jevDecisionTraces.length > DragonPipeline.MAX_JEV_DECISION_TRACES) {
      this.jevDecisionTraces.length = DragonPipeline.MAX_JEV_DECISION_TRACES;
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

    if (/^(?:stop|end)\s+(?:dictation|typing|dictating)$/.test(lower) || lower === "that's it" || lower === "stop typing") {
      return { type: "stop" };
    }
    if (/^(?:new|next)\s+line$/.test(lower)) return { type: "newline" };
    const deleteScope = deleteScopeToControl(extractDeleteScope(trimmed));
    if (deleteScope) return deleteScope;
    if (/^replace\b/i.test(trimmed)) {
      const pair = extractReplacePair(trimmed);
      if (pair) return { type: "replace", find: pair[0], replacement: pair[1] };
    }
    return null;
  }

  private async runDictationControl(turn: TranscriptEvent, control: DictationControl, settings: DragonSettings): Promise<void> {
    const startedAt = Date.now();
    let actionLabel = "";
    let execError: string | null = null;
    try {
      switch (control.type) {
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
      intent: "delete_text",
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
        // Wake phrase not present (yet). Surface this in the overlay instead of going
        // silent, so it doesn't look like the app simply ignored what was said.
        this.onOverlay({
          utteranceId: turn.utteranceId,
          state: "idle",
          transcript: turn.transcript,
          isFinal: turn.isFinal,
          action: null,
          status: `Say "${settings.wakePhrase}" first to give a command`,
          latencyMs: null,
          activationMode: settings.activationMode,
        });
        return;
      }
      effectiveText = stripped;
    }
    if (effectiveText.trim().length === 0) return;

    // Fast path: deterministic dictation-editing commands skip Jev entirely for speed and
    // reliability. Only checked on a final turn, and only while actively dictating.
    if (this.dictationActive && turn.isFinal) {
      const control = this.matchDictationControl(effectiveText);
      if (control) {
        if (this.executedUtterances.has(turn.utteranceId)) return;
        this.executedUtterances.add(turn.utteranceId);
        await this.runDictationControl(turn, control, settings);
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
    const sttToDecisionMs = startedAt - turn.receivedAt;
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
      const activeApp = await automation.getActiveAppName();
      const isChromeActive = activeApp === "Google Chrome";
      // Fetch the page snapshot whenever the extension is connected, not only when our
      // own (sometimes-unreliable) frontmost-app detection says "Google Chrome" — the
      // user may be looking at Chrome while a different app briefly reports as frontmost,
      // and this call is a cheap local WebSocket round trip either way.
      const browserPage = this.browserBridge.isConnected() ? await this.browserBridge.requestSnapshot() : null;
      const payload = extractPayload(effectiveText, browserPage);
      const targetCandidates = buildTargetCandidates(payload);
      const questions = buildQuestions({
        includeAddressed: settings.activationMode === "always_listening",
        targetCandidates,
      });
      const state = buildState({ transcript: effectiveText, activeApp, browserPage });

      const cacheKey = `${turn.utteranceId}::${effectiveText}::${settings.activationMode}`;
      const cached = this.jevAnswerCache.get(cacheKey);
      let summary: JevAnswerSummary;
      let decisionMs: number;

      if (cached) {
        // Same utterance, same text, same mode as an already-answered request (typically
        // EagerEndOfTurn immediately followed by an EndOfTurn with no new words) — reuse the
        // answer instead of spending another Jev call on an identical question.
        this.unregisterInFlight(controller);
        logger.event("pipeline.decision_cache_hit", { utteranceId: turn.utteranceId, turnEvent: turn.event });
        summary = cached;
        decisionMs = Date.now() - startedAt;
      } else {
        logger.event("pipeline.decision_request", {
          utteranceId: turn.utteranceId,
          turnEvent: turn.event,
          activeApp,
          effectiveText,
          sttToDecisionMs,
          appCandidates: payload.appCandidates.map((c) => c.label),
          elementCandidates: payload.browserElementCandidates.length,
        });

        const result = await callJev(settings.openRouterApiKey, state, questions, controller.signal);
        this.unregisterInFlight(controller);

        this.recordJevDecision({
          timestamp: Date.now(),
          transcript: effectiveText,
          activeApp,
          activationMode: settings.activationMode,
          turnEvent: turn.event,
          model: result.model,
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
      if (
        settings.activationMode === "always_listening" &&
        !this.dictationActive &&
        !isExplicitMediaControl(turn, summary)
      ) {
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

      // "complete" is Jev's judgment of sentence completeness, not speech completeness —
      // on a final turn (EndOfTurn already told us the speaker is done), a short-but-final
      // utterance like "Open Slack?" can score low on "complete" while still being a fully
      // spoken, entirely executable command. Only enforce the completeness gate on turns
      // that *aren't* final yet, where it protects against acting on a truncated interim.
      const incomplete = !turn.isFinal && summary.complete < COMPLETE_THRESHOLD;
      const noCommand = summary.intent === "none" || summary.intentConfidence < INTENT_CONFIDENCE_THRESHOLD || incomplete;

      if (noCommand) {
        if (this.dictationActive && turn.isFinal && effectiveText.trim().length > 0) {
          // Jev didn't recognize a command; while actively dictating, treat this as more
          // dictated text so the user doesn't have to say "type" again for every sentence.
          await this.continueDictation(turn, effectiveText, settings, decisionMs, sttToDecisionMs);
          return;
        }
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
      const totalMs = sttToDecisionMs + decisionMs + executionMs;

      // Dictation session bookkeeping: typing/newline continue it; any other successfully
      // recognized command (the confidence/completeness gates above already passed) means
      // the user deliberately switched to something else, so end the session.
      if (!execError) {
        if (resolved.kind === "type_text") this.startOrContinueDictation(resolved.text!);
        else if (resolved.kind === "insert_newline") this.appendDictationRaw("\n");
        else if (resolved.kind !== "delete_text" && resolved.kind !== "replace_text") this.endDictation();
      }

      logger.event("pipeline.execution", {
        utteranceId: turn.utteranceId,
        intent: resolved.kind,
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
        action: describeCommand(resolved),
        status: execError,
        latencyMs: totalMs,
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
        automation.say(shortReplyFor(resolved));
      } else if (settings.voiceReplyEnabled && execError) {
        automation.say("Sorry, that did not work.");
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
    let execError: string | null = null;
    try {
      await automation.typeText(effectiveText);
      this.startOrContinueDictation(effectiveText);
    } catch (err) {
      execError = err instanceof Error ? err.message : String(err);
    }
    const executionMs = Date.now() - execStarted;
    const totalMs = sttToDecisionMs + decisionMs + executionMs;

    logger.event("pipeline.dictation_continue", {
      utteranceId: turn.utteranceId,
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
        return this.openUrlPreferringExistingTab(cmd.url!, isChromeActive);
      case "chrome_search":
        return this.openUrlPreferringExistingTab(
          cmd.url ?? `https://www.google.com/search?q=${encodeURIComponent(cmd.query!)}`,
          isChromeActive
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
  private async openUrlPreferringExistingTab(url: string, _isChromeActive: boolean): Promise<void> {
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
    case "chrome_open_url":
      return "Opening";
    default:
      return "Done";
  }
}
