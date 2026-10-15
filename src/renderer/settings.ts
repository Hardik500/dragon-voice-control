interface Window {
  dragonSettings: {
    get(): Promise<any>;
    update(partial: Record<string, unknown>): Promise<any>;
    checkDecisionProvider(): Promise<{ ok: boolean; provider: string; model: string | null; message: string }>;
    startLayaServer(): Promise<{ state: string; message: string; pid: number | null; model: string | null; managed: boolean }>;
    stopLayaServer(): Promise<{ state: string; message: string; pid: number | null; model: string | null; managed: boolean }>;
    getLayaServerStatus(): Promise<{ state: string; message: string; pid: number | null; model: string | null; managed: boolean }>;
    openLogs(): Promise<void>;
    openDashboard(): Promise<void>;
    openExtensionFolder(): Promise<void>;
    getHistory(): Promise<any[]>;
    clearHistory(): Promise<any[]>;
    getStatus(): Promise<any>;
    setListening(enabled: boolean): Promise<any>;
    retryListening(): Promise<any>;
    setMode(mode: "normal" | "insert" | "workflow"): Promise<any>;
    emergencyStop(): Promise<any>;
    listMicrophones(): Promise<Array<{ deviceId: string; label: string }>>;
    onStatus(cb: (status: any) => void): void;
  };
}

