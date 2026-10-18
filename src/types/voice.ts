export type SpeechConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface SpeechConnectionStatus {
  state: SpeechConnectionState;
  message: string | null;
  reconnectAttempt: number;
}

export type MicrophoneState = "stopped" | "starting" | "capturing" | "error";

export interface MicrophoneStatus {
  state: MicrophoneState;
  message: string | null;
}
