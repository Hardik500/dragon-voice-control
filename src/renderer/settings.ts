interface Window {
  dragonSettings: {
    get(): Promise<any>;
    update(partial: Record<string, unknown>): Promise<any>;
    openLogs(): Promise<void>;
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
  byId<HTMLButtonElement>("openLogsBtn").addEventListener("click", () => window.dragonSettings.openLogs());
  byId<HTMLButtonElement>("clearHistoryBtn").addEventListener("click", async () => {
    await window.dragonSettings.clearHistory();
    await refreshHistory();
  });
  setInterval(refreshHistory, 4000);
});
})();
