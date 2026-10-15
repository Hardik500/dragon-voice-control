import { app, session, shell, systemPreferences, BrowserWindow, Menu, Tray } from "electron";
import * as path from "path";
import { logger } from "../logging/logger";
import { trustSystemCaCerts } from "./system-ca";
import { SettingsStore } from "./settings-store";
import { BrowserBridge } from "../browser/server";
import { DashboardServer } from "./dashboard-server";
import { DragonPipeline } from "./pipeline";
import { LayaServerManager } from "./laya-server";
import { createMicWindow, createOverlayWindow, createSettingsWindow, showOverlay } from "./windows";
import { createTray } from "./tray";
import { TargetOverlays } from "./target-overlays";
import { registerIpc, broadcastStatus } from "./ipc";
import { registerShortcuts, ShortcutRegistrationStatus } from "./shortcuts";
import { ActivationMode } from "../types/settings";
import { OverlayUpdate } from "../types/pipeline";
import { MicrophoneStatus } from "../types/voice";

app.setName("Dragon");
trustSystemCaCerts();

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
let layaServer: LayaServerManager;
let settingsWindow: BrowserWindow;
let overlayWindow: BrowserWindow;
let targetOverlays: TargetOverlays;
let lastOverlayUpdate: Record<string, unknown> | null = null;
let lastPipelineOverlay: OverlayUpdate | null = null;
let micWindow: BrowserWindow;
let tray: Tray;
let refreshTray: () => void = () => {};
let listening = false;
// Generation tags reject late permission results, errors and audio from an older capture.
let micGeneration = 0;
let micCaptureRequested = false;
let micRendererReady = false;
let micRendererCrashed = false;
let configuredInputDeviceId = "";
let microphone: MicrophoneStatus = { state: "stopped", message: null };
let shortcutStatus: ShortcutRegistrationStatus = { pushToTalkOk: true, emergencyStopOk: true, insertModeOk: true, workflowModeOk: true };

function currentStatus() {
  const settings = settingsStore.get();
  return {
    listening,
    streaming: pipeline.isStreaming(),
    speech: pipeline.getSpeechStatus(),
    microphone: { ...microphone },
    activationMode: settings.activationMode,
    insertMode: pipeline.isInsertModeActive(),
    workflowMode: pipeline.isWorkflowModeActive(),
    workflowStep: pipeline.getWorkflowStepCount(),
    browserConnected: browserBridge.isConnected(),
    extensionDirectory: app.isPackaged ? path.join(process.resourcesPath, "chrome-extension") : path.join(__dirname, "..", "..", "chrome-extension"),
    browserBindError: browserBridge.getBindError(),
    layaServer: layaServer.getStatus(),
    shortcutStatus,
  };
}

function pushStatus() {
  broadcastStatus([settingsWindow], currentStatus());
  const speech = pipeline.getSpeechStatus();
  const label = microphone.state === "error" || speech.state === "error" ? "Voice needs attention"
    : !listening ? "Paused"
    : speech.state === "reconnecting" ? "Reconnecting transcription"
    : speech.state !== "connected" ? "Connecting transcription"
    : microphone.state === "capturing" ? "Listening" : "Starting microphone";
  tray?.setToolTip(`Dragon · ${label}`);
}

function publishOverlay(update: OverlayUpdate): void {
  lastPipelineOverlay = update;
  if (overlayWindow.isDestroyed()) return;
  const settings = settingsStore.get();
  const interactionMode = pipeline.getInteractionMode();
  const status = update.status ?? (interactionMode === "workflow" ? `Workflow · Step ${pipeline.getWorkflowStepCount()}` : null);
  lastOverlayUpdate = {
    ...update, interactionMode, status,
    shortcuts: { listen: settings.pushToTalkShortcut, stop: settings.emergencyStopShortcut },
    voice: { requested: listening, speech: pipeline.getSpeechStatus(), microphone: { ...microphone } },
  };
  overlayWindow.webContents.send("overlay:update", lastOverlayUpdate);
  targetOverlays.update(settings.overlayVisible ? update.screenTargets ?? null : null);
}

function requestMicrophone(capture: boolean): void {
  if (micCaptureRequested === capture) return;
  micCaptureRequested = capture;
  micGeneration += 1;
  if (capture) microphone = { state: "starting", message: null };
  else if (microphone.state !== "error") microphone = { state: "stopped", message: null };
  if (capture && micRendererCrashed) {
    const generation = micGeneration;
    queueMicrotask(() => onMicStatus("error", "Microphone capture stopped. Retry voice to restart it.", generation));
  } else if (micRendererReady && !micWindow.isDestroyed()) {
    micWindow.webContents.send(capture ? "mic:start" : "mic:stop", micGeneration, { deviceId: settingsStore.get().audioInputDeviceId });
  }
}