(function settingsRenderer() {
function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

type WorkspaceTab = "overview" | "commands" | "settings" | "activity";
let activeTab: WorkspaceTab = "overview";
let historyEntries: any[] = [];
let historyRequest = 0;

function selectTab(tab: WorkspaceTab, focus = false) {
  if (!["overview", "commands", "settings", "activity"].includes(tab)) return;
  activeTab = tab;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"))) {
    const selected = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId<HTMLElement>(`panel-${button.dataset.tab}`).hidden = !selected;
  }
  if (focus) byId<HTMLButtonElement>(`tab-${tab}`).focus();
  window.scrollTo(0, 0);
  if (tab === "activity") void refreshHistory();
  if (tab === "settings" && byId<HTMLSelectElement>("decisionProvider").value === "laya") void refreshLayaServerStatus();
}

async function refreshHistory() {
  const request = ++historyRequest;
  try {
    const history = await window.dragonSettings.getHistory();
    if (request !== historyRequest) return;
    historyEntries = Array.isArray(history) ? history.slice(0, 100) : [];
    renderHistory();
    byId<HTMLElement>("historyStatus").textContent = "";
  } catch {
    if (request === historyRequest) byId<HTMLElement>("historyStatus").textContent = "Could not refresh history. Your previous results are still shown. Try Refresh.";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function renderHistory() {
  const search = byId<HTMLInputElement>("historySearch").value.toLocaleLowerCase().trim();
  const filter = byId<HTMLSelectElement>("historyFilter").value;
  const entries = historyEntries.filter((entry) => (filter === "all" || entry.status === filter)
    && [entry.transcript, entry.action, entry.detail].some((value) => String(value ?? "").toLocaleLowerCase().includes(search)));
  const body = byId<HTMLElement>("historyBody");
  body.replaceChildren();
  for (const entry of entries) {
    const row = element("article", "activityEntry", "");
    const meta = element("div", "activityMeta", "");
    const date = new Date(entry.timestamp);
    meta.append(element("time", "", Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })));
    const status = element("span", "activityStatus", entry.status === "success" ? "Completed" : entry.status === "error" ? "Error" : "Ignored");
    status.dataset.state = entry.status === "success" ? "ready" : entry.status === "error" ? "attention" : "neutral";
    meta.append(status);
    row.append(meta, element("h3", "", entry.transcript || "No transcript"), element("p", "activityAction", entry.action || "No action"));
    if (entry.detail && entry.status !== "success") row.append(element("p", "activityDetail", entry.detail));
    body.append(row);
  }
  byId<HTMLElement>("historySummary").textContent = `${entries.length} of ${historyEntries.length} recent command${historyEntries.length === 1 ? "" : "s"}`;
  const empty = byId<HTMLElement>("historyEmpty");
  empty.hidden = entries.length > 0;
  if (!entries.length) {
    empty.replaceChildren(element("strong", "", historyEntries.length ? "No matching commands" : "No commands yet"),
      document.createTextNode(historyEntries.length ? "Try another search or result filter." : "Start listening in Overview and say “open Chrome”. Your results will appear here."));
  }
}

interface CommandExample { category: string; phrase: string; description: string; requirement?: string }
const COMMANDS: CommandExample[] = [
  { category:"Apps & windows", phrase:"Open Chrome", description:"Launch or focus a known application. Try Slack, Spotify, Terminal, or your editor." },
  { category:"Apps & windows", phrase:"Switch to Slack", description:"Bring a supported application to the foreground." },
  { category:"Apps & windows", phrase:"Switch to the previous app", description:"Return to your previously used application." },
  { category:"Apps & windows", phrase:"Minimize the window", description:"Minimize the current application's window." },
  { category:"Apps & windows", phrase:"Maximize the window", description:"Expand the active window." },
  { category:"Apps & windows", phrase:"Toggle fullscreen", description:"Enter or leave fullscreen in the focused app." },
  { category:"Apps & windows", phrase:"Close the window", description:"Close the focused window." },
  { category:"Apps & windows", phrase:"Hide Slack", description:"Hide a supported application without quitting it." },
  { category:"Apps & windows", phrase:"Quit Spotify", description:"Quit a supported application." },
  { category:"Point & click", phrase:"Point to Save", description:"Temporarily highlight a visible control without clicking. “Show me Save” and “highlight Save” also work.", requirement:"Frontmost window only" },
  { category:"Point & click", phrase:"Click Save", description:"Click a visible control by its label or a short description.", requirement:"Accessibility or vision lookup" },
  { category:"Point & click", phrase:"Double click Downloads", description:"Double-click a visible file, folder, or control.", requirement:"Frontmost window only" },
  { category:"Point & click", phrase:"2", description:"Choose a numbered on-screen match. Say 1–5 within 15 seconds; say “cancel” to dismiss.", requirement:"When numbered choices are visible" },
  { category:"Dictation", phrase:"Start typing", description:"Enter Insert Mode. Focus a field first; following speech is typed there." },
  { category:"Dictation", phrase:"Stop typing", description:"Return to Command Mode without stopping the microphone.", requirement:"Insert Mode" },
  { category:"Dictation", phrase:"Type hello there", description:"Type the phrase after “type” into the focused field.", requirement:"Command Mode" },
  { category:"Dictation", phrase:"Delete the last 3 words", description:"Remove trailing words from the text Dragon is currently tracking.", requirement:"Tracked dictation only" },
  { category:"Dictation", phrase:"Delete that", description:"Remove the last chunk of dictation Dragon typed.", requirement:"Tracked dictation only" },
  { category:"Dictation", phrase:"Replace draft with final", description:"Replace a matching phrase in the text Dragon just typed. After editing or moving the cursor yourself, restart dictation before correcting.", requirement:"Tracked dictation only" },
  { category:"Dictation", phrase:"New line", description:"Insert a line break into the focused field without sending it.", requirement:"Insert Mode" },
  { category:"Dictation", phrase:"New paragraph", description:"Insert two line breaks while dictating.", requirement:"Insert Mode" },
  { category:"Dictation", phrase:"Comma", description:"Say a standalone punctuation name: period, question mark, exclamation mark, colon, or semicolon.", requirement:"Insert Mode · say punctuation separately" },
  { category:"Dictation", phrase:"Open quote", description:"Insert a quote or parenthesis: open quote, close quote, open parenthesis, close parenthesis.", requirement:"Insert Mode · say punctuation separately" },
  { category:"Keyboard", phrase:"Press Enter", description:"Press a named key. Try Escape, Tab, Space, Backspace, arrows, Home, End, Page Up/Down, or F1–F12." },
  { category:"Keyboard", phrase:"Copy", description:"Use a common shortcut: copy, cut, paste, select all, undo, redo, save, or find." },
  { category:"Keyboard", phrase:"Press control Z", description:"Use a supported literal shortcut. Command/Control C, V, X, A, Z, Y, S, F, T, W, Q, and R are recognized." },
  { category:"Keyboard", phrase:"Next field", description:"Move focus with Tab; say “previous field” for Shift+Tab." },
  { category:"Keyboard", phrase:"Word left", description:"Move the text cursor by a word. Also try word right, beginning of line, end of line, beginning of document, or end of document." },
  { category:"Keyboard", phrase:"Select word right", description:"Extend a text selection. Try select word left, select line, select to beginning, or select to end." },
  { category:"Browser", phrase:"Open example dot com", description:"Open a spoken domain or URL in Chrome. Website names such as YouTube and GitHub also work.", requirement:"Works without the extension" },
  { category:"Browser", phrase:"Search for electric bikes", description:"Search the web in Chrome. On supported sites, Dragon can search the current site when the extension is connected.", requirement:"Web search works without the extension" },
  { category:"Browser", phrase:"Scroll down", description:"Scroll a page or focused app; also try up, top, or bottom. Chrome uses its extension when available; other apps use navigation keys." },
  { category:"Browser", phrase:"Go back", description:"Navigate back in the current Chrome tab; “go forward” moves forward.", requirement:"Chrome extension" },
  { category:"Browser", phrase:"Reload the page", description:"Refresh the current Chrome tab.", requirement:"Chrome extension" },
  { category:"Browser", phrase:"New tab", description:"Open a new Chrome tab.", requirement:"Chrome extension" },
  { category:"Browser", phrase:"Close tab", description:"Close the current Chrome tab.", requirement:"Chrome extension" },
  { category:"Browser", phrase:"Next tab", description:"Move to the next Chrome tab; “previous tab” moves back.", requirement:"Chrome extension" },
  { category:"Browser", phrase:"Switch to tab 3", description:"Jump directly to a Chrome tab by its position.", requirement:"Chrome extension" },
  { category:"Browser", phrase:"Switch to the GitHub tab", description:"Find an open Chrome tab by a title or website name.", requirement:"Chrome extension" },
  { category:"System & media", phrase:"Volume 50", description:"Set the output volume to a spoken percentage." },
  { category:"System & media", phrase:"Volume up", description:"Raise or lower the system output volume in steps." },
  { category:"System & media", phrase:"Mute", description:"Mute system output. Say “unmute” to restore audio." },
  { category:"System & media", phrase:"Pause music", description:"Toggle media playback in the current player." },
  { category:"System & media", phrase:"Next track", description:"Skip to the next track. “Previous track” goes back." },
  { category:"System & media", phrase:"Open Bluetooth settings", description:"Open a supported system settings pane: sound, network, displays, privacy, battery, keyboard, mouse, and more." },
  { category:"System & media", phrase:"Open Downloads", description:"Open a known folder such as Downloads, Documents, Desktop, Home, Pictures, Music, Applications, or Trash." },
  { category:"Modes", phrase:"Start workflow", description:"Enter Workflow Mode for a series of separate direct commands. Speak one action per utterance." },
  { category:"Modes", phrase:"Stop workflow", description:"Leave Workflow Mode and return to Command Mode." },
];
let commandCategory = "All";

function renderCommands() {
  const query = byId<HTMLInputElement>("commandSearch").value.toLocaleLowerCase().trim();
  const words = query.split(/\s+/).filter(Boolean);
  const matches = COMMANDS.filter((command) => (commandCategory === "All" || command.category === commandCategory)
    && words.every((word) => `${command.category} ${command.phrase} ${command.description} ${command.requirement ?? ""}`.toLocaleLowerCase().includes(word)));
  const list = byId<HTMLElement>("commandList");
  list.replaceChildren();
  for (const command of matches) {
    const card = element("article", "commandCard", "");
    card.append(element("h3", "", command.category), element("p", "commandPhrase", `“${command.phrase}”`), element("p", "commandDescription", command.description));
    if (command.requirement) card.append(element("span", "requirement", command.requirement));
    list.append(card);
  }
  byId<HTMLElement>("commandCount").textContent = `${matches.length} command example${matches.length === 1 ? "" : "s"}${commandCategory === "All" ? "" : ` in ${commandCategory}`}`;
  byId<HTMLElement>("commandEmpty").hidden = matches.length > 0;
  for (const filter of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-category]"))) filter.setAttribute("aria-pressed", String(filter.dataset.category === commandCategory));
}

function initWorkspace() {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  for (const [index, button] of tabs.entries()) {
    button.addEventListener("click", () => selectTab(button.dataset.tab as WorkspaceTab));
    button.addEventListener("keydown", (event) => {
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next].dataset.tab as WorkspaceTab, true);
    });
  }
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-open-tab]"))) button.addEventListener("click", () => selectTab(button.dataset.openTab as WorkspaceTab, true));
  for (const category of ["All", ...new Set(COMMANDS.map((command) => command.category))]) {
    const filter = element("button", "filter", category);
    filter.type = "button";
    filter.dataset.category = category;
    filter.addEventListener("click", () => { commandCategory = category; renderCommands(); });
    byId<HTMLElement>("commandFilters").append(filter);
  }
  byId<HTMLInputElement>("commandSearch").addEventListener("input", renderCommands);
  byId<HTMLInputElement>("historySearch").addEventListener("input", renderHistory);
  byId<HTMLSelectElement>("historyFilter").addEventListener("change", renderHistory);
  byId<HTMLButtonElement>("refreshHistoryBtn").addEventListener("click", () => void refreshHistory());
  byId<HTMLSelectElement>("decisionProvider").addEventListener("change", renderProviderFields);
  for (const field of Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#settingsForm input, #settingsForm select"))) {
    field.addEventListener("input", renderDraftState);
    field.addEventListener("change", renderDraftState);
    if (field instanceof HTMLInputElement && field.type === "password") field.addEventListener("focus", () => { if (field.value === KEY_MASK) field.select(); });
  }
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (savedSettings && !saving && !keyMutation) void save();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && activeTab === "commands") {
      event.preventDefault(); byId<HTMLInputElement>("commandSearch").focus();
    }
  });
  renderCommands();
}

