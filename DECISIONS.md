# DECISIONS.md — Append-only decision log

## Initial decisions (from the alpha plan)

- **macOS-first, Apple Silicon target.** Windows and Intel Macs are out of scope for the alpha.
- **Electron + TypeScript** for the desktop app (tray, overlay, settings, mic capture, local
  WebSocket server).
- **Deepgram Flux** (`wss://api.deepgram.com/v2/listen`) for streaming STT, chosen over
  OpenRouter transcription because Flux gives word-by-word/turn-by-turn streaming with
  model-integrated end-of-turn detection.
- **Jev via OpenRouter** for low-latency structured decisions (intent / target / direction),
  not free-text generation.
- **Unpacked Chrome MV3 extension** talking to the desktop app over localhost, rather than a
  managed/automated browser.
- **AppleScript/System Events/`open`/`say`** for macOS execution; no native Swift helper in
  the alpha.
- **Native `say`** for short spoken acknowledgements.
- **No guardrails, no automated tests** in the alpha, by explicit product decision.
- **Direct commands only**; no autonomous multi-step planning.

---

## 2026-09-21 — Use the real OpenRouter System One endpoint, not the plan's placeholder

**Decision:** Call `POST https://openrouter.ai/api/v1/systemone` with `{ model: "jev-latest",
state, questions }`, matching OpenRouter's documented "TypeSafe SDK integration" / System One
API, instead of the plan document's illustrative `/api/alpha/decisions` path.

**Reason:** The plan's endpoint was a description, not a verified path. I fetched OpenRouter's
and TypeSafe's live documentation and confirmed the real request/response shape (`state`,
`model`, `questions` map of `choice`/`score`/`noul` question objects; response `answers` map
with `choice`/`confidence`/`probabilities` or `noul`).

**Consequences:** `src/decision/jev-client.ts` hard-codes this endpoint and the `jev-latest`
model alias. If OpenRouter changes the path or TypeSafe ships a new default model id, update
only that file.

## 2026-09-21 — Jev question set: one Choice for intent, one Choice for target, one Choice for direction, two Noul gates

**Decision:** Every decision request asks exactly: `complete` (Noul), `intent` (Choice over a
~34-value closed intent enum), `target` (Choice over code-extracted app/element candidates plus
`none`), `direction` (Choice over up/down/left/right/next/previous/increase/decrease/top/bottom/
none), and — only in always-listening mode — `addressed` (Noul).

**Reason:** Matches the plan's requirement that Jev answer several questions in one request and
never generate free strings. Keeping the option lists closed and code-generated (from
`src/decision/extract.ts`) means Jev is only ever choosing among things the code already knows
how to execute.

**Consequences:** Adding a new command intent means: (1) add it to `Intent` in
`src/types/pipeline.ts`, (2) add its description to `INTENT_CRITERIA` in
`src/decision/questions.ts`, (3) add a case to `resolveCommand` in `src/decision/resolve.ts`,
(4) add a case to `DragonPipeline.executeCommand` in `src/main/pipeline.ts`.

## 2026-09-21 — Push-to-talk is implemented as a toggle, not press-and-hold

**Decision:** The push-to-talk shortcut (default `Alt+Space`) starts streaming on the first
press and stops it on the next press, rather than requiring the key to be held down.

**Reason:** Electron's `globalShortcut` module only fires on key-down; it has no global key-up
event, so true press-and-hold behavior would require a native keyboard hook (out of scope for
the alpha — see "no native Swift helper").

**Consequences:** Documented in the Settings window UI copy and in `README.md`. A future native
helper could add real press-and-hold if needed.

## 2026-09-21 — "Maximize" is implemented as fullscreen toggle

**Decision:** `window_maximize` calls the same code path as `window_fullscreen`
(`Cmd+Ctrl+F`).

**Reason:** macOS has no single universal AppleScript/keyboard verb for "maximize to fill the
screen without entering fullscreen space" that works consistently across third-party apps.
Fullscreen toggle is the closest reliable, scriptable equivalent.

**Consequences:** Noted as a known simplification in `PROGRESS.md`. If a specific app needs
real "zoom to fill" behavior, add an app-specific AppleScript branch later rather than
generalizing prematurely.

## 2026-09-21 — Chrome navigation/search bypasses the extension; DOM actions require it

**Decision:** `chrome_open_url` and `chrome_search` always execute via
`open -a "Google Chrome" <url>` (macOS `open`), never via the extension. Only
click/type/select/scroll/tab actions go through the localhost WebSocket bridge to the unpacked
extension.

**Reason:** Simplicity and robustness — navigation should work even before the user has loaded
the unpacked extension, and `open -a` reliably launches Chrome if it isn't running. DOM-level
actions have no macOS equivalent and must go through the extension.

**Consequences:** "Open Chrome and navigate/search" works with zero extension setup; "click a
visible result / type in a field / scroll / switch tabs" requires the extension to be loaded
and connected (surfaced as an explicit error in the overlay/log if it isn't).

## 2026-09-21 — Mic capture uses `ScriptProcessorNode`, not `AudioWorklet`

**Decision:** `src/renderer/mic-capture.ts` uses the deprecated but still-functional
`createScriptProcessor` API to read PCM frames and downsample them to 16 kHz mono Int16 for
Deepgram, instead of building a separate `AudioWorkletProcessor` module.

**Reason:** `AudioWorklet` requires a second module file and async module loading; for a hidden,
single-purpose capture window in an alpha, `ScriptProcessorNode` is materially simpler and the
deprecation warning has no practical effect at this audio-graph size.

**Consequences:** If mic latency or main-thread jank becomes a real problem, migrate to an
AudioWorklet — not needed for the alpha's scenarios.

## 2026-09-21 — All development and verification happened on Linux, not macOS

**Decision:** The implementation, `tsc` typechecking, `npm run build`, and an unsigned
`electron-builder --mac --dir` package were all produced and smoke-tested on a Linux (WSL2)
machine, because that is the only environment available to this agent. The packaged `.app`
came out as `darwin-x64` (electron-builder's cross-build default) rather than `arm64`, because
`@electron/rebuild`'s native-module step used the host (x64) architecture.

**Reason:** No macOS hardware was available. This is documented rather than silently claimed as
"tested."

**Consequences:** See `PROGRESS.md` for the exact list of things that could only be verified by
code inspection / protocol-level testing (WebSocket bridge, extraction, decision resolution)
versus things that need a real macOS machine (`osascript`/`open`/`say` execution, actual
microphone capture, actual Deepgram/Jev network calls, arm64 packaging, Accessibility/mic
permission prompts, loading the unpacked Chrome extension).
