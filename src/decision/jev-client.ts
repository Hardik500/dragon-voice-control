import { logger } from "../logging/logger";
import { JevQuestionSet } from "./questions";

const ENDPOINT = "https://openrouter.ai/api/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 6000;

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

export interface JevResult {
  answers: JevAnswers;
  model: string;
  timingMs: number;
}

export class JevRequestError extends Error {}
export class JevCancelledError extends Error {}

/**
 * Calls Jev via OpenRouter's System One API. Caller supplies an AbortSignal
 * for stale-request cancellation (see main/pipeline.ts).
 */
export async function callJev(
  apiKey: string,
  state: string,
  questions: JevQuestionSet,
  signal: AbortSignal
): Promise<JevResult> {
  if (!apiKey) throw new JevRequestError("OpenRouter API key is not configured");

  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JevRequestError(`OpenRouter Decisions API returned ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as { model: string; answers: JevAnswers };
    const timingMs = Date.now() - started;
    logger.event("jev.response", {
      timingMs,
      model: json.model,
      intent: json.answers.intent?.choice,
      intentConfidence: json.answers.intent?.confidence,
      target: json.answers.target?.choice,
      direction: json.answers.direction?.choice,
      complete: json.answers.complete?.noul,
      addressed: json.answers.addressed?.noul,
    });
    return { answers: json.answers, model: json.model, timingMs };
  } catch (err: any) {
    if (signal.aborted || err?.name === "AbortError") {
      throw new JevCancelledError("Jev request cancelled or superseded");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}