/** Stand-in for a stored secret. The real value is never sent to the renderer, so a saved key
 *  is shown as this in the input. An empty field must mean "no key", otherwise reopening the
 *  app looks identical to losing the key -- which is the bug this replaces. */
const KEY_MASK = "••••••••••••";

// Only the presence flags and non-secret preferences returned by settings:get are used here.
// Status refreshes update this guide without reloading or overwriting the settings form.
interface SetupSettings {
  [key: string]: any;
  hasOpenRouterKey: boolean;
  hasDeepgramKey: boolean;
  decisionProvider: string;
  activationMode: string;
  pushToTalkShortcut: string;
  emergencyStopShortcut: string;
  insertModeShortcut: string;
  workflowModeShortcut: string;
}
let savedSettings: SetupSettings | null = null;
let latestStatus: any = null;
let settingsPersisted = true;
let voiceAction: "start" | "pause" | "retry" | null = null;
let voiceActionId = 0;
let statusRevision = 0;
let saving = false;
let keyMutation = false;
let workspaceAction = false;
let microphoneDevices: Array<{ deviceId: string; label: string }> = [];
let microphoneRefreshBusy = false;

function formHasChanges(): boolean {
  if (!savedSettings) return false;
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#settingsForm input, #settingsForm select")).some((field) => {
    if (field.type === "password") return field.value.trim() !== "" && field.value.trim() !== KEY_MASK;
    const value = field instanceof HTMLInputElement && field.type === "checkbox" ? field.checked : field.value;
    const savedValue = field.id === "audioInputDeviceId" ? savedSettings!.audioInputDeviceId || "" : field.id === "overlayVisible" ? savedSettings!.overlayVisible !== false : savedSettings![field.id];
    return value !== savedValue;
  });
}

function statusMessage(text: string, state: "ready" | "attention" | "neutral" = "neutral") {
  const target = byId<HTMLElement>("statusLine");
  target.textContent = text;
  target.dataset.state = state;
}

