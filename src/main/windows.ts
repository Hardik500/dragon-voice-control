import { BrowserWindow, screen } from "electron";
import * as path from "path";

const RENDERER_DIR = path.join(__dirname, "..", "..", "src", "renderer");
const PRELOAD_DIR = path.join(__dirname, "..", "preload");

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
    webPreferences: {
      preload: path.join(PRELOAD_DIR, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
