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
    getHistory(): Promise<any[]>;
    clearHistory(): Promise<any[]>;
    getStatus(): Promise<any>;
    onStatus(cb: (status: any) => void): void;
  };
}

(function settingsRenderer() {
function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function refreshHistory() {
  const history = await window.dragonSettings.getHistory();
  const body = byId<HTMLTableSectionElement>("historyBody");
  body.innerHTML = "";
  for (const h of history.slice(0, 30)) {
    const tr = document.createElement("tr");
    const time = new Date(h.timestamp).toLocaleTimeString();
    tr.innerHTML = `<td>${time}</td><td>${escapeHtml(h.transcript)}</td><td>${escapeHtml(h.action)}</td><td>${h.status}</td>`;
    body.appendChild(tr);
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

/** Stand-in for a stored secret. The real value is never sent to the renderer, so a saved key
 *  is shown as this in the input. An empty field must mean "no key", otherwise reopening the
 *  app looks identical to losing the key -- which is the bug this replaces. */
const KEY_MASK = "••••••••••••";

/** Render one API-key field: the mask (or nothing), the state line, and whether Clear applies. */
function renderKeyField(
  inputId: string,
  stateId: string,
  clearId: string,
  saved: boolean,
  emptyPlaceholder: string
): void {
  const input = byId<HTMLInputElement>(inputId);
  const state = byId<HTMLDivElement>(stateId);
  const clear = byId<HTMLButtonElement>(clearId);
  input.placeholder = emptyPlaceholder;
  input.value = saved ? KEY_MASK : "";
  state.textContent = saved ? "Saved on this machine." : "No key saved yet.";
  state.className = saved ? "keyState" : "keyState none";
  clear.disabled = !saved;
}

async function load() {
  const settings = await window.dragonSettings.get();
  renderKeyField(
    "openRouterApiKey",
    "openRouterKeyState",
    "clearOpenRouterKey",
    settings.hasOpenRouterKey,
    "sk-or-..."
  );
  renderKeyField(
    "deepgramApiKey",
    "deepgramKeyState",
    "clearDeepgramKey",
    settings.hasDeepgramKey,
    "Deepgram key"
  );
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
  byId<HTMLSelectElement>("logVerbosity").value = settings.logVerbosity;
  await refreshHistory();
}

async function save() {
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
    logVerbosity: byId<HTMLSelectElement>("logVerbosity").value,
  };
  // The mask means "keep what is stored". Anything else the user typed is a real new value, so
  // it replaces the stored one. An emptied field also keeps what is stored — that has always
  // been the rule, and "Clear" is now the explicit way to actually remove a key.
  const orKey = byId<HTMLInputElement>("openRouterApiKey").value.trim();
  const dgKey = byId<HTMLInputElement>("deepgramApiKey").value.trim();
  if (orKey.length > 0 && orKey !== KEY_MASK) partial.openRouterApiKey = orKey;
  if (dgKey.length > 0 && dgKey !== KEY_MASK) partial.deepgramApiKey = dgKey;

  const result = await window.dragonSettings.update(partial);
  const status = byId<HTMLDivElement>("statusLine");
  if (result.persisted) {
    status.textContent = "Saved.";
  } else {
    // Never claim success if the write failed. The error is in the log; saying "Saved." here is
    // what made this class of bug invisible in the first place.
    status.textContent = "NOT saved — the file could not be written. See the log.";
  }
  setTimeout(() => (status.textContent = ""), 4000);
  await load();
}

/** Remove a stored key outright, which blanking the field has never been able to express. */
async function clearKey(inputId: string, stateId: string, clearId: string, field: "openRouterApiKey" | "deepgramApiKey") {
  await window.dragonSettings.update({ [field]: "" });
  byId<HTMLInputElement>(inputId).value = "";
  byId<HTMLDivElement>(stateId).textContent = "No key saved yet.";
  byId<HTMLDivElement>(stateId).className = "keyState none";
  byId<HTMLButtonElement>(clearId).disabled = true;
}

async function refreshLayaServerStatus() {
  const status = await window.dragonSettings.getLayaServerStatus();
  const target = byId<HTMLDivElement>("layaServerStatus");
  target.textContent = status.message;
  target.dataset.state = status.state;
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
  const status = byId<HTMLDivElement>("statusLine");
  status.textContent = "Checking decision provider…";
  const result = await window.dragonSettings.checkDecisionProvider();
  status.textContent = result.ok ? result.message : `Provider unavailable: ${result.message}`;
}

window.addEventListener("DOMContentLoaded", () => {
  load();
  byId<HTMLButtonElement>("saveBtn").addEventListener("click", save);
  byId<HTMLButtonElement>("startLayaServerBtn").addEventListener("click", startLayaServer);
  byId<HTMLButtonElement>("stopLayaServerBtn").addEventListener("click", stopLayaServer);
  byId<HTMLButtonElement>("testProviderBtn").addEventListener("click", testDecisionProvider);
  byId<HTMLButtonElement>("clearOpenRouterKey").addEventListener("click", () =>
    clearKey("openRouterApiKey", "openRouterKeyState", "clearOpenRouterKey", "openRouterApiKey")
  );
  byId<HTMLButtonElement>("clearDeepgramKey").addEventListener("click", () =>
    clearKey("deepgramApiKey", "deepgramKeyState", "clearDeepgramKey", "deepgramApiKey")
  );
  byId<HTMLButtonElement>("openDashboardBtn").addEventListener("click", () => window.dragonSettings.openDashboard());
  byId<HTMLButtonElement>("openLogsBtn").addEventListener("click", () => window.dragonSettings.openLogs());
  byId<HTMLButtonElement>("clearHistoryBtn").addEventListener("click", async () => {
    await window.dragonSettings.clearHistory();
    await refreshHistory();
  });
  setInterval(refreshHistory, 4000);
  refreshLayaServerStatus();
  setInterval(refreshLayaServerStatus, 2000);

  const applyStatus = (status: any) => {
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
  };
  window.dragonSettings.getStatus().then(applyStatus);
  window.dragonSettings.onStatus(applyStatus);
});
})();
