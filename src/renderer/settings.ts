interface Window {
  dragonSettings: {
    get(): Promise<any>;
    update(partial: Record<string, unknown>): Promise<any>;
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

async function load() {
  const settings = await window.dragonSettings.get();
  byId<HTMLInputElement>("openRouterApiKey").placeholder = settings.hasOpenRouterKey
    ? "•••••••• (saved — leave blank to keep)"
    : "sk-or-...";
  byId<HTMLInputElement>("deepgramApiKey").placeholder = settings.hasDeepgramKey
    ? "•••••••• (saved — leave blank to keep)"
    : "Deepgram key";
  byId<HTMLSelectElement>("activationMode").value = settings.activationMode;
  byId<HTMLInputElement>("pushToTalkShortcut").value = settings.pushToTalkShortcut;
  byId<HTMLInputElement>("emergencyStopShortcut").value = settings.emergencyStopShortcut;
  byId<HTMLInputElement>("insertModeShortcut").value = settings.insertModeShortcut;
  byId<HTMLInputElement>("workflowModeShortcut").value = settings.workflowModeShortcut;
  byId<HTMLInputElement>("wakePhrase").value = settings.wakePhrase;
  byId<HTMLInputElement>("voiceReplyEnabled").checked = settings.voiceReplyEnabled;
  byId<HTMLSelectElement>("logVerbosity").value = settings.logVerbosity;
  await refreshHistory();
}

async function save() {
  const partial: Record<string, unknown> = {
    activationMode: byId<HTMLSelectElement>("activationMode").value,
    pushToTalkShortcut: byId<HTMLInputElement>("pushToTalkShortcut").value,
    emergencyStopShortcut: byId<HTMLInputElement>("emergencyStopShortcut").value,
    insertModeShortcut: byId<HTMLInputElement>("insertModeShortcut").value,
    workflowModeShortcut: byId<HTMLInputElement>("workflowModeShortcut").value,
    wakePhrase: byId<HTMLInputElement>("wakePhrase").value,
    voiceReplyEnabled: byId<HTMLInputElement>("voiceReplyEnabled").checked,
    logVerbosity: byId<HTMLSelectElement>("logVerbosity").value,
  };
  const orKey = byId<HTMLInputElement>("openRouterApiKey").value;
  const dgKey = byId<HTMLInputElement>("deepgramApiKey").value;
  if (orKey.trim().length > 0) partial.openRouterApiKey = orKey.trim();
  if (dgKey.trim().length > 0) partial.deepgramApiKey = dgKey.trim();

  await window.dragonSettings.update(partial);
  byId<HTMLInputElement>("openRouterApiKey").value = "";
  byId<HTMLInputElement>("deepgramApiKey").value = "";
  const status = byId<HTMLDivElement>("statusLine");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
  await load();
}

window.addEventListener("DOMContentLoaded", () => {
  load();
  byId<HTMLButtonElement>("saveBtn").addEventListener("click", save);
  byId<HTMLButtonElement>("openDashboardBtn").addEventListener("click", () => window.dragonSettings.openDashboard());
  byId<HTMLButtonElement>("openLogsBtn").addEventListener("click", () => window.dragonSettings.openLogs());
  byId<HTMLButtonElement>("clearHistoryBtn").addEventListener("click", async () => {
    await window.dragonSettings.clearHistory();
    await refreshHistory();
  });
  setInterval(refreshHistory, 4000);

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
