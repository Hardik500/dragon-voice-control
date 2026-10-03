/**
 * Shared automation contract implemented once per OS (`macos.ts`, `windows.ts`) and selected
 * by `src/automation/index.ts` via `process.platform`. The pipeline and decision layers only
 * ever import `automation` from `./index`, never a platform file directly, and only ever pass
 * semantic identifiers (key names, settings-pane names, location names, app aliases) that are
 * validated against the platform-neutral name lists in `commands/registry-common.ts`.
 */
export interface PlatformAutomation {
  openApp(appName: string): Promise<void>;
  activateApp(appName: string): Promise<void>;
  hideApp(appName: string): Promise<void>;
  quitApp(appName: string): Promise<void>;
  switchToPreviousApp(): Promise<void>;

  typeText(text: string): Promise<void>;
  pressNamedKey(keyName: string): Promise<void>;
  /** Presses plain Backspace `count` times in one call (used for precise dictation-buffer
   * editing — deleting an exact number of characters rather than a fuzzy word-jump). */
  deleteBackward(count: number): Promise<void>;

  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowFullscreen(): Promise<void>;
  windowClose(): Promise<void>;

  volumeUp(): Promise<void>;
  volumeDown(): Promise<void>;
  volumeSet(percent: number): Promise<void>;
  volumeMute(): Promise<void>;
  volumeUnmute(): Promise<void>;

  mediaPlayPause(): Promise<void>;
  mediaNext(): Promise<void>;
  mediaPrevious(): Promise<void>;

  openSettingsPane(pane: string): Promise<void>;
  /** Opens a standard file-manager location (Finder on macOS, File Explorer on Windows). */
  openFinderLocation(location: string): Promise<void>;

  openUrlInChrome(url: string): Promise<void>;
  getActiveAppName(): Promise<string | null>;

  /** Screenshots the frontmost/focused app's window only (never the whole screen, never other
   * windows) for vision-based UI targeting. Throws if no window/permission is available. */
  captureFrontmostWindow(): Promise<{
    /** Base64 JPEG. */
    imageBase64: string;
    bounds: { x: number; y: number; width: number; height: number };
    /** Pixel dimensions of the image actually sent to the vision model — may differ from
     * `bounds` (points on macOS Retina displays, and/or downscaled for cost/latency), so
     * callers must scale a returned point by `bounds.width / imageWidth` (and height) rather
     * than assuming a 1:1 ratio. */
    imageWidth: number;
    imageHeight: number;
  }>;
  /** Moves the mouse to absolute screen coordinates and performs one left click. */
  clickAt(x: number, y: number, clicks?: number): Promise<void>;
  /** screen_click's "accessibility" method: labelled elements in the frontmost window whose
   * label contains any of `terms` (lowercase). Absolute screen coordinates, same space as
   * `clickAt()`. Labels only — never editable text content. */
  findAccessibleElements(terms: string[]): Promise<{
    window: { x: number; y: number; width: number; height: number };
    /** `menu`: macOS app menu-bar item (outside the window rect). */
    elements: Array<{ label: string; x: number; y: number; width: number; height: number; menu?: boolean }>;
  }>;

  /** Speaks a short acknowledgement; must interrupt (kill) any reply already speaking. */
  say(text: string): void;
  /** Barge-in support: stop any in-progress spoken reply immediately. */
  stopSpeaking(): void;
}