function syncMicrophone(): void {
  const state = pipeline.getSpeechStatus().state;
  // Keep an already-open input warm during reconnect; audio is never buffered or replayed.
  requestMicrophone(listening && (state === "connected" ||
    (micCaptureRequested && (state === "connecting" || state === "reconnecting"))));
  if (lastPipelineOverlay) publishOverlay(lastPipelineOverlay);
  pushStatus();
  refreshTray();
}

function onMicStatus(status: string, detail: string | undefined, generation: number): void {
  if (status === "ready") {
    micRendererReady = true;
    micRendererCrashed = false;
    micWindow.webContents.send(micCaptureRequested ? "mic:start" : "mic:stop", micGeneration, { deviceId: settingsStore.get().audioInputDeviceId });
    return;
  }
  if (generation !== micGeneration) return;
  if (status === "error" && micCaptureRequested) {
    microphone = { state: "error", message: detail || "Microphone unavailable. Check your input and retry voice." };
    requestMicrophone(false);
    pipeline.stopStreaming();
    pipeline.reportMicrophoneError(microphone.message!);
  } else if (status === "capturing" && micCaptureRequested) {
    microphone = { state: "capturing", message: null };
    if (lastPipelineOverlay) publishOverlay(lastPipelineOverlay);
  } else if (status === "starting" && micCaptureRequested) {
    microphone = { state: "starting", message: null };
  } else if (status === "stopped" && !micCaptureRequested && microphone.state !== "error") {
    microphone = { state: "stopped", message: null };
  }
  pushStatus();
  refreshTray();
}

async function applyListeningState(opts: { gracefulStop?: boolean } = {}): Promise<void> {
  if (!listening) {
    // Push-to-talk release: give Deepgram a moment to flush the final EndOfTurn
    // for whatever was just said instead of yanking the connection (see
    // DragonPipeline.stopStreaming).
    requestMicrophone(false);
    pipeline.stopStreaming({ graceful: opts.gracefulStop ?? false });
    pushStatus();
    return;
  }
  // Push-to-talk (start on toggle-on) and the two continuous modes all start
  // streaming the same way; only how `listening` gets flipped differs.
  await pipeline.startStreaming();
  pushStatus();
}

async function setListening(enabled: boolean): Promise<void> {
  const wasListening = listening;
  listening = enabled;
  if (enabled && !wasListening) microphone = { state: "stopped", message: null };
  logger.event("app.listening_toggled", { listening });
  const graceful = !enabled && settingsStore.get().activationMode === "push_to_talk";
  await applyListeningState({ gracefulStop: graceful });
  refreshTray();
}

function toggleListening() {
  void setListening(!listening);
}

async function retryListening(): Promise<void> {
  logger.event("app.voice_retry", {});
  pipeline.stopStreaming();
  microphone = { state: "stopped", message: null };
  listening = true;
  // A crashed hidden renderer cannot receive mic:start; reload only on an explicit retry.
  if (!micRendererReady && !micWindow.isDestroyed() && !micWindow.webContents.isLoadingMainFrame()) {
    micRendererCrashed = false;
    micWindow.reload();
  }
  await applyListeningState();
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
  void applyListeningState();
  refreshTray();
}

function setActivationMode(mode: ActivationMode) {
  const updated = settingsStore.update({ activationMode: mode });
  if (settingsStore.persistedLast) applyModeChange(updated.activationMode);
  else refreshTray();
}

function applyOverlayVisibility(): void {
  if (settingsStore.get().overlayVisible) {
    showOverlay(overlayWindow);
    targetOverlays.update((lastOverlayUpdate?.screenTargets as OverlayUpdate["screenTargets"]) ?? null);
  } else {
    overlayWindow.hide();
    targetOverlays.clear();
  }
}

function toggleOverlay(): void {
  settingsStore.update({ overlayVisible: !settingsStore.get().overlayVisible });
  applyOverlayVisibility();
  refreshTray();
}

function setInteractionMode(mode: "normal" | "insert" | "workflow"): void {
  if (mode === "insert" && !pipeline.isInsertModeActive()) pipeline.toggleInsertMode();
  else if (mode === "workflow" && !pipeline.isWorkflowModeActive()) pipeline.toggleWorkflowMode();
  else if (mode === "normal") {
    if (pipeline.isInsertModeActive()) pipeline.toggleInsertMode();
    if (pipeline.isWorkflowModeActive()) pipeline.toggleWorkflowMode();
  }
  pushStatus();
  refreshTray();
}

function emergencyStop(): void {
  listening = false;
  pipeline.emergencyStop();
  pushStatus();
  refreshTray();
}

