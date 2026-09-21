import { WebSocket } from "ws";
import { logger } from "../logging/logger";
import { TranscriptEvent } from "../types/pipeline";

const SAMPLE_RATE = 16000;

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
      const url = `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=${SAMPLE_RATE}&eager_eot_threshold=0.5`;
      this.ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });

      this.ws.on("open", () => {
        this.opened = true;
        logger.event("stt.connected", {});
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
          return;
        }
        if (msg.type === "TurnInfo") {
          if (msg.event === "StartOfTurn" || !this.turnIndexToUtterance.has(msg.turn_index)) {
            this.turnIndexToUtterance.set(msg.turn_index, this.newUtteranceId());
          }
          const utteranceId = this.turnIndexToUtterance.get(msg.turn_index)!;
          const isFinal = msg.event === "EndOfTurn";
          const turn: TranscriptEvent = {
            utteranceId,
            turnIndex: msg.turn_index,
            event: msg.event,
            transcript: msg.transcript ?? "",
            isFinal,
            endOfTurnConfidence: msg.end_of_turn_confidence ?? 0,
            receivedAt: Date.now(),
          };
          logger.event(
            "stt.turn",
            {
              utteranceId,
              turnIndex: msg.turn_index,
              event: msg.event,
              transcript: turn.transcript,
              endOfTurnConfidence: turn.endOfTurnConfidence,
            },
            { verboseOnly: msg.event === "Update" }
          );
          this.onTurn(turn);
          if (isFinal) this.turnIndexToUtterance.delete(msg.turn_index);
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
