import { WebSocket } from "ws";
import { logger } from "../logging/logger";
import { TranscriptEvent } from "../types/pipeline";

const SAMPLE_RATE = 16000;
const CONNECT_TIMEOUT_MS = 15_000;
const STT_MODEL = "flux-general-en";
/** Flux end-of-turn confidence for the *eager* (preemptive) end-of-turn event. Lowered from our
 * previous 0.5 to 0.35 because this is the largest single term in the latency budget: `sttTurnMs`
 * measured ~850ms median, which is mostly the silence wait after the user stops speaking. Deepgram
 * documents 0.3-0.9 as the usable range. Executing from an interim turn is already gated on intent
 * confidence and sentence completeness in the pipeline, so a lower threshold mostly means the
 * transcript is *available* earlier rather than that a truncated command runs. Raise this back
 * toward 0.5 if interim misfires appear; it is a pure tuning value. */
const EAGER_EOT_THRESHOLD = "0.35";
const FINAL_EOT_THRESHOLD = "0.7";
const EOT_TIMEOUT_MS = "8000";
/** Deepgram Numerals. On by default because a spoken number that stays a word is wrong for every
 * downstream consumer (dictation, numeric entry, URLs) — see the `numerals` param below. */
const NUMERALS = "true";
const STT_KEYTERMS = [
  "Antigravity",
  "Cursor",
  "Docker Desktop",
  "Warp",
  "Slack",
  "Discord",
  "Notion",
  "Figma",
  "YouTube Music",
  "Google Chrome",
  "Visual Studio Code",
  "File Explorer",
  "play",
  "pause",
  "dictation",
  "start typing",
  "stop typing",
  "insert mode",
  "exit insert mode",
  "stop insert mode",
  "workflow mode",
  // Core command verbs. These were being garbled at the start of a turn — the logs show
  // "many"→minimize, "match"/"maxim"→maximize, "glue"→close, "believe"/"delivery"→delete,
  // "price"→press — and none of them were boosted. Kept to the verbs that actually start a
  // device-control command; deliberately no broad nouns, which would alter dictated text.
  "open",
  "close",
  "minimize",
  "maximize",
  "scroll",
  "click",
  "select",
  "choose",
  "toggle",
  "cancel",
  "type",
  "search",
  "press",
  "delete",
  "volume",
  "mute",
];

export type TurnHandler = (turn: TranscriptEvent) => void;
/** `hadOpened` distinguishes "was connected and then dropped" (worth auto-reconnecting)
 * from "never connected in the first place" (e.g. a bad API key — retrying won't help). */
export type CloseHandler = (hadOpened: boolean) => void;

/**
 * Thin wrapper around Deepgram Flux's /v2/listen streaming endpoint.
 * Never logs raw audio; only turn metadata and timing.
 */
export class DeepgramFluxConnection {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private rejectPendingConnect: ((error: Error) => void) | null = null;
  private turnIndexToUtterance = new Map<number, string>();
  private turnStartedAt = new Map<number, number>();

  constructor(
    private apiKey: string,
    private onTurn: TurnHandler,
    private onError: (err: Error) => void,
    private onClose: CloseHandler,
    private newUtteranceId: () => string
  ) {}

