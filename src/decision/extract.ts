import {
  appAliasKeys,
  appAliasLabel,
  KEY_PHRASE_NAMES,
  KNOWN_WEBSITES,
  LOCATION_NAMES,
  SETTINGS_PANE_NAMES,
  SITE_SEARCH_TEMPLATES,
} from "../commands/registry";
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

/** Vague quantifiers used in "delete the last few words" style phrasing. */
const VAGUE_COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1,
  couple: 2, "couple of": 2,
  few: 3, "a few": 3, several: 4,
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
  for (const aliasKey of appAliasKeys()) {
    // Word-boundary match, not a plain substring — a bare `.includes()` check let "mail"
    // spuriously match inside "Gmail", sending "open Gmail" to the Mail app instead of
    // gmail.com. Aliases can be multi-word ("google chrome"), so escape regex metacharacters.
    const escaped = aliasKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(lowerT)) {
      const label = appAliasLabel(aliasKey);
      if (seen.has(label)) continue;
      seen.add(label);
      candidates.push({
        id: `app:${label}`,
        label,
        appAlias: aliasKey,
        score: aliasKey.length / lowerT.length,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 4);
}

export function extractDictatedText(transcript: string): string | null {
  // "type in X" / "type out X" are common phrasings where "in"/"out" is filler, not part of
  // the dictated content — without stripping it, "Type in hello" would type "in hello".
  const m = transcript.match(/\b(?:type|enter|write|dictate)(?:\s+(?:in|out|that))?\s+(.+)$/i);
  if (m && m[1].trim().length > 0) return m[1].trim();
  return null;
}

function cleanSearchQuery(query: string): string {
  return query
    .replace(/\s+on\s+(?:google(?:\s+dot\s+com)?|chrome)\s*[.!?]*$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

export function extractSearchQuery(transcript: string): string | null {
  // Order matters: more specific patterns (with a trailing "chat"/"channel" to strip) first,
  // so e.g. "go to Anushri's chat" yields "Anushri" rather than "Anushri's chat". These extra
  // "go to X" / "find X" patterns exist for `search_in_app` (Slack/Notion/etc.'s quick-open
  // convention is naturally phrased as navigation, not "search for"), not just chrome_search.
  const patterns = [
    /\bsearch(?:\s+(?:for|the\s+web\s+for))?\s+(?:for\s+)?(.+)$/i,
    /\bgoogle\s+(.+)$/i,
    /\blook\s+up\s+(.+)$/i,
    /\bgo\s+to\s+(.+?)(?:'s)?\s+(?:chat|channel|conversation|dm|profile)\b.*$/i,
    /\b(?:open|click\s+on)\s+(.+?)(?:'s)?\s+(?:chat|channel|conversation|dm)\b.*$/i,
    /\bgo\s+to\s+(.+)$/i,
    /\bfind\s+(.+)$/i,
  ];
  for (const p of patterns) {
    const m = transcript.match(p);
    if (m && m[1].trim().length > 0) {
      const query = cleanSearchQuery(m[1]);
      if (query.length > 0) return query;
    }
  }
  return null;
}

/** Deepgram transcribes spoken "dot" as the literal word "dot", not a period (there's no
 * numerals/punctuation-formatting option that turns "google dot com" into "google.com").
 * Normalize that pattern before running URL regexes, but only for URL extraction — dictated
 * text ("type ... dot ...") must stay verbatim. */
function normalizeSpokenDomain(transcript: string): string {
  return transcript.replace(
    /\b([a-z0-9-]+)\s+dot\s+(com|org|net|io|dev|co|gov|edu|app|ai|uk|two|to)\b/gi,
    (_match, base: string, tld: string) => `${base}.${tld.toLowerCase() === "two" ? "to" : tld.toLowerCase()}`
  );
}

export function extractUrl(transcript: string): string | null {
  const normalized = normalizeSpokenDomain(transcript);

  const explicit = normalized.match(/\bhttps?:\/\/\S+/i);
  if (explicit) return explicit[0];

  const domainLike = normalized.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|to|co|gov|edu|app|ai|uk))\b/i);
  if (domainLike) return `https://${domainLike[1]}`;

  const lowerT = lower(normalized);
  // Longer keys first ("youtube music" before "youtube") so the more specific site wins.
  const sites = Object.entries(KNOWN_WEBSITES).sort((a, b) => b[0].length - a[0].length);
  for (const [site, url] of sites) {
    if (new RegExp(`\\b${site}\\b`).test(lowerT) && /\b(go to|open|navigate to|visit|search for)\b/.test(lowerT)) {
      return url;
    }
  }
  return null;
}

/** When Chrome is already on a known site, route "search for X" to that site's own search
 * instead of a generic Google search — this is how "open youtube music" then "search for
 * <song>" plays the right thing without any multi-step planning (see registry-common.ts). */
export function computeSiteSearchUrl(query: string | null, page: BrowserPageState | null): string | null {
  if (!query || !page || !page.connected || !page.url) return null;
  let hostname: string;
  try {
    hostname = new URL(page.url).hostname;
  } catch {
    return null;
  }
  for (const template of SITE_SEARCH_TEMPLATES) {
    if (hostname.includes(template.hostnameIncludes)) return template.buildUrl(query);
  }
  return null;
}

/** Raw "control c" / "ctrl v" / "command z" phrasing -> the matching semantic action name.
 * Users say the literal key combo as often as the semantic name ("press control z" as often
 * as "undo"), but only semantic names are in KEY_PHRASE_NAMES. */
const MODIFIER_LETTER_TO_ACTION: Record<string, string> = {
  c: "copy", v: "paste", x: "cut", a: "select all", z: "undo", y: "redo",
  s: "save", f: "find", t: "new tab", w: "close tab", q: "quit", r: "refresh",
};

export function isStandaloneKeyboardCommand(transcript: string, keyName: string | null): boolean {
  if (!keyName) return false;
  const normalized = lower(transcript).replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  const key = keyName.toLowerCase();
  if (normalized === key) return true;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^(?:please\\s+)?(?:press|hit|tap|key)\\s+${escapedKey}$`).test(normalized)) return true;
  // The semantic key name is "copy"/"undo"/etc., but the user may say the literal combo.
  return /^(?:please\s+)?(?:(?:press|hit|tap|key)\s+)?(?:control|ctrl|command|cmd)(?:\s+|\+)\s*([a-z])$/.test(normalized);
}

export function extractKeyName(transcript: string): string | null {
  const lowerT = lower(transcript);
  let best: string | null = null;
  for (const phrase of KEY_PHRASE_NAMES) {
    if (new RegExp(`\\b${phrase}\\b`).test(lowerT)) {
      if (!best || phrase.length > best.length) best = phrase;
    }
  }
  if (best) return best;
  const modifierMatch = lowerT.match(/\b(?:control|ctrl|command|cmd)\s+([a-z])\b/);
  if (modifierMatch) {
    const action = MODIFIER_LETTER_TO_ACTION[modifierMatch[1]];
    if (action) return action;
  }
  return null;
}

export function extractSettingsPane(transcript: string): string | null {
  const lowerT = lower(transcript);
  for (const pane of SETTINGS_PANE_NAMES) {
    if (new RegExp(`\\b${pane}\\b`).test(lowerT)) return pane;
  }
  return null;
}

export function extractFinderLocation(transcript: string): string | null {
  const lowerT = lower(transcript);
  for (const loc of LOCATION_NAMES) {
    if (new RegExp(`\\b${loc}\\b`).test(lowerT)) return loc;
  }
  return null;
}

/** "delete the last 3 words" / "delete the last few words" / "delete the last word" -> a count. */
export function extractDeleteWordCount(transcript: string): number | null {
  const lowerT = lower(transcript);
  const m = lowerT.match(/\blast\s+([a-z0-9]+(?:\s+[a-z]+)?)\s+words?\b/);
  if (m) {
    const token = m[1].trim();
    const digit = parseInt(token, 10);
    if (!isNaN(digit)) return digit;
    if (token in WORD_NUMBERS) return WORD_NUMBERS[token];
    if (token in VAGUE_COUNT_WORDS) return VAGUE_COUNT_WORDS[token];
    return 3; // unrecognized quantifier word; a safe, small default
  }
  if (/\blast\s+word\b/.test(lowerT)) return 1;
  return null;
}

/** "replace X with Y" -> [X, Y], both verbatim. */
export function extractReplacePair(transcript: string): [string, string] | null {
  const m = transcript.match(/\breplace\s+(.+?)\s+with\s+(.+)$/i);
  if (m && m[1].trim().length > 0 && m[2].trim().length > 0) {
    return [m[1].trim(), m[2].trim()];
  }
  return null;
}

/**
 * Deliberately permissive: only ever consulted while a dictation session is active (there's
 * nothing meaningful to delete otherwise), so a generous match on any delete/remove/clear/undo
 * phrasing is safe. Order matters — "words" is checked before the generic "all" bucket so
 * "delete the last 3 words" doesn't get swallowed by a bare "delete".
 */
export function extractDeleteScope(transcript: string): { scope: "words" | "last_dictation" | "all"; count?: number } | null {
  const lowerT = lower(transcript).replace(/[.!?]+$/, "");
  if (!/^(?:delete|remove|clear|undo)\b/.test(lowerT)) return null;

  if (/\blast\b/.test(lowerT) && /\bwords?\b/.test(lowerT)) {
    const count = extractDeleteWordCount(transcript) ?? 3;
    return { scope: "words", count };
  }
  if (/\b(everything|all|the\s+paragraph|content|text|note)\b/.test(lowerT)) {
    return { scope: "all" };
  }
  // Bare "delete"/"remove"/"undo"/"clear", optionally with a trailing "that"/"it"/"this".
  return { scope: "last_dictation" };
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
  const searchQuery = extractSearchQuery(transcript);
  return {
    appCandidates: findAppCandidates(transcript),
    dictatedText: extractDictatedText(transcript),
    url: extractUrl(transcript),
    siteSearchUrl: computeSiteSearchUrl(searchQuery, page),
    searchQuery,
    number: extractNumber(transcript),
    keyName: extractKeyName(transcript),
    browserElementCandidates: findBrowserElementCandidates(transcript, page),
    settingsPane: extractSettingsPane(transcript),
    finderLocation: extractFinderLocation(transcript),
    deleteWordCount: extractDeleteWordCount(transcript),
    replacePair: extractReplacePair(transcript),
  };
}
