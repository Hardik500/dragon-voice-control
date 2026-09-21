import { app, session, shell, systemPreferences, BrowserWindow, Tray } from "electron";
import { logger } from "../logging/logger";
import { SettingsStore } from "./settings-store";
import { BrowserBridge } from "../browser/server";
import { DragonPipeline } from "./pipeline";
import { createMicWindow, createOverlayWindow, createSettingsWindow } from "./windows";
import { createTray } from "./tray";
import { registerIpc, broadcastStatus } from "./ipc";
import { registerShortcuts } from "./shortcuts";
import { ActivationMode } from "../types/settings";
import { OverlayUpdate } from "../types/pipeline";

app.setName("Dragon");

let settingsStore: SettingsStore;
let browserBridge: BrowserBridge;
let pipeline: DragonPipeline;
let settingsWindow: BrowserWindow;
let overlayWindow: BrowserWindow;
let micWindow: BrowserWindow;
let tray: Tray;
let listening = false;

function currentStatus() {
  const settings = settingsStore.get();
  return {
    listening,
    streaming: pipeline.isStreaming(),
    activationMode: settings.activationMode,
    browserConnected: browserBridge.isConnected(),
  };
}

function pushStatus() {
  broadcastStatus([settingsWindow], currentStatus());
}

function applyListeningState() {
  const settings = settingsStore.get();
  if (!listening) {
    pipeline.stopStreaming();
    pushStatus();
    return;
  }
  if (settings.activationMode === "push_to_talk") {
    // Push-to-talk starts/stops explicitly via the hotkey/tray toggle itself;
    // nothing to auto-start here.
  } else {
    pipeline.startStreaming();
  }
  pushStatus();
}

function toggleListening() {
  listening = !listening;
  logger.event("app.listening_toggled", { listening });
  applyListeningState();
}

function setActivationMode(mode: ActivationMode) {
  settingsStore.update({ activationMode: mode });
  logger.event("app.activation_mode_changed", { mode });
  // Switching modes stops any in-progress continuous/ptt session cleanly.
  pipeline.stopStreaming();
  // Wake word / always listening imply the user wants listening on now;
  // push-to-talk still requires the explicit hotkey/tray toggle.
  if (mode !== "push_to_talk") listening = true;
  applyListeningState();
}

function toggleOverlay() {
  const settings = settingsStore.get();
  const next = !settings.overlayVisible;
  settingsStore.update({ overlayVisible: next });
  if (next) overlayWindow.showInactive();
  else overlayWindow.hide();
}

async function requestMicPermission() {
  if (process.platform !== "darwin") return;
  try {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    logger.event("permissions.microphone_status", { status });
    if (status !== "granted") {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      logger.event("permissions.microphone_requested", { granted });
    }
  } catch (err) {
    logger.error("permissions.microphone_error", err);
  }
}

app.whenReady().then(async () => {
  logger.event("app.start", { platform: process.platform, arch: process.arch });
  app.dock?.hide();

  // The hidden mic-capture window needs getUserMedia; auto-approve only the
  // media permission for our own windows (there is no third-party content).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  settingsStore = new SettingsStore();
  logger.setVerbosity(settingsStore.get().logVerbosity);

  browserBridge = new BrowserBridge();
  browserBridge.start();

  overlayWindow = createOverlayWindow();
  settingsWindow = createSettingsWindow();
  micWindow = createMicWindow();

  pipeline = new DragonPipeline(
    () => settingsStore.get(),
    browserBridge,
    (update: OverlayUpdate) => {
      if (!overlayWindow.isDestroyed()) overlayWindow.webContents.send("overlay:update", update);
      pushStatus();
    }
  );

  registerIpc({
    settingsStore,
    pipeline,
    onSettingsChanged: (settings, partial) => {
      logger.setVerbosity(settings.logVerbosity);
      registerAppShortcuts();
      // Settings window can also change activation mode; keep behavior in
      // sync with the tray's setActivationMode (auto-start wake/always modes).
      if (partial.activationMode && partial.activationMode !== "push_to_talk") {
        listening = true;
        applyListeningState();
      } else {
        pushStatus();
      }
    },
    getStatus: () => currentStatus(),
  });

  // Route hidden mic-capture window start/stop via pipeline streaming state.
  const originalStart = pipeline.startStreaming.bind(pipeline);
  pipeline.startStreaming = async () => {
    await originalStart();
    micWindow.webContents.send("mic:start");
  };
  const originalStop = pipeline.stopStreaming.bind(pipeline);
  pipeline.stopStreaming = () => {
    originalStop();
    micWindow.webContents.send("mic:stop");
  };

  tray = createTray({
    getSettings: () => settingsStore.get(),
    isListening: () => listening,
    toggleListening: () => {
      toggleListening();
    },
    setActivationMode,
    toggleOverlay,
    openSettings: () => {
      settingsWindow.show();
      settingsWindow.focus();
    },
    openLogsFolder: () => {
      shell.openPath(logger.logDir);
    },
    clearHistory: () => pipeline.clearHistory(),
    quit: () => {
      app.quit();
    },
  });

  function registerAppShortcuts() {
    const settings = settingsStore.get();
    registerShortcuts({
      pushToTalkAccelerator: settings.pushToTalkShortcut,
      emergencyStopAccelerator: settings.emergencyStopShortcut,
      onPushToTalk: () => {
        if (settingsStore.get().activationMode !== "push_to_talk") return;
        listening = !listening;
        applyListeningState();
      },
      onEmergencyStop: () => {
        listening = false;
        pipeline.emergencyStop();
        pushStatus();
      },
    });
  }
  registerAppShortcuts();

  if (settingsStore.get().overlayVisible) overlayWindow.showInactive();

  await requestMicPermission();

  logger.event("app.ready", {});

  app.on("activate", () => {
    settingsWindow.show();
  });
});

app.on("window-all-closed", () => {
  // Menu-bar app: keep running even with no visible windows.
});

app.on("before-quit", () => {
  pipeline?.emergencyStop();
  browserBridge?.stop();
});
