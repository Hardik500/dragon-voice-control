interface JevChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevDecision {
  timestamp: number;
  transcript: string;
  activeApp: string | null;
  activationMode: string;
  turnEvent: string;
  model: string;
  sttTurnMs: number;
  sttToDecisionMs: number;
  jevMs: number;
  decisionMs: number;
  complete: number;
  addressed: number | null;
  choices: {
    intent: JevChoice;
    target: JevChoice;
    direction: JevChoice;
  };
}

interface DashboardResponse {
  generatedAt: number;
  decisions: JevDecision[];
  status: Record<string, unknown>;
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function formatProbability(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function formatMs(value: number | undefined): string {
  return Number.isFinite(value) ? `${Math.round(value!)} ms` : "—";
}

function setText(id: string, value: string) {
  byId(id).textContent = value;
}

function renderChoice(name: "intent" | "target" | "direction", choice: JevChoice) {
  const label = name[0].toUpperCase() + name.slice(1);
  setText(`${name}Value`, choice.choice);
  setText(`${name}Confidence`, formatProbability(choice.confidence));
  byId(`${name}Bar`).style.width = `${Math.max(0, Math.min(100, choice.confidence * 100))}%`;
  const alternatives = Object.entries(choice.probabilities ?? {})
    .filter(([candidate]) => candidate !== choice.choice)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([candidate, probability]) => `${candidate} ${formatProbability(Number(probability))}`)
    .join("  ·  ");
  setText(`${name}Alternatives`, alternatives || "No alternatives reported");
  byId<HTMLElement>(`${name}Value`).title = `${label} selected by Jev`;
}

function renderHistory(decisions: JevDecision[]) {
  const history = byId<HTMLOListElement>("history");
  history.innerHTML = "";
  if (decisions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No Jev calls recorded in this session.";
    history.appendChild(empty);
    return;
  }

  for (const decision of decisions.slice(0, 25)) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(decision.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const transcript = document.createElement("span");
    transcript.className = "history-transcript";
    transcript.textContent = decision.transcript;
    const intent = document.createElement("span");
    intent.className = "history-intent";
    intent.textContent = decision.choices.intent.choice;
    const target = document.createElement("span");
    target.className = "history-target";
    target.textContent = `${decision.choices.target.choice} · ${formatMs(decision.jevMs)}`;
    item.append(time, transcript, intent, target);
    history.appendChild(item);
  }
}

function renderDashboard(data: DashboardResponse) {
  const latest = data.decisions[0];
  setText("decisionCount", String(data.decisions.length));
  setText("apiUrl", "/api/decisions");

  if (!latest) {
    setText("latestConfidence", "—");
    setText("sttLatency", "—");
    setText("jevLatency", "—");
    setText("decisionLatency", "—");
    setText("decisionPreparation", "—");
    setText("jevInsideDecision", "—");
    setText("dragonState", data.status?.listening ? "Listening" : "Idle");
    setText("latestTime", "Waiting for a command");
    setText("latestContext", "No transcript yet");
    setText("latestModel", "Jev");
    setText("latestQuote", "Speak a command to see the decision surface");
    renderHistory(data.decisions);
    return;
  }

  setText("latestConfidence", formatProbability(latest.choices.intent.confidence));
  setText("sttLatency", formatMs(latest.sttTurnMs));
  setText("jevLatency", formatMs(latest.jevMs));
  setText("decisionLatency", formatMs(latest.sttToDecisionMs));
  setText("decisionPreparation", formatMs(latest.decisionMs));
  setText("jevInsideDecision", formatMs(latest.jevMs));
  setText("dragonState", data.status?.listening ? "Listening" : "Idle");
  setText("latestTime", new Date(latest.timestamp).toLocaleTimeString());
  setText("latestContext", `${latest.activeApp || "Unknown app"} · ${latest.activationMode.replace(/_/g, " ")} · ${latest.turnEvent}`);
  setText("latestModel", latest.model || "Jev");
  setText("latestQuote", latest.transcript);
  renderChoice("intent", latest.choices.intent);
  renderChoice("target", latest.choices.target);
  renderChoice("direction", latest.choices.direction);
  renderHistory(data.decisions);
}

async function refresh() {
  try {
    const response = await fetch("/api/decisions", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as DashboardResponse;
    renderDashboard(data);
    setText("connectionText", "Live · local Dragon");
  } catch (error) {
    setText("connectionText", "Waiting for Dragon to reconnect");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  refresh();
  window.setInterval(refresh, 1500);
});
