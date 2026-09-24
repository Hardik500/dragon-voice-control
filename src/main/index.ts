import { app, session, shell, systemPreferences, BrowserWindow, Tray } from "electron";
import { logger } from "../logging/logger";
import { SettingsStore } from "./settings-store";
import { BrowserBridge } from "../browser/server";
import { DashboardServer } from "./dashboard-server";
import { DragonPipeline } from "./pipeline";
import { createMicWindow, createOverlayWindow, createSettingsWindow } from "./windows";
import { createTray } from "./tray";
import { registerIpc, broadcastStatus } from "./ipc";
import { registerShortcuts, ShortcutRegistrationStatus } from "./shortcuts";
import { ActivationMode } from "../types/settings";
import { OverlayUpdate } from "../types/pipeline";

app.setName("Dragon");

// Menu-bar apps are especially easy to accidentally launch twice (double-clicking the
// packaged app while a dev instance is already running, re-running `npm start`, etc.). A
// second instance would silently fail to bind the browser bridge's fixed port — which looks
// exactly like "the Chrome extension is broken" with no obvious cause — so refuse to start a
// second instance at all and just focus the existing one's Settings window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let settingsStore: SettingsStore;
let browserBridge: BrowserBridge;
let dashboardServer: DashboardServer;
let pipeline: DragonPipeline;
let settingsWindow: BrowserWindow;
let overlayWindow: BrowserWindow;
let micWindow: BrowserWindow;
let tray: Tray;
let refreshTray: () => void = () => {};
let listening = false;
let shortcutStatus: ShortcutRegistrationStatus = { pushToTalkOk: true, emergencyStopOk: true, insertModeOk: true, workflowModeOk: true };

function currentStatus() {
  const settings = settingsStore.get();
  return {
    listening,
    streaming: pipeline.isStreaming(),
    activationMode: settings.activationMode,
    insertMode: pipeline.isInsertModeActive(),
    workflowMode: pipeline.isWorkflowModeActive(),
    workflowStep: pipeline.getWorkflowStepCount(),
    browserConnected: browserBridge.isConnected(),
    browserBindError: browserBridge.getBindError(),
    shortcutStatus,
  };
}

function pushStatus() {
  broadcastStatus([settingsWindow], currentStatus());
}

function applyListeningState(opts: { gracefulStop?: boolean } = {}) {
  if (!listening) {
    // Push-to-talk release: give Deepgram a moment to flush the final EndOfTurn
    // for whatever was just said instead of yanking the connection (see
    // DragonPipeline.stopStreaming).
    pipeline.stopStreaming({ graceful: opts.gracefulStop ?? false });
    pushStatus();
    return;
  }
  // Push-to-talk (start on toggle-on) and the two continuous modes all start
  // streaming the same way; only how `listening` gets flipped differs.
  pipeline.startStreaming();
  pushStatus();
}

function toggleListening() {
  listening = !listening;
  logger.event("app.listening_toggled", { listening });
  const graceful = !listening && settingsStore.get().activationMode === "push_to_talk";
  applyListeningState({ gracefulStop: graceful });
  refreshTray();
}

/**
 * Shared by the tray's mode picker and the Settings-window save path so both
 * behave identically: always stop whatever session was running under the old
 * mode (its turn-handling logic no longer applies once the mode changes),
 * then auto-start listening again for the two continuous modes. Push-to-talk
 * still requires the explicit hotkey/tray toggle to start.
 */
function applyModeChange(mode: ActivationMode) {
  logger.event("app.activation_mode_changed", { mode });
  pipeline.stopStreaming();
  listening = mode !== "push_to_talk";
  applyListeningState();
  refreshTray();
}

function setActivationMode(mode: ActivationMode) {
  settingsStore.update({ activationMode: mode });
  applyModeChange(mode);
}