  connect(): Promise<void> {
    if (this.ws && this.connectPromise) return this.connectPromise;
    this.turnIndexToUtterance.clear();
    this.turnStartedAt.clear();
    this.connectPromise = new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: STT_MODEL,
        encoding: "linear16",
        sample_rate: String(SAMPLE_RATE),
        eager_eot_threshold: EAGER_EOT_THRESHOLD,
        eot_threshold: FINAL_EOT_THRESHOLD,
        eot_timeout_ms: EOT_TIMEOUT_MS,
        // Numerals belongs in the connection query; Configure is unsupported by Flux.
        numerals: NUMERALS,
      });
      for (const keyterm of STT_KEYTERMS) params.append("keyterm", keyterm);
      const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;
      const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });
      this.ws = ws;
      const isCurrent = () => this.ws === ws;
      let opened = false;
      let settled = false;
      let connectTimer: NodeJS.Timeout | null = null;
      const finishConnect = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        if (this.rejectPendingConnect === rejectConnect) this.rejectPendingConnect = null;
        if (error) reject(error);
        else resolve();
      };
      const rejectConnect = (error: Error) => finishConnect(error);
      this.rejectPendingConnect = rejectConnect;
      connectTimer = setTimeout(() => {
        if (!isCurrent() || opened) return;
        const error = new Error("Deepgram connection timed out after 15 seconds");
        finishConnect(error);
        this.onError(error);
        ws.terminate();
      }, CONNECT_TIMEOUT_MS);
      connectTimer.unref();

      ws.on("open", () => {
        if (!isCurrent()) {
          finishConnect(new Error("Deepgram connection was superseded"));
          ws.close();
          return;
        }
        opened = true;
        logger.event("stt.connected", {
          model: STT_MODEL,
          eagerEotThreshold: EAGER_EOT_THRESHOLD,
          finalEotThreshold: FINAL_EOT_THRESHOLD,
          eotTimeoutMs: EOT_TIMEOUT_MS,
          numerals: NUMERALS,
          keytermCount: STT_KEYTERMS.length,
        });
        finishConnect();
      });

      ws.on("message", (raw) => {
        if (!isCurrent()) return;
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "Connected") {
          logger.event("stt.session_connected", { requestId: msg.request_id });
          return;
        }
        if (msg.type === "Error") {
          logger.event("stt.fatal_error", { code: msg.code, description: msg.description });
          this.onError(new Error(`Deepgram error ${msg.code}: ${msg.description}`));
          // Closing the exact socket lets the pipeline retry protocol failures too.
          ws.close();
          return;
        }
        if (msg.type === "TurnInfo") {
          const receivedAt = Date.now();
          if (msg.event === "StartOfTurn" || !this.turnIndexToUtterance.has(msg.turn_index)) {
            this.turnIndexToUtterance.set(msg.turn_index, this.newUtteranceId());
            this.turnStartedAt.set(msg.turn_index, receivedAt);
          }
          const utteranceId = this.turnIndexToUtterance.get(msg.turn_index)!;
          const turnStartedAt = this.turnStartedAt.get(msg.turn_index) ?? receivedAt;
          const isFinal = msg.event === "EndOfTurn";
          const turn: TranscriptEvent = {
            utteranceId,
            turnIndex: msg.turn_index,
            event: msg.event,
            transcript: msg.transcript ?? "",
            isFinal,
            endOfTurnConfidence: msg.end_of_turn_confidence ?? 0,
            turnStartedAt,
            receivedAt,
          };
          logger.event(
            "stt.turn",
            {
              utteranceId,
              turnIndex: msg.turn_index,
              event: msg.event,
              transcript: turn.transcript,
              endOfTurnConfidence: turn.endOfTurnConfidence,
              sttTurnMs: receivedAt - turnStartedAt,
            },
            { verboseOnly: msg.event === "Update" }
          );
          this.onTurn(turn);
          if (isFinal) {
            this.turnIndexToUtterance.delete(msg.turn_index);
            this.turnStartedAt.delete(msg.turn_index);
          }
        }
      });

      ws.on("error", (err) => {
        if (!isCurrent()) return;
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("stt.socket_error", error);
        if (!opened) finishConnect(error);
        this.onError(error);
      });

      ws.on("close", (code, reason) => {
        if (!opened) finishConnect(new Error("Deepgram connection closed before opening"));
        if (!isCurrent()) return;
        this.ws = null;
        this.turnIndexToUtterance.clear();
        this.turnStartedAt.clear();
        logger.event("stt.closed", { code, reason: reason?.toString(), hadOpened: opened });
        this.onClose(opened);
      });
    });
    return this.connectPromise;
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  forceEndTurn(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ForceEndTurn" }));
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.turnIndexToUtterance.clear();
    this.turnStartedAt.clear();
    this.rejectPendingConnect?.(new Error("Deepgram connection cancelled"));
    this.rejectPendingConnect = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }
    // close() while CONNECTING leaves a pending upgrade in some WebSocket implementations.
    // terminate() also releases the handshake after an intentional stop.
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close();
  }
}
