import { logger } from "../logging/logger";

const VISION_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Single switch for every screen_click vision call. gpt-4o (and gpt-4o-mini before it) kept
// landing one row off on dense UI; published GUI-grounding scores explain why (gpt-4o 0.8% vs
// Gemini 3 Flash 69.1% on ScreenSpot-Pro). See DECISIONS.md 2026-09-29.
export const VISION_MODEL = "google/gemini-3-flash-preview";
const TIMEOUT_MS = 15_000; // image upload + vision inference is slower than Jev's text-only call

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface LocatedPoint {
  /** Centre of `box`, in the sent image's pixel space. */
  x: number;
  y: number;
  /** The visible text the model read on/next to the element it picked — lets the caller sanity-
   * check the point actually names the requested element before clicking it blindly (see
   * PROGRESS.md 2026-09-28: dense lists of similar rows, e.g. Slack/System Settings sidebars,
   * were landing on the wrong row entirely, not just imprecisely on the right one). */
  label: string;
  box: Box;
}
export class VisionRequestError extends Error {}

const LABEL_STOPWORDS = new Set(["the", "and", "click", "tap", "press", "button", "on", "icon", "link", "tab"]);

export function labelTokens(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter((t) => t && !LABEL_STOPWORDS.has(t));
}

/** Normalized equality after dropping filler words ("click the Send button" == "Send"). */
export function labelExact(description: string, label: string): boolean {
  const d = labelTokens(description).join(" ");
  return !!d && d === labelTokens(label).join(" ");
}

/** Loose check: does the read-back label plausibly refer to the requested description? Catches
 * wrong-row picks in dense lists; not a strict match (spoken descriptions rarely equal on-screen
 * text verbatim, e.g. "the send button" vs "Send"). Filler words and 1–2 letter tokens don't
 * count as overlap, so "click Harshit" no longer "matches" a row reading "Click" or "on". */
export function labelMatches(description: string, label: string): boolean {
  if (labelExact(description, label)) return true;
  const d = labelTokens(description).filter((t) => t.length >= 3);
  const l = labelTokens(label).filter((t) => t.length >= 3);
  if (!d.length || !l.length) return false;
  const ds = d.join(" ");
  const ls = l.join(" ");
  return ds.includes(ls) || ls.includes(ds) || d.some((t) => l.includes(t));
}

/** Gemini's native `box_2d` is [ymin, xmin, ymax, xmax] normalized to 0–1000. */
export function box2dToPixels(box2d: number[], imageWidth: number, imageHeight: number): Box {
  const [ymin, xmin, ymax, xmax] = box2d;
  return { x0: (xmin / 1000) * imageWidth, y0: (ymin / 1000) * imageHeight, x1: (xmax / 1000) * imageWidth, y1: (ymax / 1000) * imageHeight };
}

function boxIoU(a: Box, b: Box): number {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = iw * ih;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
}

/** Drops matches that are the same element reported twice (e.g. a row and its avatar): IoU > 0.5
 * with, or centre inside, a higher-ranked match's box. */
export function dedupeMatches(matches: LocatedPoint[]): LocatedPoint[] {
  // ponytail: O(n²) over ≤5 matches
  return matches.filter((p, i) =>
    !matches.slice(0, i).some((q) => boxIoU(p.box, q.box) > 0.5 || (p.x >= q.box.x0 && p.x <= q.box.x1 && p.y >= q.box.y0 && p.y <= q.box.y1))
  );
}

/**
 * Independent sanity check for a point `locateElements` returned. Crops a small region around
 * the point and asks the model to read back whatever text is actually there — no "find X"
 * framing, so it can't just repeat back the description it was given a hint about.
 *
 * This exists because `locateElements`' own `label` field turned out to be self-consistently
 * unreliable as a check: when asked to find e.g. "General", the model reliably echoes
 * `label: "General"` back even when the coordinates it also returned land on a totally
 * different row (e.g. "Network") — it's not naming the wrong row, it's failing to ground its
 * own correct answer to a pixel. Asking it to find X and asking it to verify X in the same call
 * shares that bias. A second, separately-framed call ("what text is here?") on a small enough
 * crop that only the actual element is in view is not subject to the same bias. See
 * PROGRESS.md 2026-09-28.
 */