function renderDraftState() {
  const dirty = formHasChanges();
  byId<HTMLElement>("draftMarker").hidden = !dirty;
  const saveButton = byId<HTMLButtonElement>("saveBtn");
  saveButton.textContent = saving ? "Saving…" : "Save changes";
  saveButton.disabled = !savedSettings || saving || keyMutation;
  if (saving) statusMessage("Saving your changes…");
  else if (!settingsPersisted) statusMessage("Changes not saved to disk. Retry Save.", "attention");
  else if (dirty) statusMessage("Unsaved changes · Save to apply.", "attention");
  else if (savedSettings) statusMessage("All changes saved on this machine.", "ready");
  for (const id of ["clearOpenRouterKey", "clearDeepgramKey"]) {
    const flag = id === "clearOpenRouterKey" ? savedSettings?.hasOpenRouterKey : savedSettings?.hasDeepgramKey;
    byId<HTMLButtonElement>(id).disabled = !flag || saving || keyMutation;
  }
  if (settingsPersisted && savedSettings) {
    for (const [inputId, stateId, flag] of [
      ["openRouterApiKey", "openRouterKeyState", savedSettings.hasOpenRouterKey],
      ["deepgramApiKey", "deepgramKeyState", savedSettings.hasDeepgramKey],
    ] as const) {
      const value = byId<HTMLInputElement>(inputId).value.trim();
      const state = byId<HTMLElement>(stateId);
      const replacement = value !== "" && value !== KEY_MASK;
      state.textContent = replacement ? "Replacement not saved yet. Save to apply." : flag ? value ? "Saved on this machine." : "Saved key kept. Use Clear to remove it." : "No key saved yet.";
      state.className = flag && !replacement ? "keyState" : "keyState none";
    }
  }
}

function renderProviderFields() {
  byId<HTMLElement>("layaSettings").hidden = byId<HTMLSelectElement>("decisionProvider").value !== "laya";
}

function renderMicrophones(selected = byId<HTMLSelectElement>("audioInputDeviceId").value) {
  const select = byId<HTMLSelectElement>("audioInputDeviceId");
  select.replaceChildren(new Option("System default microphone", ""));
  const seen = new Set<string>();
  for (const device of microphoneDevices) {
    if (!device.deviceId || device.deviceId === "default" || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    select.append(new Option(device.label || `Microphone ${seen.size}`, device.deviceId));
  }
  if (selected && !seen.has(selected)) select.append(new Option("Unavailable input · select another or reconnect it", selected));
  select.value = selected;
}

async function refreshMicrophones() {
  if (microphoneRefreshBusy) return;
  microphoneRefreshBusy = true;
  const button = byId<HTMLButtonElement>("refreshMicrophonesBtn");
  const status = byId<HTMLElement>("microphoneDeviceStatus");
  button.disabled = true;
  button.textContent = "Refreshing…";
  status.textContent = "Looking for microphone inputs…";
  status.dataset.state = "neutral";
  try {
    const devices = await window.dragonSettings.listMicrophones();
    microphoneDevices = devices.filter((device) => typeof device.deviceId === "string" && typeof device.label === "string");
    // Read the current draft after enumeration returns. Selecting an input during a slow
    // refresh must not be replaced by whichever option was selected before it started.
    const selected = byId<HTMLSelectElement>("audioInputDeviceId").value;
    renderMicrophones(selected);
    const available = microphoneDevices.filter((device) => device.deviceId && device.deviceId !== "default");
    const missing = selected && !microphoneDevices.some((device) => device.deviceId === selected);
    const unnamed = available.some((device) => !device.label);
    status.textContent = missing ? "Selected input is unavailable. Reconnect it, or choose another input and Save."
      : available.length === 0 ? "No named inputs are available yet. System default remains available; start voice once, then refresh."
      : `${available.length} microphone input${available.length === 1 ? "" : "s"} found.${unnamed ? " Start voice once to reveal device names, then refresh." : ""}`;
    status.dataset.state = missing ? "attention" : "neutral";
  } catch {
    status.textContent = "Could not list microphones. Your selected input is kept. Try Refresh inputs again.";
    status.dataset.state = "attention";
  } finally {
    microphoneRefreshBusy = false;
    button.disabled = false;
    button.textContent = "Refresh inputs";
  }
}

function setupState(id: string, text: string, state: "ready" | "attention" | "neutral") {
  const target = byId<HTMLElement>(id);
  target.textContent = text;
  target.dataset.state = state;
}

function renderSetup() {
  const settings = savedSettings;
  if (settings) {
    const missing: string[] = [];
    if (!settings.hasDeepgramKey) missing.push("Deepgram");
    if (settings.decisionProvider === "jev" && !settings.hasOpenRouterKey) missing.push("OpenRouter");
    if (!settingsPersisted) {
      setupState("setupCredentials", "Changes could not be saved to disk. Retry Save in Settings.", "attention");
    } else if (missing.length > 0) {
      setupState("setupCredentials", `Add your ${missing.join(" and ")} key${missing.length > 1 ? "s" : ""} in Settings, then Save.`, "attention");
    } else {
      setupState("setupCredentials", settings.decisionProvider === "jev"
        ? "Deepgram and OpenRouter keys saved. Keys have not been validated here."
        : "Deepgram key saved. Laya uses your local server; test it in Settings.", "ready");
    }
    byId<HTMLElement>("setupListenGuide").textContent = settings.activationMode === "always_listening"
      ? "Always listening is selected. Pause or resume here or from the tray menu."
      : `Start or stop listening with ${settings.pushToTalkShortcut}. Press once to start, again to stop.`;
    byId<HTMLElement>("setupInsertShortcut").textContent = settings.insertModeShortcut;
    byId<HTMLElement>("setupWorkflowShortcut").textContent = settings.workflowModeShortcut;
    byId<HTMLElement>("setupStopShortcut").textContent = settings.emergencyStopShortcut;
  }

  renderVoiceControls();
  const status = latestStatus;
  if (!status) return;
  const mode = status.workflowMode ? "Workflow" : status.insertMode ? "Insert" : "Command";
  byId<HTMLElement>("setupCurrentMode").textContent = `Current mode: ${mode}`;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mode]"))) {
    const selected = button.dataset.mode === (status.workflowMode ? "workflow" : status.insertMode ? "insert" : "normal");
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = workspaceAction;
  }

  const speech = status.speech;
  const microphone = status.microphone;
  const voiceReady = speech?.state === "connected" && microphone?.state === "capturing";
  const voiceError = speech?.state === "error" || microphone?.state === "error";
  setupState("sessionBadge", voiceError ? "Voice needs attention" : !status.listening ? "Paused" : voiceReady ? `${mode} · Listening` : "Connecting…", voiceError ? "attention" : voiceReady ? "ready" : "neutral");
  byId<HTMLElement>("setupTitle").textContent = voiceError ? "Let’s get voice working again" : voiceReady ? "You’re connected. Say your next move." : status.listening ? "Getting your voice connected…" : "Ready when you are";
  byId<HTMLElement>("setupSummary").textContent = voiceError ? "Check the connection details below, then use Retry voice. Your saved settings and drafts stay here."
    : !savedSettings?.hasDeepgramKey || (savedSettings?.decisionProvider === "jev" && !savedSettings?.hasOpenRouterKey) ? "Add your required API keys in Settings. Start listening, focus your target app, then say “open Chrome”."
    : voiceReady ? "Focus the app you want to control. Say “click Save”, “start typing”, or explore the Commands tab for more."
    : "Start listening when you’re ready. Then focus the app you want to control and speak one action at a time.";
  setupState("setupListening", !status.listening
    ? "Paused. Start here, from your shortcut or the tray menu."
    : voiceReady ? "Listening · microphone and speech connection ready."
    : voiceError ? "Listening interrupted. Check Speech and Microphone below."
    : "Starting voice… waiting for the microphone and speech connection.",
    status.listening ? voiceReady ? "ready" : voiceError ? "attention" : "neutral" : "neutral");

  const speechState = speech?.state;
  const speechMessage = speech?.message;
  const reconnectAttempt = speech?.reconnectAttempt;
  setupState("setupSpeech", speechState === "connected"
    ? "Connected to transcription service."
    : speechState === "connecting" ? speechMessage || "Connecting to transcription service…"
    : speechState === "reconnecting" ? `Reconnecting${reconnectAttempt > 0 ? ` · attempt ${reconnectAttempt}` : ""}. ${speechMessage || "Waiting for the network connection."}`
    : speechState === "error" ? speechMessage || "Connection failed. Check your saved Deepgram key and network, then Retry voice."
    : speechMessage || "Disconnected. Start listening to connect.",
    speechState === "connected" ? "ready" : speechState === "error" || speechState === "reconnecting" ? "attention" : "neutral");

  const microphoneState = microphone?.state;
  setupState("setupMicrophone", microphoneState === "capturing"
    ? "Capturing audio from your microphone."
    : microphoneState === "starting" ? microphone.message || "Starting microphone… allow access if prompted."
    : microphoneState === "error" ? microphone.message || "Microphone unavailable. Check permission and your input device, then Retry voice."
    : microphone?.message || "Stopped. Starting voice may ask for microphone access.",
    microphoneState === "capturing" ? "ready" : microphoneState === "error" ? "attention" : "neutral");

  const shortcuts = status.shortcutStatus;
  if (shortcuts) {
    const failed = [
      [shortcuts.pushToTalkOk, "listen toggle"],
      [shortcuts.emergencyStopOk, "emergency stop"],
      [shortcuts.insertModeOk, "Insert"],
      [shortcuts.workflowModeOk, "Workflow"],
    ].filter(([ok]) => ok === false).map(([, label]) => label);
    const allRegistered = [shortcuts.pushToTalkOk, shortcuts.emergencyStopOk, shortcuts.insertModeOk, shortcuts.workflowModeOk]
      .every((ok) => ok === true);
    setupState("setupShortcuts", failed.length > 0
      ? `Unavailable: ${failed.join(", ")}. Change the combination in Settings and Save.`
      : allRegistered ? "All four shortcuts registered." : "Checking registration…",
      failed.length > 0 ? "attention" : allRegistered ? "ready" : "neutral");
  }
  setupState("setupBrowser", status.browserConnected
    ? "Extension connected · browser controls available."
    : "Extension optional for opening websites and searches. Load it for page controls and tabs.",
    status.browserConnected ? "ready" : "neutral");
  byId<HTMLElement>("extensionDirectory").textContent = typeof status.extensionDirectory === "string" && status.extensionDirectory
    ? status.extensionDirectory : "Extension location unavailable. Try Reload setup.";
  byId<HTMLElement>("setupBridgeRow").hidden = !status.browserBindError;
  byId<HTMLElement>("setupBridge").textContent = status.browserBindError
    ? `Could not start: ${status.browserBindError}` : "";
}