async function listMicrophones(): Promise<Array<{ deviceId: string; label: string }>> {
  if (micWindow.isDestroyed() || !micRendererReady) throw new Error("Microphone window is not ready. Retry voice, then refresh inputs.");
  return micWindow.webContents.executeJavaScript(
    "navigator.mediaDevices.enumerateDevices().then(devices => devices.filter(d => d.kind === 'audioinput').map(d => ({deviceId:d.deviceId,label:d.label})))"
  );
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
  logger.event("app.start", {
    platform: process.platform,
    arch: process.arch,
    // Packaged vs dev changes the execution environment (asar, launch path, inherited env),
    // and a fault that only appears in one of them is impossible to diagnose from a log that
    // does not say which it was. Recorded so no future session has to be reconstructed by hand.
    packaged: app.isPackaged,
    electron: process.versions.electron,
    node: process.versions.node,
  });
  app.dock?.hide();

  // Electron installs a full File/Edit/View/Window/Help application menu by default. For a tray
  // app whose only window is a settings pane, that bar is pure noise. macOS will not let a
  // regular app have no menu bar at all, so this trims it to the smallest bar that stays usable.
  //
  // Edit is kept on purpose. On macOS the clipboard shortcuts are menu *roles*, not Chromium
  // built-ins, so dropping this menu risks breaking Cmd+C/Cmd/V — and the settings window's
  // main job is pasting API keys into text fields. That is not worth a marginally cleaner bar.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));

  // The hidden mic-capture window needs getUserMedia; auto-approve only the
  // media permission for our own windows (there is no third-party content).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  settingsStore = new SettingsStore();
  logger.setVerbosity(settingsStore.get().logVerbosity);
  configuredInputDeviceId = settingsStore.get().audioInputDeviceId;
  // Reflect the persisted activation mode immediately: if the user quit while in a
  // continuous mode, relaunching should resume listening, not silently sit idle until
  // they notice and manually toggle it (see PROGRESS.md/DECISIONS.md).
  listening = settingsStore.get().activationMode !== "push_to_talk";

  browserBridge = new BrowserBridge();
  browserBridge.onConnectionChanged(() => {
    if (pipeline && layaServer && settingsWindow) pushStatus();
  });
  browserBridge.start();

  overlayWindow = createOverlayWindow();
  settingsWindow = createSettingsWindow();
  micWindow = createMicWindow();
  targetOverlays = new TargetOverlays();
  overlayWindow.webContents.on("did-finish-load", () => {
    if (lastOverlayUpdate) overlayWindow.webContents.send("overlay:update", lastOverlayUpdate);
  });
  const initialSettings = settingsStore.get();
  const needsSetup = !initialSettings.deepgramApiKey.trim() ||
    (initialSettings.decisionProvider === "jev" && !initialSettings.openRouterApiKey.trim());
  if (needsSetup) {
    settingsWindow.once("ready-to-show", () => {
      settingsWindow.show();
      settingsWindow.focus();
    });
  }

  pipeline = new DragonPipeline(
    () => settingsStore.get(),
    browserBridge,
    (update: OverlayUpdate) => {
      publishOverlay(update);
      pushStatus();
    },
    () => syncMicrophone()
  );
  layaServer = new LayaServerManager(
    () => settingsStore.get(),
    () => pushStatus()
  );

  dashboardServer = new DashboardServer(
    () => pipeline.getJevDecisionTraces(),
    () => currentStatus()
  );
  dashboardServer.start();

  registerIpc({
    settingsStore,
    pipeline,
    layaServer,
    onSettingsChanged: (settings, changedMode) => {
      logger.setVerbosity(settings.logVerbosity);
      applyOverlayVisibility();
      if (settings.audioInputDeviceId !== configuredInputDeviceId) {
        configuredInputDeviceId = settings.audioInputDeviceId;
        if (micCaptureRequested) { requestMicrophone(false); syncMicrophone(); }
      }
      registerAppShortcuts();
      if (changedMode) {
        applyModeChange(changedMode);
      } else {
        pushStatus();
        refreshTray();
      }
    },
    openDashboard: () => {
      void shell.openExternal(dashboardServer.url());
    },
    getStatus: () => currentStatus(),
    setListening,
    retryListening,
    setMode: setInteractionMode,
    emergencyStop,
    listMicrophones,
    onMicStatus,
    onMicChunk: (chunk, generation) => {
      if (micCaptureRequested && generation === micGeneration) pipeline.handleMicChunk(chunk);
    },
  });
  micWindow.webContents.on("render-process-gone", () => {
    micRendererReady = false;
    micRendererCrashed = true;
    if (micCaptureRequested) onMicStatus("error", "Microphone capture stopped. Retry voice to restart it.", micGeneration);
  });

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
    clearHistory: () => {
      try { pipeline.clearHistory(); }
      catch (error) { logger.error("history.clear_failed", error); }
    },
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
      onEmergencyStop: emergencyStop,
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

  if (settingsStore.get().overlayVisible) showOverlay(overlayWindow);

  await requestMicPermission();

  // Actually start streaming now if the persisted mode implies it (see the `listening`
  // seed above) — permission has been requested/granted by this point.
  void applyListeningState();
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
  // Logged first so a run that is stuck can be told apart from one that never started quitting.
  logger.event("app.quit", {});
  pipeline?.emergencyStop();
  targetOverlays?.clear();
  layaServer?.dispose();
  browserBridge?.stop();
  dashboardServer?.stop();
});

} // if (gotSingleInstanceLock)
