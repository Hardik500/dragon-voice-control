import { APP_ALIASES, FINDER_LOCATIONS, KEY_PHRASES, KNOWN_WEBSITES, SETTINGS_PANES } from "../commands/registry";
import { AppCandidate, BrowserElementCandidate, BrowserPageState, ExtractedPayload } from "../types/pipeline";

/**
 * Deterministic, code-only extraction of free-form payload spans from a
 * transcript. Jev never invents these values; it only selects among the
 * candidates produced here (see decision/questions.ts).
 */

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function lower(s: string): string {
  return s.toLowerCase().trim();
}

export function extractNumber(transcript: string): number | null {
  const digitMatch = transcript.match(/\b(\d{1,3})\b/);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  const lowerT = lower(transcript);
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`).test(lowerT)) return value;
  }
  return null;
}

export function findAppCandidates(transcript: string): AppCandidate[] {
  const lowerT = lower(transcript);
  const seen = new Set<string>();
  const candidates: AppCandidate[] = [];
  for (const [alias, appName] of Object.entries(APP_ALIASES)) {
    if (lowerT.includes(alias)) {
      if (seen.has(appName)) continue;
      seen.add(appName);
      candidates.push({
        id: `app:${appName}`,
        label: appName,
        appName,
        score: alias.length / lowerT.length,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 4);
}

export function extractDictatedText(transcript: string): string | null {
  const m = transcript.match(/\b(?:type|enter|write|dictate)\s+(.+)$/i);
  if (m && m[1].trim().length > 0) return m[1].trim();
  return null;
}

export function extractSearchQuery(transcript: string): string | null {
  const patterns = [
    /\bsearch(?:\s+(?:for|the\s+web\s+for))?\s+(?:for\s+)?(.+)$/i,
    /\bgoogle\s+(.+)$/i,
    /\blook\s+up\s+(.+)$/i,
  ];
  for (const p of patterns) {
    const m = transcript.match(p);
    if (m && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}

/** Deepgram transcribes spoken "dot" as the literal word "dot", not a period (there's no
 * numerals/punctuation-formatting option that turns "google dot com" into "google.com").
 * Normalize that pattern before running URL regexes, but only for URL extraction — dictated
 * text ("type ... dot ...") must stay verbatim. */
function normalizeSpokenDomain(transcript: string): string {
  return transcript.replace(
    /\b([a-z0-9-]+)\s+dot\s+(com|org|net|io|dev|co|gov|edu|app|ai|uk)\b/gi,
    "$1.$2"
  );
}

export function extractUrl(transcript: string): string | null {
  const normalized = normalizeSpokenDomain(transcript);

  const explicit = normalized.match(/\bhttps?:\/\/\S+/i);
  if (explicit) return explicit[0];

  const domainLike = normalized.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|co|gov|edu|app|ai|uk))\b/i);
  if (domainLike) return `https://${domainLike[1]}`;

  const lowerT = lower(normalized);
  for (const [site, url] of Object.entries(KNOWN_WEBSITES)) {
    if (new RegExp(`\\b${site}\\b`).test(lowerT) && /\b(go to|open|navigate to|visit|search for)\b/.test(lowerT)) {
      return url;
    }
  }
  return null;
}

export function extractKeyName(transcript: string): string | null {
  const lowerT = lower(transcript);
  let best: string | null = null;
  for (const phrase of Object.keys(KEY_PHRASES)) {
    if (new RegExp(`\\b${phrase}\\b`).test(lowerT)) {
      if (!best || phrase.length > best.length) best = phrase;
    }
  }
  return best;
}

export function extractSettingsPane(transcript: string): string | null {
  const lowerT = lower(transcript);
  for (const pane of Object.keys(SETTINGS_PANES)) {
    if (new RegExp(`\\b${pane}\\b`).test(lowerT)) return pane;
  }
  return null;
}

export function extractFinderLocation(transcript: string): string | null {
  const lowerT = lower(transcript);
  for (const loc of Object.keys(FINDER_LOCATIONS)) {
    if (new RegExp(`\\b${loc}\\b`).test(lowerT)) return loc;
  }
  return null;
}

/** Simple token-overlap similarity, cheap and adequate for short UI labels. */
function similarity(a: string, b: string): number {
  const at = new Set(lower(a).split(/\W+/).filter(Boolean));
  const bt = new Set(lower(b).split(/\W+/).filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap / Math.max(at.size, bt.size);
}

export function findBrowserElementCandidates(
  transcript: string,
  page: BrowserPageState | null
): BrowserElementCandidate[] {
  if (!page || !page.connected || page.elements.length === 0) return [];
  const scored = page.elements
    .map((el) => ({ ...el, score: similarity(transcript, el.text) }))
    .filter((el) => el.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

export function extractPayload(transcript: string, page: BrowserPageState | null): ExtractedPayload {
  return {
    appCandidates: findAppCandidates(transcript),
    dictatedText: extractDictatedText(transcript),
    url: extractUrl(transcript),
    searchQuery: extractSearchQuery(transcript),
    number: extractNumber(transcript),
    keyName: extractKeyName(transcript),
    browserElementCandidates: findBrowserElementCandidates(transcript, page),
    settingsPane: extractSettingsPane(transcript),
    finderLocation: extractFinderLocation(transcript),
  };
}
