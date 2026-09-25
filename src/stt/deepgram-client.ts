import { WebSocket } from "ws";
import { logger } from "../logging/logger";
import { TranscriptEvent } from "../types/pipeline";

const SAMPLE_RATE = 16000;
const STT_MODEL = "flux-general-en";
const EAGER_EOT_THRESHOLD = "0.5";
const FINAL_EOT_THRESHOLD = "0.7";
const EOT_TIMEOUT_MS = "8000";
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
  private turnIndexToUtterance = new Map<number, string>();
  private turnStartedAt = new Map<number, number>();
  private opened = false;

  constructor(
    private apiKey: string,
    private onTurn: TurnHandler,
    private onError: (err: Error) => void,
    private onClose: CloseHandler,
    private newUtteranceId: () => string
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: STT_MODEL,
        encoding: "linear16",
        sample_rate: String(SAMPLE_RATE),
        eager_eot_threshold: EAGER_EOT_THRESHOLD,
        eot_threshold: FINAL_EOT_THRESHOLD,
        eot_timeout_ms: EOT_TIMEOUT_MS,
      });
      for (const keyterm of STT_KEYTERMS) params.append("keyterm", keyterm);
      const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;
      this.ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });

      this.ws.on("open", () => {
        this.opened = true;
        logger.event("stt.connected", {
          model: STT_MODEL,
          eagerEotThreshold: EAGER_EOT_THRESHOLD,
          finalEotThreshold: FINAL_EOT_THRESHOLD,
          eotTimeoutMs: EOT_TIMEOUT_MS,
          keytermCount: STT_KEYTERMS.length,
        });
        resolve();
      });

      this.ws.on("message", (raw) => {
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
          // Deepgram can report a protocol/keepalive error without immediately closing the
          // socket. Close it here so the pipeline's close handler schedules a reconnect
          // instead of leaving a dead connection in the listening state.
          this.ws?.close();
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

      this.ws.on("error", (err) => {
        logger.error("stt.socket_error", err);
        if (!this.opened) reject(err);
        this.onError(err instanceof Error ? err : new Error(String(err)));
      });

      this.ws.on("close", (code, reason) => {
        logger.event("stt.closed", { code, reason: reason?.toString(), hadOpened: this.opened });
        this.onClose(this.opened);
      });
    });
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }
    this.ws?.close();
    this.ws = null;
  }
}