function toggleOverlay() {
  const settings = settingsStore.get();
  const next = !settings.overlayVisible;
  settingsStore.update({ overlayVisible: next });
  if (next) overlayWindow.showInactive();
  else overlayWindow.hide();
  refreshTray();
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

if (gotSingleInstanceLock) {
app.on("second-instance", () => {
  // Another launch attempt happened while we're already running — surface this instance's
  // Settings window instead of doing nothing (which would look like the app didn't launch).
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
  }
});

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
  // Reflect the persisted activation mode immediately: if the user quit while in a
  // continuous mode, relaunching should resume listening, not silently sit idle until
  // they notice and manually toggle it (see PROGRESS.md/DECISIONS.md).
  listening = settingsStore.get().activationMode !== "push_to_talk";

  browserBridge = new BrowserBridge();
  browserBridge.start();

  overlayWindow = createOverlayWindow();
  settingsWindow = createSettingsWindow();
  micWindow = createMicWindow();

  pipeline = new DragonPipeline(
    () => settingsStore.get(),
    browserBridge,
    (update: OverlayUpdate) => {
      if (!overlayWindow.isDestroyed()) {
        const interactionMode = pipeline.getInteractionMode();
        const status = update.status ?? (interactionMode === "workflow" ? `Workflow · Step ${pipeline.getWorkflowStepCount()}` : null);
        overlayWindow.webContents.send("overlay:update", { ...update, interactionMode, status });
      }
      pushStatus();
    }
  );

  dashboardServer = new DashboardServer(
    () => pipeline.getJevDecisionTraces(),
    () => currentStatus()
  );
  dashboardServer.start();

  registerIpc({
    settingsStore,
    pipeline,
    onSettingsChanged: (settings, changedMode) => {
      logger.setVerbosity(settings.logVerbosity);
      registerAppShortcuts();
      if (changedMode) {
        applyModeChange(changedMode);
      } else {
        pushStatus();
        refreshTray(); // e.g. wake phrase changed, which the tray label shows.
      }
    },
    openDashboard: () => {
      void shell.openExternal(dashboardServer.url());
    },
    getStatus: () => currentStatus(),
  });

  // Route hidden mic-capture window start/stop via pipeline streaming state.
  const originalStart = pipeline.startStreaming.bind(pipeline);
  pipeline.startStreaming = async () => {
    await originalStart();
    if (!micWindow.isDestroyed()) micWindow.webContents.send("mic:start");
  };
  const originalStop = pipeline.stopStreaming.bind(pipeline);
  pipeline.stopStreaming = (opts) => {
    originalStop(opts);
    if (!micWindow.isDestroyed()) micWindow.webContents.send("mic:stop");
  };

  const trayHandle = createTray({
    getSettings: () => settingsStore.get(),
    isListening: () => listening,
    isInsertModeActive: () => pipeline.isInsertModeActive(),
    isWorkflowModeActive: () => pipeline.isWorkflowModeActive(),
    toggleListening: () => {
      toggleListening();
    },
    toggleInsertMode: () => {
      pipeline.toggleInsertMode();
      pushStatus();
      refreshTray();
    },
    toggleWorkflowMode: () => {
      pipeline.toggleWorkflowMode();
      pushStatus();
      refreshTray();
    },
    setActivationMode,
    toggleOverlay,
    openSettings: () => {
      settingsWindow.show();
      settingsWindow.focus();
    },
    openDashboard: () => {
      void shell.openExternal(dashboardServer.url());
    },
    openLogsFolder: () => {
      shell.openPath(logger.logDir);
    },
    clearHistory: () => pipeline.clearHistory(),
    quit: () => {
      app.quit();
    },
  });
  tray = trayHandle.tray;
  refreshTray = trayHandle.refresh;

  function registerAppShortcuts() {
    const settings = settingsStore.get();
    shortcutStatus = registerShortcuts({
      pushToTalkAccelerator: settings.pushToTalkShortcut,
      emergencyStopAccelerator: settings.emergencyStopShortcut,
      insertModeAccelerator: settings.insertModeShortcut,
      workflowModeAccelerator: settings.workflowModeShortcut,
      onPushToTalk: () => {
        if (settingsStore.get().activationMode !== "push_to_talk") return;
        toggleListening();
      },
      onEmergencyStop: () => {
        listening = false;
        pipeline.emergencyStop();
        pushStatus();
        refreshTray();
      },
      onToggleInsertMode: () => {
        pipeline.toggleInsertMode();
        pushStatus();
        refreshTray();
      },
      onToggleWorkflowMode: () => {
        pipeline.toggleWorkflowMode();
        pushStatus();
        refreshTray();
      },
    });
    if (!shortcutStatus.pushToTalkOk || !shortcutStatus.emergencyStopOk || !shortcutStatus.insertModeOk || !shortcutStatus.workflowModeOk) {
      logger.event("shortcuts.registration_failed", { ...shortcutStatus });
    }
    pushStatus();
  }
  registerAppShortcuts();

  if (settingsStore.get().overlayVisible) overlayWindow.showInactive();

  await requestMicPermission();

  // Actually start streaming now if the persisted mode implies it (see the `listening`
  // seed above) — permission has been requested/granted by this point.
  applyListeningState();
  refreshTray();

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
  dashboardServer?.stop();
});

} // if (gotSingleInstanceLock)
