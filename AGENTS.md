# AGENTS.md — Operating instructions for coding agents

Dragon is a **personal alpha**: a macOS + Windows voice-control agent built with
Electron/TypeScript, Deepgram Flux streaming STT, Jev (via OpenRouter's System One API), an
unpacked Chrome extension, and OS-native automation (AppleScript/CLI on macOS,
PowerShell/User32 on Windows). Read `/home/hardik/.opencode/plan/dragon-alpha-plan.md` (or
`PROGRESS.md`/`DECISIONS.md` in this repo) before making structural changes.

## Scope discipline

- This is alpha-first. Prefer the simplest working implementation over a more "correct" or
  extensible one.
- Explicit non-goals (do not add unless the user changes scope): automated tests, guardrails,
  confirmation prompts, risk classifiers/deny-lists, multi-step cross-app planners, fallback
  LLMs, Windows on ARM, code signing/notarization, analytics/telemetry, Keychain/Credential
  Manager integration.
- Do not introduce new frameworks, bundlers, or state-management libraries unless something
  in this codebase is genuinely unworkable without them. The renderer code intentionally has
  no build tool beyond `tsc` and no runtime dependencies beyond the DOM.

## Architecture invariants

- **Platform boundary.** The pipeline and decision layers only ever import `automation` from
  `src/automation/index.ts`, never `macos.ts`/`windows.ts` directly. Same for vocabulary:
  `src/decision/extract.ts` and `src/decision/resolve.ts` only import from
  `src/commands/registry.ts` (the platform selector) — never `registry-macos.ts` /
  `registry-windows.ts` directly. Those platform-specific files are for
  `automation/macos.ts` / `automation/windows.ts` only. Voice-alias resolution (e.g. "chrome" →
  the real executable/app name) happens *inside* each platform's automation module, using its
  own registry — shared code only ever sees alias keys, never resolved OS values. If you add a
  new command intent that needs a closed vocabulary (a settings pane, a folder location, a key
  name), add the *name* to `registry-common.ts` and an entry in **both**
  `registry-macos.ts` and `registry-windows.ts` — `registry.ts` throws at startup if either is
  missing.
- macOS execution goes through `open`/`osascript`/System Events/`say` (see
  `src/automation/macos.ts`). No native Swift helper. Windows execution goes through
  PowerShell + a small inline C# `User32` P/Invoke helper using `keybd_event` (see
  `src/automation/windows.ts`; `keybd_event` was chosen over the newer `SendInput` because its
  signature is simple enough to get right without a Windows machine to test against — see
  DECISIONS.md before "upgrading" this). If something is not reliably scriptable, record the
  limitation in `PROGRESS.md` instead of adding a native module/helper process.
- Chrome DOM control (click/type/select/scroll/tabs) goes through the unpacked extension over
  the localhost WebSocket bridge (`src/browser/server.ts` + `chrome-extension/`, which is pure
  JS and identical on both OSes). Simple navigation/search can bypass the extension entirely
  via `automation.openUrlInChrome()` (works even before the extension is loaded); the extension
  is only required for DOM-level actions and for "prefer an existing tab over a new one".
- Jev never invents free-form strings. Application names, URLs, dictated text, search
  queries, and numbers are extracted deterministically in `src/decision/extract.ts`. Jev
  (`src/decision/jev-client.ts`, `src/decision/questions.ts`) only selects among code-provided
  choices (intent / target candidate / direction) and answers yes/no completeness questions.
  One narrow, deterministic exception: `src/decision/resolve.ts`'s `openAppOverride` trusts a
  literal "open/launch/start X" pattern over Jev's own intent choice when X matched a known
  app alias, because Jev has been observed occasionally misclassifying that extremely common,
  unambiguous pattern (see DECISIONS.md). Don't generalize this into a bigger override system.
- Every pipeline stage logs a structured JSONL event via `src/logging/logger.ts`, including
  latency breakdowns (`sttToDecisionMs`/`decisionMs`/`executionMs`/`totalMs`). **Never** log
  API keys, `Authorization` headers, or raw audio bytes — the logger's `redact()` helper
  enforces this centrally; do not bypass it by logging raw objects elsewhere.
- Stale-request cancellation and duplicate-action suppression live in
  `src/main/pipeline.ts` (`inFlight` list, `executedUtterances` set). Keep these when touching
  the pipeline; they are reliability mechanisms, not guardrails, and are required by the plan.
- **Dictation session state** (`dictationActive`/`dictationBuffer`/`lastDictationChunk` in
  `DragonPipeline`) tracks exactly what Dragon has typed so "delete the last 3 words" /
  "replace X with Y" can compute exact backspace counts instead of guessing — Dragon never
  reads the focused app's actual text content (no Accessibility text APIs, no vision). Keep
  this buffer in sync with every `typeText`/`deleteBackward` call path; if you add a new way
  text can be typed, update the buffer alongside it or these commands will silently drift out
  of sync with what's actually on screen.
- Dragon runs **one command per utterance** by design (no multi-step/cross-app planning). A
  request like "open Slack, search for X, and type a message" is expected to be spoken as
  separate sequential utterances, each a direct command — don't build a planner to chain them
  automatically.

## Making changes

- Update `PROGRESS.md` after any meaningful chunk of work (what changed, what's next, what's
  blocked and why).
- Record any deviation from the original plan (endpoint URLs, library choices, simplifications
  like "push-to-talk is a toggle because Electron's globalShortcut has no key-up event") in
  `DECISIONS.md` with date, decision, reason, consequences.
- Do not add automated test suites. Manual verification steps belong in `PROGRESS.md` /
  `README.md`.
- This repo is developed and typechecked on Linux (no macOS or Windows machine available in
  this environment). Anything that calls `osascript`/`open`/`say` (macOS) or
  `powershell.exe`/`cmd.exe` (Windows) cannot be *executed* here — reason about correctness by
  inspection, and where possible verify the exact generated script text via a harness that
  stubs `electron`/`child_process` (see the verification notes in `DECISIONS.md`/`PROGRESS.md`
  for the pattern used). Say plainly in `PROGRESS.md` what was and wasn't actually run,
  rather than claiming untested code was verified. `automation/index.ts` has a Linux dev-only
  fallback (uses the macOS module) purely so the app can still boot here for structural
  checks — real end users are macOS or Windows only.