export async function readLabelAtPoint(openRouterApiKey: string, croppedImageBase64: string): Promise<string> {
  if (!openRouterApiKey) throw new VisionRequestError("OpenRouter API key is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(VISION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "This is a small crop from a screenshot, centered on one UI element (e.g. a " +
                  "sidebar row, button, or menu item). Respond with ONLY the exact visible text " +
                  "label of that centered element, nothing else. If there is no readable text, " +
                  "respond with an empty string.",
              },
              // Crop is well under 512px, so "low" loses nothing (only affects OpenAI models).
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${croppedImageBase64}`, detail: "low" } },
            ],
          },
        ],
        temperature: 0,
        reasoning: { effort: "minimal" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VisionRequestError(`Vision model returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const label = (json.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
    logger.event("vision.read_label_at_point", { model: VISION_MODEL, label });
    return label;
  } catch (err: any) {
    if (err?.name === "AbortError") throw new VisionRequestError("Vision request timed out");
    if (err instanceof VisionRequestError) throw err;
    throw new VisionRequestError(err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
  }
}

const MAX_LOCATE_MATCHES = 5;

/**
 * Asks a vision-capable model to locate every on-screen instance of a described UI element
 * within a screenshot, not just the single best guess. Needed because dense screens can
 * legitimately contain multiple elements with the same/similar label (e.g. several people named
 * "Harshit" in a Slack sidebar's search results, or two windows each with their own "General"
 * settings pane) — asking for one point silently commits to a guess with no way to tell it apart
 * from a genuine single-match case. Returns [] if nothing matches. Each match carries its
 * bounding box (image pixels) and the box centre as the click point. See `readLabelAtPoint` for
 * why callers must independently verify each match rather than trusting the label here.
 */
export async function locateElements(
  openRouterApiKey: string,
  imageBase64: string,
  description: string,
  imageWidth: number,
  imageHeight: number
): Promise<LocatedPoint[]> {
  if (!openRouterApiKey) throw new VisionRequestError("OpenRouter API key is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(VISION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Find every UI element in this screenshot that could plausibly match the ` +
                  `description "${description}". There may be exactly one match, several ` +
                  `near-duplicate matches (e.g. multiple similarly labeled rows or repeated names), ` +
                  `or none at all. Respond with ONLY a JSON object, no other text: ` +
                  '{"matches": [{"box_2d": [ymin, xmin, ymax, xmax], "label": <string>}, ...]} ' +
                  "where box_2d is the tight bounding box of that one clickable element, normalized " +
                  "to 0-1000, and label is the exact visible text printed on or immediately next to " +
                  `that match. List at most ${MAX_LOCATE_MATCHES} matches, each a distinct element, ` +
                  'most likely first. Respond {"matches": []} if none are visible.',
              },
              {
                type: "image_url",
                // "high" forces OpenAI models to tile at full resolution (dense UI needs it);
                // ignored by Gemini.
                image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" },
              },
            ],
          },
        ],
        temperature: 0,
        reasoning: { effort: "low" },
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VisionRequestError(`Vision model returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new VisionRequestError("Vision model returned no parseable JSON");
    const parsed = JSON.parse(match[0]) as { matches?: { box_2d?: number[]; label?: string }[] };
    const matches = (parsed.matches ?? [])
      .filter((m) => Array.isArray(m.box_2d) && m.box_2d.length === 4 && m.box_2d.every((n) => typeof n === "number"))
      .slice(0, MAX_LOCATE_MATCHES);
    logger.event("vision.locate_elements", {
      model: VISION_MODEL,
      description,
      imageBytes: Math.round((imageBase64.length * 3) / 4),
      count: matches.length,
      matches: matches.map((m) => ({ box2d: m.box_2d, label: m.label ?? null })),
    });
    return matches.map((m) => {
      const box = box2dToPixels(m.box_2d!, imageWidth, imageHeight);
      return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, label: m.label ?? "", box };
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new VisionRequestError("Vision request timed out");
    if (err instanceof VisionRequestError) throw err;
    throw new VisionRequestError(err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
  }
}
