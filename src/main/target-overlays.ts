import { BrowserWindow, screen } from "electron";
import * as path from "path";
import { ScreenTargetOverlay } from "../types/pipeline";
import { showOverlay } from "./windows";

/** Small, temporary windows around the actual targets. A full-screen transparent layer can
 * interfere with window capture/sharing; these markers never own focus or intercept clicks. */
export class TargetOverlays {
  private windows: BrowserWindow[] = [];
  private current: ScreenTargetOverlay | null = null;
  private timer: NodeJS.Timeout | null = null;

  update(hints: ScreenTargetOverlay | null): void {
    if (hints === this.current) return;
    this.clear();
    if (!hints || hints.expiresAt <= Date.now()) return;
    this.current = hints;
    for (const target of hints.targets.slice(0, 5)) {
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) continue;
      // User32/UIA coordinates are physical pixels. BrowserWindow bounds use DIP.
      const physicalPoint = { x: Math.round(target.x), y: Math.round(target.y) };
      const point = process.platform === "win32" ? screen.screenToDipPoint(physicalPoint) : physicalPoint;
      const display = screen.getDisplayNearestPoint(point);
      const size = 80;
      const x = Math.max(display.bounds.x, Math.min(point.x - size / 2, display.bounds.x + display.bounds.width - size));
      const y = Math.max(display.bounds.y, Math.min(point.y - size / 2, display.bounds.y + display.bounds.height - size));
      const win = new BrowserWindow({
        width: size, height: size, x: Math.round(x), y: Math.round(y),
        frame: false, transparent: true, resizable: false, movable: false,
        alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, focusable: false,
        webPreferences: {
          preload: path.join(__dirname, "..", "preload", "target-preload.js"),
          contextIsolation: true, nodeIntegration: false,
        },
      });
      this.windows.push(win);
      win.setIgnoreMouseEvents(true);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.webContents.once("did-finish-load", () => {
        if (win.isDestroyed() || this.current !== hints || hints.expiresAt <= Date.now()) return;
        win.webContents.send("target:update", {
          x: point.x - Math.round(x), y: point.y - Math.round(y),
          number: target.number, label: target.label,
        });
        showOverlay(win);
      });
      void win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "target.html"));
    }
    this.timer = setTimeout(() => this.clear(), Math.max(0, hints.expiresAt - Date.now()));
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy();
    this.windows = [];
  }
}
