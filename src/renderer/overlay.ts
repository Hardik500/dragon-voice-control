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
  const COMPLETION_LINGER_MS = 5000;
  let completionTimer: number | null = null;
  let lastCompletion: { action: string; status: string; latency: string } | null = null;

  function clearCompletion() {
    if (completionTimer != null) {
      window.clearTimeout(completionTimer);
      completionTimer = null;
    }
    lastCompletion = null;
    action.textContent = "";
    status.textContent = "";
    latency.textContent = "";
  }

  function render(update: any) {
    dot.className = `dot ${update.state}`;
    const modeLabel = update.interactionMode === "insert"
      ? "Insert Mode"
      : update.interactionMode === "workflow"
        ? "Workflow Mode"
        : null;
    stateText.textContent = `${STATE_LABELS[update.state] ?? update.state} · ${update.activationMode.replace(/_/g, " ")}${modeLabel ? ` · ${modeLabel}` : ""}`;
    transcript.textContent = update.transcript || "Say a command…";

    const isCompletion = update.state === "done" || update.state === "error";
    if (isCompletion) {
      lastCompletion = {
        action: update.action ? `→ ${update.action}` : "",
        status: update.status ?? "",
        latency: update.latencyMs != null ? `${update.latencyMs} ms` : "",
      };
      action.textContent = lastCompletion.action;
      status.textContent = lastCompletion.status;
      latency.textContent = lastCompletion.latency;
      if (completionTimer != null) window.clearTimeout(completionTimer);
      completionTimer = window.setTimeout(() => {
        completionTimer = null;
        lastCompletion = null;
        action.textContent = "";
        status.textContent = "";
        latency.textContent = "";
      }, COMPLETION_LINGER_MS);
      return;
    }

    // A new listening/idle update can arrive immediately after execution (for example, the
    // next Deepgram turn starts before the user has finished reading the result). Keep the
    // confirmation visible briefly, while still updating the live state/transcript.
    const isQuietState = update.state === "listening" || update.state === "idle";
    if (isQuietState && lastCompletion) {
      action.textContent = lastCompletion.action;
      status.textContent = lastCompletion.status;
      latency.textContent = lastCompletion.latency;
      return;
    }

    clearCompletion();
    action.textContent = update.action ? `→ ${update.action}` : "";
    status.textContent = update.status ?? "";
    latency.textContent = update.latencyMs != null ? `${update.latencyMs} ms` : "";
  }

  window.dragonOverlay.onUpdate(render);
});
})();