function renderVoiceControls() {
  const toggle = byId<HTMLButtonElement>("toggleListeningBtn");
  const retry = byId<HTMLButtonElement>("retryVoiceBtn");
  toggle.textContent = voiceAction === "pause" ? "Pausing…" : latestStatus?.listening ? "Pause listening"
    : voiceAction === "start" ? "Starting…" : "Start listening";
  retry.textContent = voiceAction === "retry" ? "Retrying…" : "Retry voice";
  // A connection attempt may take several seconds. Pause must still cancel it.
  toggle.disabled = !latestStatus || voiceAction === "pause" || (voiceAction !== null && !latestStatus.listening);
  const connecting = latestStatus?.speech?.state === "connecting" || latestStatus?.speech?.state === "reconnecting";
  retry.disabled = voiceAction !== null || !latestStatus || (connecting && latestStatus?.microphone?.state !== "error");
}

async function runVoiceAction(action: "start" | "pause" | "retry") {
  if (voiceAction !== null && !(action === "pause" && latestStatus?.listening && voiceAction !== "pause")) return;
  const actionId = ++voiceActionId;
  const revision = statusRevision;
  voiceAction = action;
  const message = byId<HTMLElement>("voiceActionStatus");
  message.textContent = "";
  renderVoiceControls();
  try {
    const status = action === "retry"
      ? await window.dragonSettings.retryListening()
      : await window.dragonSettings.setListening(action === "start");
    if (actionId === voiceActionId && revision === statusRevision) applyStatus(status);
  } catch {
    if (actionId !== voiceActionId) return;
    message.textContent = action === "pause"
      ? "Could not pause listening. Try again or use Emergency Stop."
      : "Could not start voice. Check Speech and Microphone above, then retry.";
    // An IPC rejection must not leave the controls busy or discard unsaved form edits.
    const recoveryRevision = statusRevision;
    try {
      const status = await window.dragonSettings.getStatus();
      if (actionId === voiceActionId && recoveryRevision === statusRevision) applyStatus(status);
    } catch { /* Keep the last known status. */ }
  } finally {
    if (actionId === voiceActionId) {
      voiceAction = null;
      renderVoiceControls();
    }
  }
}

