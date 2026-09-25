import { BrowserWindow, screen } from "electron";
import * as path from "path";

const RENDERER_DIR = path.join(__dirname, "..", "..", "src", "renderer");
const PRELOAD_DIR = path.join(__dirname, "..", "preload");

/** Topmost band for the overlay window.
 *
 * On Windows a topmost (HWND_TOPMOST) window already sits above every normal window, but the
 * default "normal" level still loses to other always-on-top windows; "screen-saver" is the
 * highest band. On macOS these levels map onto NSWindow levels, where "screen-saver" would float
 * the bar above the menu bar and Dock, so it gets the milder "floating" instead — on macOS the
 * overlay only needs to beat ordinary app windows. */
const OVERLAY_TOP_LEVEL: "screen-saver" | "floating" = process.platform === "win32" ? "screen-saver" : "floating";

/** Show the overlay and re-assert that it is genuinely topmost.
 *
 * The overlay is constructed with `show: false` and only revealed later via `showInactive()`.
 * On Windows the WS_EX_TOPMOST flag is applied when the window is shown, and relying on the
 * constructor's `alwaysOnTop: true` alone left the floating bar sitting behind other apps once
 * they were activated (reported 2026-09-25). Re-asserting after every show is the documented
 * workaround, and routing all reveals through here keeps that guarantee in one place. */
export function showOverlay(win: BrowserWindow): void {
  win.showInactive();
  win.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL);
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    title: "Dragon Settings",
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD_DIR, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(RENDERER_DIR, "settings.html"));
  win.on("close", (e) => {
    e.preventDefault();
    win.hide();
  });
  return win;
}

export function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const width = 360;
  const height = 220;
  const win = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 24,
    y: display.workArea.y + 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(PRELOAD_DIR, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Purely informational: never take focus (which would corrupt
  // getActiveAppName()'s frontmost-app read) and let clicks pass through.
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Belt and braces for the same reason as showOverlay(): cover any show path that doesn't go
  // through it. The overlay is transparent and click-through, so owning the topmost band costs
  // nothing in interaction terms.
  win.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL);
  win.on("show", () => win.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL));
  win.loadFile(path.join(RENDERER_DIR, "overlay.html"));
  return win;
}

/** Hidden window used only to run getUserMedia + PCM downsampling; never shown. */
export function createMicWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 200,
    height: 100,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD_DIR, "mic-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(RENDERER_DIR, "mic-capture.html"));
  return win;
}
