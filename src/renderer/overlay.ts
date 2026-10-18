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
  idle: "Mic off", listening: "Listening", thinking: "Thinking",
  executing: "Executing", done: "Done", error: "Needs attention",
};
const MODE_DETAILS: Record<string, { label: string; hint: string }> = {
  normal: { label: "Command", hint: "Say “open Chrome” or “point to Save”." },
  insert: { label: "Insert · speech becomes text", hint: "Say “new line”, “delete that”, or “stop typing”." },
  workflow: { label: "Workflow", hint: "Say the next browser command. Say “stop workflow” to finish." },
};

window.addEventListener("DOMContentLoaded", () => {
  const card = byId<HTMLDivElement>("card");
  const dot = byId<HTMLSpanElement>("dot");
  const stateText = byId<HTMLSpanElement>("stateText");
  const transcript = byId<HTMLDivElement>("transcript");
  const action = byId<HTMLDivElement>("action");
  const status = byId<HTMLDivElement>("status");
  const latency = byId<HTMLSpanElement>("latency");
  const choices = byId<HTMLOListElement>("choices");
  const hint = byId<HTMLDivElement>("hint");
  const COMPLETION_LINGER_MS = 5000;
  let completionTimer: number | null = null;
  let lastCompletion: { action: string; status: string; latency: string } | null = null;
  let choiceExpiry = 0;
  let modeHint = MODE_DETAILS.normal.hint;

  function clearCompletion() {
    if (completionTimer != null) window.clearTimeout(completionTimer);
    completionTimer = null;
    lastCompletion = null;
    action.textContent = "";
    status.textContent = "";
    latency.textContent = "";
  }

  function updateCountdown() {
    if (!choiceExpiry) return;
    const seconds = Math.ceil((choiceExpiry - Date.now()) / 1000);
    if (seconds <= 0) {
      choiceExpiry = 0;
      choices.replaceChildren();
      card.classList.remove("choosing");
      hint.textContent = "Choice expired. Say the target again.";
      return;
    }
    hint.textContent = `Say a number or “cancel” · ${seconds}s left.`;
  }
  window.setInterval(updateCountdown, 250);

  function render(update: any) {
    const modeKey = update.interactionMode ?? "normal";
    const mode = MODE_DETAILS[modeKey] ?? MODE_DETAILS.normal;
    const voice = update.voice;
    const voiceError = voice?.microphone?.state === "error" ? voice.microphone.message
      : voice?.speech?.state === "error" ? voice.speech.message : null;
    const reconnecting = voice?.requested && voice?.speech?.state === "reconnecting";
    const connecting = voice?.requested && voice?.speech?.state === "connecting";
    const startingMic = voice?.requested && voice?.speech?.state === "connected" && voice?.microphone?.state !== "capturing";
    const quiet = update.state === "idle" || update.state === "listening";
    const waiting = quiet && (connecting || reconnecting || startingMic);
    const displayStatus = voiceError || update.status ||
      (startingMic ? "Starting microphone…" : connecting || reconnecting ? voice?.speech?.message : null);
    card.dataset.mode = modeKey;
    card.dataset.state = voiceError ? "error" : update.state;
    dot.className = `dot ${voiceError ? "error" : waiting ? "thinking" : update.state}`;
    stateText.textContent = voiceError ? "Voice needs attention"
      : waiting ? reconnecting ? "Reconnecting" : connecting ? "Connecting" : "Starting mic"
      : STATE_LABELS[update.state] ?? update.state;
    byId<HTMLSpanElement>("mode").textContent = mode.label;
    byId<HTMLSpanElement>("activation").textContent = update.activationMode === "always_listening" ? "Always listening" : "Listen toggle";
    transcript.textContent = update.transcript || (voiceError ? "Voice is unavailable." : waiting ? "Getting voice ready…" : update.state === "idle" ? "Ready when you are." : "Say a command…");
    modeHint = mode.hint;
    const shortcuts = update.shortcuts;
    if (shortcuts) {
      byId<HTMLSpanElement>("shortcuts").textContent = `${shortcuts.listen} · Listen  /  ${shortcuts.stop} · Stop`;
    }

    const targets = update.screenTargets;
    const choosing = targets?.kind === "choice" && targets.expiresAt > Date.now();
    card.classList.toggle("choosing", !!choosing);
    choices.replaceChildren();
    choiceExpiry = choosing ? targets.expiresAt : 0;
    if (choosing) {
      clearCompletion();
      for (const target of targets.targets) {
        const li = document.createElement("li");
        const number = document.createElement("span");
        number.className = "number";
        number.textContent = String(target.number);
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = target.label;
        li.append(number, label);
        choices.appendChild(li);
      }
      updateCountdown();
      return;
    }
    hint.textContent = voiceError ? "Open Settings and choose Retry voice."
      : targets?.kind === "point" && targets.expiresAt > Date.now()
        ? "The ring marks the control. Say “click” and its name to act." : modeHint;

    const isCompletion = update.state === "done" || update.state === "error" || !!voiceError;
    if (isCompletion) {
      lastCompletion = {
        action: update.action ? `→ ${update.action}` : "",
        status: displayStatus ?? "",
        latency: update.latencyMs != null ? `${update.latencyMs} ms` : "",
      };
      action.textContent = lastCompletion.action;
      status.textContent = lastCompletion.status;
      latency.textContent = lastCompletion.latency;
      if (completionTimer != null) window.clearTimeout(completionTimer);
      completionTimer = voiceError ? null : window.setTimeout(clearCompletion, COMPLETION_LINGER_MS);
      return;
    }
    const neutralStatus = !displayStatus || /^Workflow · Step \d+$/.test(displayStatus);
    if ((update.state === "listening" || update.state === "idle") && lastCompletion && neutralStatus) {
      action.textContent = lastCompletion.action;
      status.textContent = lastCompletion.status;
      latency.textContent = lastCompletion.latency;
      return;
    }
    clearCompletion();
    action.textContent = update.action ? `→ ${update.action}` : "";
    status.textContent = displayStatus ?? "";
    latency.textContent = update.latencyMs != null ? `${update.latencyMs} ms` : "";
  }

  window.dragonOverlay.onUpdate(render);
});
})();
