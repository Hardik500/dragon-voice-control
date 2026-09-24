interface Window {
  dragonSettings: {
    get(): Promise<any>;
    update(partial: Record<string, unknown>): Promise<any>;
    openLogs(): Promise<void>;
    getHistory(): Promise<any[]>;
    clearHistory(): Promise<any[]>;
    getJevDecisions(): Promise<any[]>;
    clearJevDecisions(): Promise<any[]>;
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

function formatProbability(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function renderJevChoice(prefix: string, choice: any) {
  byId<HTMLDivElement>(`jev${prefix}Value`).textContent = `${choice.choice} · ${formatProbability(choice.confidence)}`;
  const bar = byId<HTMLSpanElement>(`jev${prefix}Bar`);
  bar.style.width = `${Math.max(0, Math.min(100, choice.confidence * 100))}%`;
  const alternatives = Object.entries(choice.probabilities ?? {})
    .filter(([name]) => name !== choice.choice)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([name, probability]) => `${name} ${formatProbability(Number(probability))}`)
    .join(" · ");
  byId<HTMLDivElement>(`jev${prefix}Alternatives`).textContent = alternatives || "No alternatives reported";
}

async function refreshJevDashboard() {
  const traces = await window.dragonSettings.getJevDecisions();
  const empty = byId<HTMLDivElement>("jevEmpty");
  const latest = byId<HTMLDivElement>("jevLatest");
  const recent = byId<HTMLDivElement>("jevRecent");
  recent.innerHTML = "";

  if (traces.length === 0) {
    empty.style.display = "block";
    latest.style.display = "none";
    return;
  }

  empty.style.display = "none";
  latest.style.display = "block";
  const trace = traces[0];
  byId<HTMLSpanElement>("jevTime").textContent = new Date(trace.timestamp).toLocaleTimeString();
  byId<HTMLSpanElement>("jevModel").textContent = trace.model || "Jev";
  byId<HTMLDivElement>("jevTranscript").textContent = `“${trace.transcript}” · ${trace.activeApp || "Unknown app"}`;
  renderJevChoice("Intent", trace.choices.intent);
  renderJevChoice("Target", trace.choices.target);
  renderJevChoice("Direction", trace.choices.direction);

  for (const item of traces.slice(1, 9)) {
    const row = document.createElement("div");
    row.className = "jev-row";
    const time = document.createElement("span");
    time.className = "jev-row-time";
    time.textContent = new Date(item.timestamp).toLocaleTimeString();
    const transcript = document.createElement("span");
    transcript.textContent = item.transcript;
    const intent = document.createElement("span");
    intent.className = "jev-row-intent";
    intent.textContent = item.choices.intent.choice;
    const target = document.createElement("span");
    target.className = "jev-row-target";
    target.textContent = item.choices.target.choice;
    row.append(time, transcript, intent, target);
    recent.appendChild(row);
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
  await refreshJevDashboard();
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
  byId<HTMLButtonElement>("clearJevBtn").addEventListener("click", async () => {
    await window.dragonSettings.clearJevDecisions();
    await refreshJevDashboard();
  });
  setInterval(() => {
    refreshHistory();
    refreshJevDashboard();
  }, 4000);

  const applyStatus = (status: any) => {
    const warn = byId<HTMLDivElement>("shortcutWarning");
    const problems: string[] = [];
    if (status?.shortcutStatus?.pushToTalkOk === false) problems.push("push-to-talk/listen-toggle");
    if (status?.shortcutStatus?.emergencyStopOk === false) problems.push("emergency stop");
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
