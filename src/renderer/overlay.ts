interface Window {
  dragonOverlay: {
    onUpdate(cb: (update: any) => void): void;
    getHistory(): Promise<any[]>;
  };
}

(function overlayRenderer() {
function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  executing: "Executing",
  done: "Done",
  error: "Error",
};

window.addEventListener("DOMContentLoaded", () => {
  const dot = byId<HTMLSpanElement>("dot");
  const stateText = byId<HTMLSpanElement>("stateText");
  const transcript = byId<HTMLDivElement>("transcript");
  const action = byId<HTMLDivElement>("action");
  const status = byId<HTMLDivElement>("status");
  const latency = byId<HTMLDivElement>("latency");

  window.dragonOverlay.onUpdate((update) => {
    dot.className = `dot ${update.state}`;
    stateText.textContent = `${STATE_LABELS[update.state] ?? update.state} · ${update.activationMode.replace(/_/g, " ")}`;
    transcript.textContent = update.transcript || "Say a command…";
    action.textContent = update.action ? `→ ${update.action}` : "";
    status.textContent = update.status ?? "";
    latency.textContent = update.latencyMs != null ? `${update.latencyMs} ms` : "";
  });
});
})();