function applyStatus(status: any) {
  const microphoneStarted = latestStatus?.microphone?.state !== "capturing" && status?.microphone?.state === "capturing";
  statusRevision += 1;
  latestStatus = status;
  renderSetup();
  if (microphoneStarted) void refreshMicrophones();
  const warn = byId<HTMLDivElement>("shortcutWarning");
  const problems: string[] = [];
  if (status?.shortcutStatus?.pushToTalkOk === false) problems.push("push-to-talk/listen-toggle");
  if (status?.shortcutStatus?.emergencyStopOk === false) problems.push("emergency stop");
  if (status?.shortcutStatus?.insertModeOk === false) problems.push("Insert Mode");
  if (status?.shortcutStatus?.workflowModeOk === false) problems.push("Workflow Mode");
  if (problems.length > 0) {
    warn.textContent = `Could not register the ${problems.join(" and ")} shortcut — it may already be in use by another app. Pick a different combination above and save.`;
    warn.classList.add("visible");
  } else {
    warn.classList.remove("visible");
  }

  const bridgeWarn = byId<HTMLDivElement>("bridgeWarning");
  if (status?.browserBindError) {
    bridgeWarn.textContent = `Chrome bridge did not start: ${status.browserBindError}`;
    bridgeWarn.classList.add("visible");
  } else {
    bridgeWarn.classList.remove("visible");
  }
}

/** Render one API-key field: the mask (or nothing), the state line, and whether Clear applies. */
function renderKeyField(
  inputId: string,
  stateId: string,
  clearId: string,
  saved: boolean,
  emptyPlaceholder: string,
  resetValue = true
): void {
  const input = byId<HTMLInputElement>(inputId);
  const state = byId<HTMLDivElement>(stateId);
  const clear = byId<HTMLButtonElement>(clearId);
  input.placeholder = emptyPlaceholder;
  if (resetValue) input.value = saved ? KEY_MASK : "";
  state.textContent = !settingsPersisted ? "Change not saved to disk. Retry Save." : saved ? "Saved on this machine." : "No key saved yet.";
  state.className = saved && settingsPersisted ? "keyState" : "keyState none";
  clear.disabled = !saved;
}

function renderKeys(settings: SetupSettings, resetOpenRouter = false, resetDeepgram = false) {
  renderKeyField("openRouterApiKey", "openRouterKeyState", "clearOpenRouterKey", settings.hasOpenRouterKey, "sk-or-...", resetOpenRouter);
  renderKeyField("deepgramApiKey", "deepgramKeyState", "clearDeepgramKey", settings.hasDeepgramKey, "Deepgram key", resetDeepgram);
}

async function load() {
  const settings = await window.dragonSettings.get();
  savedSettings = settings;
  renderKeys(settings, true, true);
  byId<HTMLSelectElement>("activationMode").value = settings.activationMode;
  byId<HTMLSelectElement>("decisionProvider").value = settings.decisionProvider;
  byId<HTMLInputElement>("layaBaseUrl").value = settings.layaBaseUrl;
  byId<HTMLInputElement>("layaModel").value = settings.layaModel;
  byId<HTMLInputElement>("layaServerCommand").value = settings.layaServerCommand;
  byId<HTMLInputElement>("pushToTalkShortcut").value = settings.pushToTalkShortcut;
  byId<HTMLInputElement>("emergencyStopShortcut").value = settings.emergencyStopShortcut;
  byId<HTMLInputElement>("insertModeShortcut").value = settings.insertModeShortcut;
  byId<HTMLInputElement>("workflowModeShortcut").value = settings.workflowModeShortcut;
  byId<HTMLInputElement>("voiceReplyEnabled").checked = settings.voiceReplyEnabled;
  byId<HTMLInputElement>("overlayVisible").checked = settings.overlayVisible !== false;
  renderMicrophones(settings.audioInputDeviceId || "");
  byId<HTMLSelectElement>("logVerbosity").value = settings.logVerbosity;
  byId<HTMLSelectElement>("screenClickMethod").value = settings.screenClickMethod;
  renderProviderFields();
  renderDraftState();
  renderSetup();
  void refreshMicrophones();
  await refreshHistory();
}

