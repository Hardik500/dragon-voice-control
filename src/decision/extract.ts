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
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Vague quantifiers used in "delete the last few words" style phrasing. */
const VAGUE_COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1,
  couple: 2, "couple of": 2, "a couple": 2, "a couple of": 2,
  few: 3, "a few": 3, several: 4,
};

function lower(s: string): string {
  return s.toLowerCase().trim();
}

export function extractNumber(transcript: string): number | null {
  const digit = transcript.match(/(?:^|[^\w.])(-?\d+(?:\.\d+)?)(?![\w.])/);
  if (digit) { const n = Number(digit[1]); return Number.isFinite(n) ? n : null; }
  const words = lower(transcript).replace(/-/g, " ").split(/\W+/);
  let total = 0, group = 0, started = false;
  for (const word of words) {
    if (word === "and" && started) continue;
    if (word in WORD_NUMBERS) { group += WORD_NUMBERS[word]; started = true; }
    else if (word === "hundred") { group = (group || 1) * 100; started = true; }
    else if (word === "thousand") { total += (group || 1) * 1000; group = 0; started = true; }
    else if (started) break;
  }
  return started ? total + group : null;
}

export function findAppCandidates(transcript: string): AppCandidate[] {
  const lowerT = lower(transcript);
  const seen = new Set<string>();
  const candidates: AppCandidate[] = [];
  for (const aliasKey of appAliasKeys().sort((a,b) => b.length - a.length)) {
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

/** "click/tap [on] [the] X" -> X. Deliberately excludes "press" (ambiguous with press_key,
 * e.g. "press enter"). Used for vision-based clicking outside the Chrome DOM path. */
export function extractClickTarget(transcript: string): string | null {
  const preview = extractScreenPreviewTarget(transcript);
  if (preview) return preview;
  const m = transcript.match(/\b(?:click|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)\s*[.!?]*$/i);
  if (m && m[1].trim().length > 0) return m[1].trim();
  return extractImplicitClickTarget(transcript);
}

/** Explicit screen-target preview only; this never requests a screen description or answer. */
export function extractScreenPreviewTarget(transcript: string): string | null {
  const m = transcript.match(/^\s*(?:please\s+)?(?:point\s+to|show\s+me|highlight)\s+(?:the\s+)?(.+?)\s*[.!?]*$/i);
  const target = m?.[1].trim();
  return target && /[\p{L}\p{N}]/u.test(target) ? target : null;
}

/** Implicit UI-control phrasing: "select Rose", "change to Agave", "turn on dark mode".
 * Deliberately excludes "go to"/"switch to" (app launch / search_in_app own those) and
 * "select all" (a key command). Anchored at the start so mid-sentence uses don't match. */
const IMPLICIT_CLICK_RE = /^\s*(?:please\s+)?(?:select|choose|pick|change\s+to|set\s+to|turn\s+on|turn\s+off|toggle)\s+(?:the\s+)?(.+?)\s*[.!?]*$/i;
export function extractImplicitClickTarget(transcript: string): string | null {
  const m = transcript.match(IMPLICIT_CLICK_RE);
  const target = m?.[1].trim();
  if (!target || /^(?:all|everything|text)$/i.test(target)) return null;
  return target;
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
  return transcript.replace(/\s+dot\s+/gi, ".").replace(/\.two\b/gi, ".to");
}

export function extractWorkflowSteps(transcript: string): string[] | null {
  const steps = transcript
    .split(/\s*(?:,|;|\bthen\b)\s*/i)
    .map((step) => step.replace(/^and\s+/i, "").trim())
    .filter(Boolean);
  const commandStart = /^(?:please\s+)?(?:open|launch|start|close|minimize|maximize|fullscreen|press|hit|tap|type|search|click|go\s+to|new\s+tab|switch\s+to|scroll|back|forward|reload|refresh|volume|play|pause|next|previous|undo|redo|copy|paste|save|find)\b/i;
  if (steps.length < 2 || !steps.every((step) => commandStart.test(step))) return null;
  return steps;
}

export interface ExtractedUrl {
  url: string | null;
  /** True when the URL came from the `KNOWN_WEBSITES` keyword heuristic rather than from a
   * domain the user actually spoke ("reddit dot com", "https://…").
   *
   * This distinction matters because a keyword hit is a substring match, not a navigation
   * target: "open google chrome" contains the `google` entry, so a heuristic-only reading
   * navigated Chrome to google.com instead of focusing Chrome (observed in real logs on
   * 2026-09-25). An explicitly spoken domain stays authoritative, so "open right.com on
   * chrome" still navigates rather than re-activating Chrome. */
  isHeuristic: boolean;
}

function cleanUrlToken(token: string): string {
  let result = token.replace(/[.,!;]+$/, "");
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  // Remove only unmatched sentence wrappers, retaining balanced URL path delimiters.
  while (pairs[result.slice(-1)]) {
    const close = result.slice(-1), open = pairs[close];
    if (result.split(close).length <= result.split(open).length) break;
    result = result.slice(0, -1);
  }
  return result;
}

export function extractUrl(transcript: string): ExtractedUrl {
  const normalized = normalizeSpokenDomain(transcript);
  const explicit = normalized.match(/\bhttps?:\/\/[^\s<>"']+/i);
  const bare = normalized.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|to|co|gov|edu|app|ai|uk|au|de|fr|in|jp|ca|us|me|gg|tv|xyz|online|site|tech|info|cloud|blog|store|design|work|live)(?![a-z0-9-]|\.+[a-z0-9-])(?::\d+)?(?:[/?#][^\s<>"']*)?/i);
  const token = explicit ? cleanUrlToken(explicit[0]) : bare ? "https://" + cleanUrlToken(bare[0]) : null;
  if (token) {
    try {
      const url = new URL(token);
      if (url.hostname && (url.protocol === "https:" || url.protocol === "http:")) return { url: url.href, isHeuristic: false };
    } catch { /* Fall through to known spoken site names. */ }
  }
  const lowerT = lower(normalized);
  const sites = Object.entries(KNOWN_WEBSITES).sort((a, b) => b[0].length - a[0].length);
  for (const [site, url] of sites) {
    if (new RegExp("\\b" + site + "\\b").test(lowerT) && /\b(go to|open|navigate to|visit|search for)\b/.test(lowerT)) return { url, isHeuristic: true };
  }
  return { url: null, isHeuristic: false };
}

export function extractTabTarget(transcript: string): { index?: number; query?: string; direction?: "first" | "last" | "next" | "previous" } | null {
  const m = transcript.match(/^\s*(?:please\s+)?(?:switch|go|jump|move)(?:\s+to)?\s+(?:the\s+)?(?:tab\s+(?:number\s+)?(.+)|(.+?)\s+tab)\s*[.!?]*$/i);
  if (!m) return null;
  const target = (m[1] ?? m[2]).trim().replace(/[.!?]+$/, "").trim();
  if (/^(first|last|next|previous)$/i.test(target)) return { direction: target.toLowerCase() as "first" | "last" | "next" | "previous" };
  const ordinals: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  if (ordinals[target.toLowerCase()]) return { index: ordinals[target.toLowerCase()] };
  if (/^-?\d+(?:\.\d+)?$/.test(target)) return { index: Number(target) };
  const n = extractNumber(target);
  if (n != null && Number.isSafeInteger(n) && /^(?:-?\d+|[a-z -]+)$/i.test(target)) {
    // Numbers only: a title such as "Project 3" must stay a title.
    const numericWords = target.toLowerCase().split(/[\s-]+/).every(w => w === "and" || w === "hundred" || w === "thousand" || w in WORD_NUMBERS);
    if (/^-?\d+$/.test(target) || numericWords) return { index: n };
  }
  return target ? { query: target } : null;
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
    const suffix = template.hostnameIncludes;
    const matches = suffix === "amazon."
      ? /(^|\.)amazon\.(com|in|co\.uk|de|fr|it|es|ca|co\.jp|com\.au|com\.br|com\.mx|nl|se|pl|sg|ae|sa|com\.tr)$/.test(hostname)
      : hostname === suffix || hostname.endsWith("." + suffix);
    if (matches) return template.buildUrl(query);
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
  const normalized = lower(transcript).replace(/[.!?]+$/, "").replace(/\s*\+\s*/g, "+").replace(/\s+/g, " ");
  const key = keyName.toLowerCase();
  if (normalized.replace(/^please\s+/, "") === key) return true;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^(?:please\\s+)?(?:press|hit|tap|key)\\s+${escapedKey}$`).test(normalized)) return true;
  // The semantic key name is "copy"/"undo"/etc., but the user may say the literal combo.
  return /^(?:please\s+)?(?:(?:press|hit|tap|key)\s+)?(?:control|ctrl|command|cmd)(?:\s+|\+)\s*([a-z])$/.test(normalized);
}

export function shouldTypeDirectlyInInsertMode(transcript: string, keyName: string | null): boolean {
  // Insert Mode is deliberately text-first. Only a standalone keyboard command is allowed to
  // leave the text path; app/browser commands belong to Normal or Workflow Mode.
  return !keyName || !isStandaloneKeyboardCommand(transcript, keyName);
}

export function extractKeyName(transcript: string): string | null {
  const lowerT = lower(transcript).replace(/\s*\+\s*/g, "+");
  let best: string | null = null;
  for (const phrase of KEY_PHRASE_NAMES) {
    if (new RegExp(`\\b${phrase}\\b`).test(lowerT)) {
      if (!best || phrase.length > best.length) best = phrase;
    }
  }
  if (best) return best;
  const modifierMatch = lowerT.match(/\b(?:control|ctrl|command|cmd)(?:\s+|\+)\s*([a-z])\b/);
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
  const m = lowerT.match(/\blast\s+(.+?)\s+words?\b/);
  if (m) {
    const token = m[1].trim();
    if (token in VAGUE_COUNT_WORDS) return VAGUE_COUNT_WORDS[token];
    const n = extractNumber(token);
    return n != null && Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return /\blast\s+word\b/.test(lowerT) ? 1 : null;
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
  const lowerT = lower(transcript).replace(/^please\s+/, "").replace(/[.!?]+$/, "");
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

export function extractFieldEdit(transcript: string): { target: string; text: string; kind: "type" | "select" } | null {
  const command = transcript.match(/^\s*(?:please\s+)?(type|write|enter|dictate|select|choose|pick)\s+(.+)$/i);
  if (!command) return null;
  const kind = /^(select|choose|pick)$/i.test(command[1]) ? "select" : "type";
  const body = command[2];
  const suffix = kind === "type" ? "(?:field|box|input)" : "(?:dropdown|menu|list|field)";
  const separators = kind === "type" ? ["into", "in"] : ["from", "in"];
  // Quoted values may themselves contain a separator. Otherwise prefer the explicit
  // "into/from" form before "in", which is common inside dictated sentences.
  for (const quoted of [true, false]) {
    for (const separator of separators) {
      const value = quoted ? `(["\'])(.+?)\\1` : `(.+?)`;
      const match = body.match(new RegExp(`^${value}\\s+${separator}\\s+(?:the\\s+)?(.+?)(?:\\s+${suffix})?\\s*[.!?]*$`, "i"));
      if (match) return { text: match[quoted ? 2 : 1].trim(), target: match[quoted ? 3 : 2].trim(), kind };
    }
  }
  return null;
}

export function findBrowserElementCandidates(transcript: string, page: BrowserPageState | null): BrowserElementCandidate[] {
  if (!page?.connected || !page.elements.length) return [];
  // Match the requested label, not generic command words or dictated values.
  const edit = extractFieldEdit(transcript);
  const target = edit?.target ?? extractClickTarget(transcript) ??
    transcript.match(/^\s*(?:please\s+)?(?:type|write|enter)\s+.+?\s+(?:in|into)\s+(?:the\s+)?(.+?)(?:\s+field)?[.!?]*$/i)?.[1];
  if (!target) return [];
  const normalized = lower(target).replace(/[.!?]+$/, "");
  const eligible = !edit ? page.elements : page.elements.filter(el => edit.kind === "select"
    ? el.tag === "select" || el.role === "combobox" : ["input", "textarea"].includes(el.tag) || el.role === "textbox" || el.tag === "div");
  const scored = eligible.map(el => {
    const label = lower(el.text).replace(/\s+/g, " ");
    const score = label === normalized ? 1 : similarity(normalized, label);
    return { ...el, score };
  }).filter(el => el.score >= 0.5).sort((a,b) => b.score - a.score);
  return scored.slice(0, 8);
}

export function extractPayload(transcript: string, page: BrowserPageState | null): ExtractedPayload {
  const searchQuery = extractSearchQuery(transcript);
  const { url, isHeuristic } = extractUrl(transcript);
  const tab = extractTabTarget(transcript);
  return {
    appCandidates: findAppCandidates(transcript),
    dictatedText: extractDictatedText(transcript),
    url,
    urlIsHeuristic: isHeuristic,
    siteSearchUrl: computeSiteSearchUrl(searchQuery, page),
    searchQuery,
    tabQuery: tab?.query ?? null,
    tabIndex: tab?.index ?? null,
    tabDirection: tab?.direction,
    number: extractNumber(transcript),
    keyName: extractKeyName(transcript),
    browserElementCandidates: findBrowserElementCandidates(transcript, page),
    settingsPane: extractSettingsPane(transcript),
    finderLocation: extractFinderLocation(transcript),
    deleteWordCount: extractDeleteWordCount(transcript),
    replacePair: extractReplacePair(transcript),
    clickTarget: extractClickTarget(transcript),
    fieldText: extractFieldEdit(transcript)?.text ?? null,
  };
}
