import { Menu, MenuItemConstructorOptions, Tray, nativeImage, shell } from "electron";
import * as path from "path";
import { ActivationMode, DragonSettings } from "../types/settings";

export interface TrayCallbacks {
  getSettings: () => DragonSettings;
  isListening: () => boolean;
  toggleListening: () => void;
  setActivationMode: (mode: ActivationMode) => void;
  toggleOverlay: () => void;
  openSettings: () => void;
  openLogsFolder: () => void;
  clearHistory: () => void;
  quit: () => void;
}

export function createTray(cb: TrayCallbacks): Tray {
  const iconPath = path.join(__dirname, "..", "..", "assets", "tray-icon.png");
  const image = nativeImage.createFromPath(iconPath);
  image.setTemplateImage(true);
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
        click: () => {
          cb.toggleListening();
          rebuild();
        },
      },
      { type: "separator" },
      { label: "Activation Mode", enabled: false },
      modeItem("push_to_talk", "Push to Talk"),
      modeItem("wake_word", `Wake Word ("${settings.wakePhrase}")`),
      modeItem("always_listening", "Always Listening"),
      { type: "separator" },
      {
        label: "Show Overlay",
        type: "checkbox",
        checked: settings.overlayVisible,
        click: () => cb.toggleOverlay(),
      },
      { label: "Open Settings…", click: () => cb.openSettings() },
      { label: "Open Logs Folder", click: () => cb.openLogsFolder() },
      { label: "Clear History", click: () => cb.clearHistory() },
      { type: "separator" },
      { label: "Quit Dragon", click: () => cb.quit() },
    ]);
    tray.setContextMenu(menu);
  };

  rebuild();
  return tray;
}