async function persistForm() {
  const snapshot = new Map<string, string | boolean>();
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#settingsForm input, #settingsForm select"))) {
    if (input.type !== "password") snapshot.set(input.id, input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value);
  }
  const partial: Record<string, unknown> = {
    activationMode: byId<HTMLSelectElement>("activationMode").value,
    decisionProvider: byId<HTMLSelectElement>("decisionProvider").value,
    layaBaseUrl: byId<HTMLInputElement>("layaBaseUrl").value.trim(),
    layaModel: byId<HTMLInputElement>("layaModel").value.trim() || "laya",
    layaServerCommand: byId<HTMLInputElement>("layaServerCommand").value.trim() || "laya-server",
    pushToTalkShortcut: byId<HTMLInputElement>("pushToTalkShortcut").value,
    emergencyStopShortcut: byId<HTMLInputElement>("emergencyStopShortcut").value,
    insertModeShortcut: byId<HTMLInputElement>("insertModeShortcut").value,
    workflowModeShortcut: byId<HTMLInputElement>("workflowModeShortcut").value,
    voiceReplyEnabled: byId<HTMLInputElement>("voiceReplyEnabled").checked,
    overlayVisible: byId<HTMLInputElement>("overlayVisible").checked,
    audioInputDeviceId: byId<HTMLSelectElement>("audioInputDeviceId").value,
    logVerbosity: byId<HTMLSelectElement>("logVerbosity").value,
    screenClickMethod: byId<HTMLSelectElement>("screenClickMethod").value,
  };
  // The mask means "keep what is stored". Anything else the user typed is a real new value, so
  // it replaces the stored one. An emptied field also keeps what is stored — that has always
  // been the rule, and "Clear" is now the explicit way to actually remove a key.
  const orKey = byId<HTMLInputElement>("openRouterApiKey").value.trim();
  const dgKey = byId<HTMLInputElement>("deepgramApiKey").value.trim();
  if (orKey.length > 0 && orKey !== KEY_MASK) partial.openRouterApiKey = orKey;
  if (dgKey.length > 0 && dgKey !== KEY_MASK) partial.deepgramApiKey = dgKey;

  const result = await window.dragonSettings.update(partial);
  savedSettings = result;
  settingsPersisted = result.persisted;
  if (!result.persisted) {
    // A failed atomic write may return the previous settings. Keep every submitted draft,
    // including replacement keys, available for the next Save.
    renderKeys(result, false, false);
    renderSetup();
    return;
  }
  // Apply normalized values only to controls that have not been edited during the save.
  // A live status update, key clear, or a slow IPC response must not discard a draft.
  for (const [field, submitted] of Object.entries(partial)) {
    if (field === "openRouterApiKey" || field === "deepgramApiKey") continue;
    const input = byId<HTMLInputElement | HTMLSelectElement>(field);
    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      if (input.checked === snapshot.get(field)) input.checked = result[field];
    } else if (input.value === snapshot.get(field)) {
      input.value = result[field];
    }
  }
  renderKeys(result, byId<HTMLInputElement>("openRouterApiKey").value.trim() === orKey,
    byId<HTMLInputElement>("deepgramApiKey").value.trim() === dgKey);
  renderSetup();
  renderProviderFields();
  await refreshHistory();
}

async function save() {
  if (!savedSettings || saving || keyMutation) return;
  saving = true;
  renderDraftState();
  let failure = false;
  try { await persistForm(); }
  catch {
    failure = true;
    statusMessage("Could not save settings. Check the values and retry. Your edits are still here.", "attention");
  } finally {
    saving = false;
    renderDraftState();
    if (failure) statusMessage("Could not save settings. Check the values and retry. Your edits are still here.", "attention");
  }
}

/** Remove a stored key outright, which blanking the field has never been able to express. */
async function clearKey(inputId: string, field: "openRouterApiKey" | "deepgramApiKey") {
  if (saving || keyMutation) return;
  keyMutation = true;
  renderDraftState();
  const before = byId<HTMLInputElement>(inputId).value;
  let failure = false;
  try {
    const result = await window.dragonSettings.update({ [field]: "" });
    savedSettings = result;
    settingsPersisted = result.persisted;
    const unchanged = byId<HTMLInputElement>(inputId).value === before;
    renderKeys(result, field === "openRouterApiKey" && unchanged, field === "deepgramApiKey" && unchanged);
    renderSetup();
  } catch { failure = true; }
  finally {
    keyMutation = false;
    renderDraftState();
    if (failure) statusMessage("Could not remove the key. Try Clear again.", "attention");
  }
}

async function refreshLayaServerStatus() {
  try {
    const status = await window.dragonSettings.getLayaServerStatus();
    const target = byId<HTMLDivElement>("layaServerStatus");
    target.textContent = status.message;
    target.dataset.state = status.state;
  } catch { byId<HTMLElement>("layaServerStatus").textContent = "Could not read local server status. Try again."; }
}

async function startLayaServer() {
  byId<HTMLDivElement>("layaServerStatus").textContent = "Starting Laya server…";
  await window.dragonSettings.startLayaServer();
  await refreshLayaServerStatus();
}

async function stopLayaServer() {
  await window.dragonSettings.stopLayaServer();
  await refreshLayaServerStatus();
}

async function testDecisionProvider() {
  const status = byId<HTMLDivElement>("providerStatus");
  status.textContent = "Checking decision provider…";
  const result = await window.dragonSettings.checkDecisionProvider();
  status.textContent = result.ok ? result.message : `Provider unavailable: ${result.message}`;
  status.dataset.state = result.ok ? "ready" : "attention";
}

async function runButtonAction(id: string, targetId: string, action: () => Promise<unknown>, error: string) {
  const button = byId<HTMLButtonElement>(id);
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); }
  catch { byId<HTMLElement>(targetId).textContent = error; }
  finally { button.disabled = false; }
}

async function changeMode(mode: "normal" | "insert" | "workflow") {
  if (workspaceAction) return;
  workspaceAction = true;
  renderSetup();
  const revision = statusRevision;
  try {
    const status = await window.dragonSettings.setMode(mode);
    if (revision === statusRevision) applyStatus(status);
    byId<HTMLElement>("voiceActionStatus").textContent = "";
  } catch { byId<HTMLElement>("voiceActionStatus").textContent = "Could not change mode. Try the global mode shortcut."; }
  finally { workspaceAction = false; renderSetup(); }
}

