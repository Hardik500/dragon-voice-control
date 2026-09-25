import { Menu, MenuItemConstructorOptions, Tray, nativeImage, shell } from "electron";
import * as path from "path";
import { ActivationMode, DragonSettings } from "../types/settings";

export interface TrayCallbacks {
  getSettings: () => DragonSettings;
  isListening: () => boolean;
  isInsertModeActive: () => boolean;
  isWorkflowModeActive: () => boolean;
  toggleListening: () => void;
  toggleInsertMode: () => void;
  toggleWorkflowMode: () => void;
  setActivationMode: (mode: ActivationMode) => void;
  toggleOverlay: () => void;
  openSettings: () => void;
  openDashboard: () => void;
  openLogsFolder: () => void;
  clearHistory: () => void;
  quit: () => void;
}

export interface TrayHandle {
  tray: Tray;
  /** Rebuilds the menu template from current state. `Menu.buildFromTemplate` bakes in
   * label/checked values at build time — Electron does not re-evaluate them on open — so
   * this must be called whenever listening/mode/overlay state changes from *any* source
   * (tray clicks, the push-to-talk/emergency-stop hotkeys, or the Settings window). */
  refresh: () => void;
}

export function createTray(cb: TrayCallbacks): TrayHandle {
  // macOS auto-tints a monochrome "template" tray icon for light/dark menu bars; Windows has
  // no equivalent, so it gets its own colored icon instead of appearing as a plain black blob.
  const iconFile = process.platform === "win32" ? "tray-icon-win.png" : "tray-icon.png";
  const iconPath = path.join(__dirname, "..", "..", "assets", iconFile);
  const image = nativeImage.createFromPath(iconPath);
  if (process.platform !== "win32") image.setTemplateImage(true);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Dragon voice control");

  const rebuild = () => {
    const settings = cb.getSettings();
    const modeItem = (mode: ActivationMode, label: string): MenuItemConstructorOptions => ({
      label,
      type: "radio",
      checked: settings.activationMode === mode,
      click: () => cb.setActivationMode(mode),
    });

    const menu = Menu.buildFromTemplate([
      {
        label: cb.isListening() ? "Listening: On" : "Listening: Off",
        type: "checkbox",
        checked: cb.isListening(),
        click: () => cb.toggleListening(),
      },
      {
        label: cb.isInsertModeActive() ? "Insert Mode: On" : "Insert Mode: Off",
        type: "checkbox",
        checked: cb.isInsertModeActive(),
        click: () => cb.toggleInsertMode(),
      },
      {
        label: cb.isWorkflowModeActive() ? "Workflow Mode: On" : "Workflow Mode: Off",
        type: "checkbox",
        checked: cb.isWorkflowModeActive(),
        click: () => cb.toggleWorkflowMode(),
      },
      { type: "separator" },
      { label: "Activation Mode", enabled: false },
      modeItem("push_to_talk", "Push to Talk"),
      modeItem("always_listening", "Always Listening"),
      { type: "separator" },
      {
        label: "Show Overlay",
        type: "checkbox",
        checked: settings.overlayVisible,
        click: () => cb.toggleOverlay(),
      },
      { label: "Open Settings…", click: () => cb.openSettings() },
      { label: "Open Jev Dashboard", click: () => cb.openDashboard() },
      { label: "Open Logs Folder", click: () => cb.openLogsFolder() },
      { label: "Clear History", click: () => cb.clearHistory() },
      { type: "separator" },
      { label: "Quit Dragon", click: () => cb.quit() },
    ]);
    tray.setContextMenu(menu);
  };

  rebuild();
  return { tray, refresh: rebuild };
}
