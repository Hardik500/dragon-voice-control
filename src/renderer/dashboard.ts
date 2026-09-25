interface JevChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

type JevDecisionOutcome = "pending" | "success" | "ignored" | "error" | "cancelled";

interface JevDecision {
  utteranceId: string;
  timestamp: number;
  transcript: string;
  activeApp: string | null;
  activationMode: string;
  turnEvent: string;
  provider: "jev" | "laya";
  model: string;
  sttTurnMs: number;
  sttToDecisionMs: number;
  jevMs: number;
  decisionMs: number;
  outcome: JevDecisionOutcome;
  outcomeDetail: string | null;
  resolvedAction: string | null;
  executionMs: number | null;
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

const DETERMINISTIC_CONTROL_DETAIL = "Handled by deterministic local control";
const OUTCOME_PRIORITY: Record<JevDecisionOutcome, number> = {
  success: 5,
  error: 4,
  ignored: 3,
  cancelled: 2,
  pending: 1,
};

/** The dashboard shows one decision per utterance, not one row per provider HTTP response.
 * EagerEndOfTurn and EndOfTurn can both produce traces for the same utterance. */
function canonicalDecisions(decisions: JevDecision[]): JevDecision[] {
  const byUtterance = new Map<string, JevDecision>();
  for (const decision of decisions) {
    const previous = byUtterance.get(decision.utteranceId);
    if (!previous || compareDecision(decision, previous) > 0) {
      byUtterance.set(decision.utteranceId, decision);
    }
  }
  return Array.from(byUtterance.values()).sort((a, b) => b.timestamp - a.timestamp);
}

function compareDecision(a: JevDecision, b: JevDecision): number {
  return OUTCOME_PRIORITY[a.outcome] - OUTCOME_PRIORITY[b.outcome]
    || (a.turnEvent === "EndOfTurn" ? 1 : 0) - (b.turnEvent === "EndOfTurn" ? 1 : 0)
    || a.timestamp - b.timestamp;
}

function visibleDecisions(decisions: JevDecision[]): JevDecision[] {
  return canonicalDecisions(decisions).filter(
    (decision) => decision.outcomeDetail !== DETERMINISTIC_CONTROL_DETAIL
  );
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

function outcomeLabel(outcome: JevDecisionOutcome): string {
  if (outcome === "success") return "Executed";
  if (outcome === "ignored") return "Ignored";
  if (outcome === "error") return "Error";
  if (outcome === "cancelled") return "Cancelled";
  return "Awaiting action";
}

function renderOutcome(decision: JevDecision) {
  setText("resolvedAction", decision.resolvedAction || "Waiting for a resolved action");
  const status = byId("outcomeStatus");
  status.className = `outcome-status outcome-${decision.outcome}`;
  status.textContent = outcomeLabel(decision.outcome);
  status.title = decision.outcomeDetail ?? "";
  setText("executionLatency", formatMs(decision.executionMs ?? undefined));
}

function renderChoice(name: "intent" | "target" | "direction", choice: JevChoice, provider: string) {
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
  byId<HTMLElement>(`${name}Value`).title = `${label} selected by ${provider.toUpperCase()}`;
}

function renderHistory(decisions: JevDecision[]) {
  const history = byId<HTMLOListElement>("history");
  history.innerHTML = "";
  if (decisions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No decision-provider calls recorded in this session.";
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
    const jevTarget = document.createElement("span");
    jevTarget.className = "history-jev-target";
    jevTarget.textContent = `${decision.provider.toUpperCase()} ${decision.choices.target.choice} · ${formatMs(decision.jevMs)}`;
    const resolvedAction = document.createElement("span");
    resolvedAction.className = "history-resolved-action";
    resolvedAction.textContent = decision.resolvedAction ? `Resolved ${decision.resolvedAction}` : "No resolved action";
    target.append(jevTarget, resolvedAction);
    const outcome = document.createElement("span");
    outcome.className = `history-outcome history-${decision.outcome}`;
    outcome.textContent = outcomeLabel(decision.outcome);
    outcome.title = decision.outcomeDetail ?? "";
    item.append(time, transcript, intent, target, outcome);
    history.appendChild(item);
  }
}

function renderExceptions(decisions: JevDecision[]) {
  const exceptions = byId<HTMLOListElement>("exceptions");
  exceptions.innerHTML = "";
  const notable = decisions.filter((decision) => decision.outcome === "ignored" || decision.outcome === "error" || decision.outcome === "cancelled");
  if (notable.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No ignored or failed decisions in this session.";
    exceptions.appendChild(empty);
    return;
  }

  for (const decision of notable.slice(0, 6)) {
    const item = document.createElement("li");
    const transcript = document.createElement("span");
    transcript.className = "exception-transcript";
    transcript.textContent = decision.transcript;
    const reason = document.createElement("span");
    reason.className = "exception-reason";
    reason.textContent = decision.outcomeDetail || outcomeLabel(decision.outcome);
    item.append(transcript, reason);
    exceptions.appendChild(item);
  }
}

function renderDashboard(data: DashboardResponse) {
  const decisions = visibleDecisions(data.decisions);
  const latest = decisions[0];
  const executed = decisions.filter((decision) => decision.outcome === "success").length;
  const ignored = decisions.filter((decision) => decision.outcome === "ignored").length;
  const errors = decisions.filter((decision) => decision.outcome === "error").length;
  setText("decisionCount", String(decisions.length));
  setText("executedCount", String(executed));
  setText("ignoredCount", String(ignored));
  setText("errorCount", String(errors));
  setText("apiUrl", "/api/decisions");

  if (!latest) {
    setText("sttLatency", "—");
    setText("jevLatency", "—");
    setText("decisionLatency", "—");
    setText("decisionPreparation", "—");
    setText("dragonState", data.status?.listening ? "Listening" : "Idle");
    setText("latestTime", "Waiting for a command");
    setText("latestContext", "No transcript yet");
    setText("latestModel", "Decision provider");
    setText("latestQuote", "Speak a command to see the decision surface");
    setText("resolvedAction", "—");
    setText("outcomeStatus", "Awaiting action");
    setText("executionLatency", "—");
    renderHistory(decisions);
    renderExceptions(decisions);
    return;
  }

  setText("sttLatency", formatMs(latest.sttTurnMs));
  setText("jevLatency", formatMs(latest.jevMs));
  setText("decisionLatency", formatMs(latest.sttToDecisionMs));
  setText("jevLatency", formatMs(latest.jevMs));
  setText("decisionPreparation", formatMs(latest.decisionMs));
  setText("dragonState", data.status?.listening ? "Listening" : "Idle");
  setText("latestTime", new Date(latest.timestamp).toLocaleTimeString());
  setText("latestContext", `${latest.provider.toUpperCase()} · ${latest.model || "unknown model"} · ${latest.activeApp || "Unknown app"} · ${latest.activationMode.replace(/_/g, " ")} · ${latest.turnEvent}`);
  setText("latestModel", latest.model || "Decision provider");
  setText("latestQuote", latest.transcript);
  renderOutcome(latest);
  renderChoice("intent", latest.choices.intent, latest.provider);
  renderChoice("target", latest.choices.target, latest.provider);
  renderChoice("direction", latest.choices.direction, latest.provider);
  renderHistory(decisions);
  renderExceptions(decisions);
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