async function emergencyStop() {
  // Invalidate a pending voice action before sending Stop; a slow Start cannot redraw it.
  ++voiceActionId;
  voiceAction = null;
  const revision = statusRevision;
  try {
    const status = await window.dragonSettings.emergencyStop();
    if (revision === statusRevision) applyStatus(status);
    byId<HTMLElement>("voiceActionStatus").textContent = "Stopped. Modes and pending commands cleared.";
  } catch { byId<HTMLElement>("voiceActionStatus").textContent = "Could not stop from this window. Use your Emergency Stop shortcut."; }
  finally { renderVoiceControls(); }
}

async function reloadSetup() {
  const button = byId<HTMLButtonElement>("reloadSetupBtn");
  button.disabled = true;
  try {
    if (!savedSettings) await load();
    const revision = statusRevision;
    const status = await window.dragonSettings.getStatus();
    if (revision === statusRevision) applyStatus(status);
    button.hidden = true;
    byId<HTMLElement>("voiceActionStatus").textContent = "";
  } catch { byId<HTMLElement>("voiceActionStatus").textContent = "Could not load setup. Try Reload setup again."; }
  finally { button.disabled = false; }
}

window.addEventListener("DOMContentLoaded", () => {
  initWorkspace();
  load().catch(() => {
    statusMessage("Could not load settings. Use Reload setup in Overview to retry.", "attention");
    setupState("setupCredentials", "Could not load settings. Use Reload setup to retry.", "attention");
    byId<HTMLElement>("reloadSetupBtn").hidden = false;
  });
  byId<HTMLButtonElement>("saveBtn").addEventListener("click", save);
  byId<HTMLButtonElement>("toggleListeningBtn").addEventListener("click", () =>
    runVoiceAction(latestStatus?.listening ? "pause" : "start"));
  byId<HTMLButtonElement>("retryVoiceBtn").addEventListener("click", () => runVoiceAction("retry"));
  byId<HTMLButtonElement>("emergencyStopBtn").addEventListener("click", emergencyStop);
  byId<HTMLButtonElement>("reloadSetupBtn").addEventListener("click", reloadSetup);
  byId<HTMLButtonElement>("refreshMicrophonesBtn").addEventListener("click", () => void refreshMicrophones());
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mode]"))) button.addEventListener("click", () => void changeMode(button.dataset.mode as "normal" | "insert" | "workflow"));
  byId<HTMLButtonElement>("startLayaServerBtn").addEventListener("click", () => void runButtonAction("startLayaServerBtn", "layaServerStatus", startLayaServer, "Could not start Laya. Save settings and check the server command."));
  byId<HTMLButtonElement>("stopLayaServerBtn").addEventListener("click", () => void runButtonAction("stopLayaServerBtn", "layaServerStatus", stopLayaServer, "Could not stop the local server. Check the diagnostic logs."));
  byId<HTMLButtonElement>("testProviderBtn").addEventListener("click", () => void runButtonAction("testProviderBtn", "providerStatus", testDecisionProvider, "Could not test the provider. Check saved settings and your connection."));
  byId<HTMLButtonElement>("clearOpenRouterKey").addEventListener("click", () =>
    clearKey("openRouterApiKey", "openRouterApiKey")
  );
  byId<HTMLButtonElement>("clearDeepgramKey").addEventListener("click", () =>
    clearKey("deepgramApiKey", "deepgramApiKey")
  );
  byId<HTMLButtonElement>("openDashboardBtn").addEventListener("click", () => void runButtonAction("openDashboardBtn", "diagnosticStatus", () => window.dragonSettings.openDashboard(), "Could not open the decision dashboard."));
  byId<HTMLButtonElement>("openLogsBtn").addEventListener("click", () => void runButtonAction("openLogsBtn", "diagnosticStatus", () => window.dragonSettings.openLogs(), "Could not open the logs folder."));
  byId<HTMLButtonElement>("openExtensionFolderBtn").addEventListener("click", () => void runButtonAction("openExtensionFolderBtn", "extensionFolderStatus", async () => {
    byId<HTMLElement>("extensionFolderStatus").textContent = "Opening the extension folder…";
    await window.dragonSettings.openExtensionFolder();
    byId<HTMLElement>("extensionFolderStatus").textContent = "Extension folder opened. Select this folder in Chrome’s Load unpacked dialog.";
  }, "Could not open the extension folder. Use the displayed folder path in Chrome’s Load unpacked dialog."));
  byId<HTMLButtonElement>("clearHistoryBtn").addEventListener("click", () => void runButtonAction("clearHistoryBtn", "historyStatus", async () => {
    ++historyRequest;
    await window.dragonSettings.clearHistory();
    await refreshHistory();
  }, "Could not clear command history. Try again."));
  setInterval(() => { if (activeTab === "activity" && !document.hidden) void refreshHistory(); }, 4000);
  setInterval(() => { if (activeTab === "settings" && !document.hidden && byId<HTMLSelectElement>("decisionProvider").value === "laya") void refreshLayaServerStatus(); }, 3000);

  const initialStatusRevision = statusRevision;
  window.dragonSettings.getStatus().then((status) => {
    if (statusRevision === initialStatusRevision) applyStatus(status);
  }).catch(() => {
    byId<HTMLElement>("voiceActionStatus").textContent = "Could not read voice status. Use Reload setup to retry.";
    byId<HTMLElement>("reloadSetupBtn").hidden = false;
  });
  window.dragonSettings.onStatus(applyStatus);
});
})();
