/**
 * Localhost WebSocket protocol between the desktop app (server) and the
 * unpacked Chrome extension (client). Mirrored (duplicated, since the
 * extension runs outside this TypeScript project) in
 * chrome-extension/background.js and chrome-extension/content.js.
 */

export interface WireElement {
  id: string;
  tag: string;
  role: string;
  text: string;
}

export type ServerToExtensionMessage =
  | { type: "get_snapshot"; requestId: string }
  | { type: "action"; requestId: string; action: BrowserAction };

export type ExtensionToServerMessage =
  | { type: "hello" }
  | {
      type: "snapshot";
      requestId: string | null;
      connected: true;
      url: string;
      title: string;
      focusedElementId: string | null;
      elements: WireElement[];
    }
  | { type: "action_result"; requestId: string; ok: boolean; error?: string };

export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "search"; query: string }
  | { kind: "click"; elementId: string }
  | { kind: "type"; elementId: string; text: string }
  | { kind: "select"; elementId: string; text?: string }
  | { kind: "scroll"; direction: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "new_tab" }
  | { kind: "close_tab" }
  | { kind: "switch_tab"; direction: string };
