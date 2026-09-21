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

## 2026-09-21 — Selecting wake_word/always_listening now auto-sets the master `listening` flag

**Decision:** `setActivationMode` (tray) and the Settings-window save path now set the
module-level `listening` flag to `true` whenever the newly-selected mode isn't `push_to_talk`,
instead of leaving it untouched until a separate tray/hotkey toggle.

**Reason:** `listening` and `activationMode` were two independent pieces of state. A live test
showed picking "Always listening"/"Wake word" from the Settings dropdown updated
`activationMode` and logged `app.activation_mode_changed`, but `applyListeningState()` still
took its `if (!listening) { stopStreaming(); return; }` branch, so the mic window never got
`mic:start` and Deepgram never connected — no error, just silence, because the mode picker
implicitly reads as "start doing this now" for the two continuous modes.

**Consequences:** Push-to-talk keeps requiring its explicit toggle (unaffected). Switching
away from wake_word/always_listening to push_to_talk does not auto-stop listening beyond the
existing `pipeline.stopStreaming()` call already made on every mode change.

## 2026-09-21 — Second pass: fixed "transcript shows, nothing executes" and several latent bugs

A real macOS run (with the above fix applied) produced JSONL logs showing transcripts flowing
correctly but no action for most utterances. Root-causing this against the actual logs plus a
full re-read of `src/main/*.ts` turned up several distinct issues, all fixed in the same pass:

1. **Wake-word mode silently drops unprefixed speech.** Saying "Open Chrome." without the wake
   phrase is correct-by-design (the transcript doesn't start with "Dragon"), but the overlay
   went straight back to idle with zero explanation. `DragonPipeline.onTurn` now posts an
   overlay status (`Say "Dragon" first to give a command`) instead of going silent.
2. **The `addressed` question (always-listening mode) required literally naming the
   assistant.** Its wording asked "is this addressed to a voice assistant named Dragon", which
   is backwards for a mode whose entire point is not needing a wake word — a plain "open
   cursor" scored `addressed: 0.14` and was correctly-per-its-wording, but uselessly, rejected.
   Reworded in `src/decision/questions.ts` to ask whether the speaker wants a computer/assistant
   to act *right now*, explicitly stating no wake word or naming is required.
3. **`APP_ALIASES` was missing common apps** (Cursor, iTerm, Docker, Discord, Notion, Figma,
   Office apps, etc.), so even a correctly-classified `open_app` intent for those had no target
   candidate to resolve to. Expanded the table in `src/commands/registry.ts`.
4. **The `pipeline.stopStreaming` wrapper in `src/main/index.ts` dropped its arguments**
   (`() => { originalStop(); ... }`), so the `{ graceful }` option added for push-to-talk (see
   below) could never actually reach `DragonPipeline.stopStreaming`. Fixed to forward `opts`.
5. **Push-to-talk closed the Deepgram socket immediately on release**, which in normal
   press-talk-release usage can cut the connection before the final `EndOfTurn` (and therefore
   the Jev decision) for whatever was just said arrives. `stopStreaming({ graceful: true })` now
   sends Flux's `ForceEndTurn` and gives it 1.5s to flush before actually closing; hardened
   against a rapid re-toggle race with a `streamGeneration` counter so a stale connection's
   delayed close can't trigger a spurious reconnect after a newer one already took over.
6. **Every Settings-window Save stopped any active listening session**, even if the user only
   changed, say, the wake phrase — because the form always submits `activationMode` and the old
   code treated "field present in the update payload" as "field changed". `settings:update` in
   `src/main/ipc.ts` now diffs against the previous value server-side and only reports a mode
   change when the mode actually changed.
7. **The tray menu went stale** after hotkey-driven listening toggles, emergency stop, or a
   Settings-window change, because `Menu.buildFromTemplate` bakes in label/checked values at
   build time and nothing outside the tray's own "Listening" checkbox ever rebuilt it.
   `createTray` now returns a `refresh()` handle that every state-changing path in `index.ts`
   calls.
8. **No reconnect after an unexpected Deepgram disconnect.** A dropped connection (network
   blip, idle timeout) left `micStreaming = false` with no automatic recovery, while the tray
   still showed "Listening: On" and the hidden mic window kept capturing into nothing.
   `DragonPipeline.startStreaming` now auto-reconnects once after 1s on an unintentional close.
9. **Browser-page snapshot fetch was gated on our own frontmost-app detection
   (`activeApp === "Google Chrome"`)** rather than on the extension bridge being connected, so a
   flaky/slow Accessibility read could silently disable browser-element target candidates even
   with Chrome visibly focused. Now gated on `browserBridge.isConnected()` instead.
10. **`isAppRunning` (used by media play/pause/next/previous) went through System Events**,
    which requires the Accessibility permission that media control otherwise doesn't need at
    all — so before that permission was granted, media commands would always silently take the
    "no player running" no-op path even with Music/Spotify open. Switched to plain `pgrep -x`.
11. Minor: removed an unused `randomUUID` import and an unused `currentUtteranceId` field, and
    added a `chrome.alarms` keepalive to the extension's background service worker, since MV3
    workers can be evicted after ~30s idle even with an open WebSocket in some Chrome versions.

**Consequences:** None of these required new dependencies or architectural changes — all fixes
are within the existing modules. Item 6 changed the `IpcDeps.onSettingsChanged` signature from
`(settings, partial)` to `(settings, changedMode?)`; anything calling `registerIpc` needs the
updated shape.
