import { logger } from "../logging/logger";
import { DecisionProvider } from "../types/settings";
import { JevQuestionSet } from "./questions";

const JEV_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
const JEV_MODEL = "jev-latest";
const LAYA_PATH = "/v1/systemone";
const TIMEOUT_MS = 6000;
const HEALTH_TIMEOUT_MS = 2500;

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevAnswers {
  addressed?: JevNoulAnswer;
  complete: JevNoulAnswer;
  intent: JevChoiceAnswer;
  target: JevChoiceAnswer;
  direction: JevChoiceAnswer;
}

export interface DecisionProviderConfig {
  provider: DecisionProvider;
  openRouterApiKey: string;
  layaBaseUrl: string;
  layaModel: string;
}

export interface DecisionResult {
  provider: DecisionProvider;
  answers: JevAnswers;
  model: string;
  timingMs: number;
}

export interface ProviderHealth {
  ok: boolean;
  provider: DecisionProvider;
  model: string | null;
  message: string;
}

export class DecisionRequestError extends Error {}
export class DecisionCancelledError extends Error {}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function assertLocalLayaUrl(value: string): string {
  const baseUrl = normalizeBaseUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new DecisionRequestError("Laya base URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new DecisionRequestError("Laya base URL must be a local http:// address");
  }
  return baseUrl;
}

function providerRequest(config: DecisionProviderConfig): { endpoint: string; model: string; headers: Record<string, string> } {
  if (config.provider === "jev") {
    if (!config.openRouterApiKey) {
      throw new DecisionRequestError("OpenRouter API key is not configured for the Jev provider");
    }
    return {
      endpoint: JEV_ENDPOINT,
      model: JEV_MODEL,
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
      },
    };
  }

  return {
    endpoint: `${assertLocalLayaUrl(config.layaBaseUrl)}${LAYA_PATH}`,
    model: config.layaModel.trim() || "laya",
    headers: { "Content-Type": "application/json" },
  };
}

function withTimeout(signal: AbortSignal, timeoutMs: number): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Calls a System One-compatible decision provider. Jev is hosted by OpenRouter; Laya is
 * expected to run locally through laya-server. The question/answer contract is shared.
 */
export async function callDecisionProvider(
  config: DecisionProviderConfig,
  state: string,
  questions: JevQuestionSet,
  signal: AbortSignal
): Promise<DecisionResult> {
  const request = providerRequest(config);
  const started = Date.now();
  const timeout = withTimeout(signal, TIMEOUT_MS);

  try {
    const res = await fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ model: request.model, state, questions }),
      signal: timeout.controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const providerLabel = config.provider === "jev" ? "OpenRouter Jev" : "Laya";
      throw new DecisionRequestError(`${providerLabel} returned ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as { model?: string; answers: JevAnswers };
    if (!json.answers?.intent || !json.answers.target || !json.answers.direction || !json.answers.complete) {
      throw new DecisionRequestError(`${config.provider} returned an incomplete System One response`);
    }
    const timingMs = Date.now() - started;
    const model = json.model || request.model;
    logger.event("decision.response", {
      provider: config.provider,
      timingMs,
      model,
      intent: json.answers.intent.choice,
      intentConfidence: json.answers.intent.confidence,
      target: json.answers.target.choice,
      targetConfidence: json.answers.target.confidence,
      direction: json.answers.direction.choice,
      directionConfidence: json.answers.direction.confidence,
      intentProbabilities: json.answers.intent.probabilities,
      targetProbabilities: json.answers.target.probabilities,
      directionProbabilities: json.answers.direction.probabilities,
      complete: json.answers.complete.noul,
      addressed: json.answers.addressed?.noul,
    });
    return { provider: config.provider, answers: json.answers, model, timingMs };
  } catch (err: any) {
    if (signal.aborted) {
      throw new DecisionCancelledError("Decision request cancelled or superseded");
    }
    if (err?.name === "AbortError") {
      throw new DecisionRequestError(`${config.provider} decision request timed out`);
    }
    throw err;
  } finally {
    timeout.cleanup();
  }
}

/** Lightweight connectivity check used by Settings; Laya is intentionally local-only. */
export async function checkDecisionProvider(config: DecisionProviderConfig): Promise<ProviderHealth> {
  if (config.provider === "jev") {
    return {
      ok: Boolean(config.openRouterApiKey),
      provider: "jev",
      model: JEV_MODEL,
      message: config.openRouterApiKey ? "Jev is configured" : "Jev needs an OpenRouter API key",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const baseUrl = assertLocalLayaUrl(config.layaBaseUrl);
    const res = await fetch(`${baseUrl}/`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, provider: "laya", model: null, message: `Laya server returned HTTP ${res.status}` };
    const json = (await res.json().catch(() => ({}))) as { model?: string; status?: string };
    const model = json.model || config.layaModel || "laya";
    return {
      ok: json.status === "ok" || Boolean(json.model),
      provider: "laya",
      model,
      message: `Laya server ready (${model})`,
    };
  } catch (err: any) {
    const message = err?.name === "AbortError" ? "Laya server health check timed out" : err instanceof Error ? err.message : String(err);
    return { ok: false, provider: "laya", model: null, message };
  } finally {
    clearTimeout(timer);
  }
}
