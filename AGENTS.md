# AGENTS.md — Operating instructions for coding agents

Dragon is a **personal alpha**: a macOS voice-control agent built with Electron/TypeScript,
Deepgram Flux streaming STT, Jev (via OpenRouter's System One API), an unpacked Chrome
extension, and AppleScript/CLI automation. Read `/home/hardik/.opencode/plan/dragon-alpha-plan.md`
(or `PROGRESS.md`/`DECISIONS.md` in this repo) before making structural changes.

## Scope discipline

- This is alpha-first. Prefer the simplest working implementation over a more "correct" or
  extensible one.
- Explicit non-goals (do not add unless the user changes scope): automated tests, guardrails,
  confirmation prompts, risk classifiers/deny-lists, multi-step planners, fallback LLMs,
  Windows support, code signing/notarization, analytics/telemetry, Keychain integration.
- Do not introduce new frameworks, bundlers, or state-management libraries unless something
  in this codebase is genuinely unworkable without them. The renderer code intentionally has
  no build tool beyond `tsc` and no runtime dependencies beyond the DOM.

## Architecture invariants

- macOS execution goes through `open`/`osascript`/System Events/`say` (see
  `src/automation/macos.ts`). No native Swift helper. If something is not reliably scriptable,
  record the limitation in `PROGRESS.md` instead of adding a native module.
- Chrome DOM control (click/type/select/scroll/tabs) goes through the unpacked extension over
  the localhost WebSocket bridge (`src/browser/server.ts` + `chrome-extension/`). Simple
  navigation/search can bypass the extension entirely via `open -a "Google Chrome" <url>`
  (works even before the extension is loaded).
- Jev never invents free-form strings. Application names, URLs, dictated text, search
  queries, and numbers are extracted deterministically in `src/decision/extract.ts`. Jev
  (`src/decision/jev-client.ts`, `src/decision/questions.ts`) only selects among code-provided
  choices (intent / target candidate / direction) and answers yes/no completeness questions.
- Every pipeline stage logs a structured JSONL event via `src/logging/logger.ts`. **Never**
  log API keys, `Authorization` headers, or raw audio bytes — the logger's `redact()` helper
  enforces this centrally; do not bypass it by logging raw objects elsewhere.
- Stale-request cancellation and duplicate-action suppression live in
  `src/main/pipeline.ts` (`inFlight` list, `executedUtterances` set). Keep these when touching
  the pipeline; they are reliability mechanisms, not guardrails, and are required by the plan.

## Making changes

- Update `PROGRESS.md` after any meaningful chunk of work (what changed, what's next, what's
  blocked and why).
- Record any deviation from the original plan (endpoint URLs, library choices, simplifications
  like "push-to-talk is a toggle because Electron's globalShortcut has no key-up event") in
  `DECISIONS.md` with date, decision, reason, consequences.
- Do not add automated test suites. Manual verification steps belong in `PROGRESS.md` /
  `README.md`.
- This repo is developed and typechecked on Linux (no macOS available in this environment).
  Anything that calls `osascript`, `open`, or `say` cannot be executed here — reason about
  correctness by inspection, keep AppleScript snippets minimal and testable, and say so plainly
  in `PROGRESS.md` rather than claiming it was verified.
