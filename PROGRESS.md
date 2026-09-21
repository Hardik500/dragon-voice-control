# PROGRESS.md — Living status

## Current milestone

**Milestone 5 (alpha cleanup) — implementation complete, pending macOS hardware verification.**

All five milestones from the plan have working code. The full vertical slice builds and
typechecks cleanly, and everything verifiable without macOS/live API keys has been smoke-tested.

## Completed capabilities

- **Electron/TypeScript skeleton**: tray app, settings window, floating overlay window, hidden
  mic-capture window, JSON settings persisted to `userData/settings.json`, JSONL logging from
  process start (`src/logging/logger.ts`), global shortcuts for push-to-talk-toggle and
  emergency stop.
- **Microphone capture**: hidden renderer (`src/renderer/mic-capture.ts`) requests
  `getUserMedia`, downsamples to 16 kHz mono Int16 PCM in-browser, streams frames to the main
  process over IPC, which forwards them to Deepgram. Media permission auto-granted for the
  app's own windows via `session.setPermissionRequestHandler`. `systemPreferences.
  askForMediaAccess("microphone")` is called on launch (macOS only; no-op elsewhere).
- **Deepgram Flux streaming STT** (`src/stt/deepgram-client.ts`): connects to
  `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000`,
  parses `Connected`/`TurnInfo`/`Error` messages, tracks turn index → utterance ID, surfaces
  `Update`/`StartOfTurn`/`EagerEndOfTurn`/`TurnResumed`/`EndOfTurn` events.
- **Jev via OpenRouter** (`src/decision/jev-client.ts`, `questions.ts`, `resolve.ts`): single
  combined request per utterance with `complete` + `intent` + `target` + `direction` (+
  `addressed` in always-listening mode) questions; typed answers resolved against
  deterministically-extracted payload (`src/decision/extract.ts`) into a concrete
  `ResolvedCommand`.
- **macOS execution** (`src/automation/macos.ts`): open/activate/hide/quit app, switch to
  previous app (Cmd+Tab), clipboard-paste text entry (restores previous clipboard), named-key
  press table, shortcuts (copy/cut/paste/select-all/undo/redo/save/find/etc.), window
  minimize/close/fullscreen("maximize" = fullscreen, see DECISIONS.md), volume up/down/set/mute/
  unmute, media play-pause/next/previous (tries Spotify then Music), System Settings panes,
  Finder locations, `say` with barge-in cancellation, active-app detection.
- **Chrome extension + bridge**: unpacked MV3 extension (`chrome-extension/`) with a content
  script that snapshots visible interactive elements (temporary `data-dragon-id`s, capped at 60,
  compact `{id, tag, role, text}` only) and performs click/type/select/scroll; a background
  service worker that owns the WebSocket connection to the desktop app and handles
  navigate/search/back/forward/reload/new-tab/close-tab/switch-tab directly via `chrome.tabs.*`.
  Desktop-side server: `src/browser/server.ts`, a `ws` `WebSocketServer` on
  `127.0.0.1:17872` with request/response correlation and timeouts.
- **All three activation modes** (`src/main/pipeline.ts` + `src/main/index.ts`): push-to-talk
  (toggle, see DECISIONS.md), wake-word (strips everything up to and including the configured
  phrase, case-insensitive), always-listening (adds the `addressed` Jev question and only acts
  above a 0.55 probability threshold).
- **Reliability controls**: only `EagerEndOfTurn`/`EndOfTurn` events trigger a Jev call (debounces
  `Update` noise); max 2 concurrent Jev requests, oldest aborted via `AbortController` when a
  3rd arrives; `TurnResumed` aborts the in-flight request for that utterance; per-utterance
  `executedUtterances` set prevents a duplicate terminal action if both an eager and a final
  turn would otherwise both fire; interim (`EagerEndOfTurn`) execution is restricted to a
  closed set of intents (`INTERIM_ELIGIBLE_INTENTS` in `resolve.ts`) that cannot be truncated
  mid-word (app control, window control, volume, media, tab/scroll/navigation) — free-form
  intents (`type_text`, `chrome_search`, `chrome_type`, `chrome_select`, `chrome_open_url`,
  `volume_set`) always wait for `EndOfTurn`.
- **Overlay, voice replies, history, logs**: floating always-on-top overlay shows
  state/transcript/action/status/latency; short native `say` acknowledgements with barge-in
  (new speech kills any in-progress reply); command history persisted to
  `userData/history.json` (last 200), viewable/clearable from Settings; JSONL debug logs
  rotated per day under `userData/logs/`, with a `redact()` pass that strips any field literally
  named like a key/token/authorization/audio value and truncates large arrays — never logs raw
  PCM, API keys, or Authorization headers.
- **Settings UI**: paste OpenRouter/Deepgram keys (masked, shown as "saved" placeholder once
  set, never re-displayed), activation mode, shortcuts, wake phrase, voice-reply toggle, log
  verbosity, open-logs button, history table + clear button.
- **Unsigned macOS packaging**: `electron-builder.yml` configured for an unsigned, non-notarized
  `mac`/`dir` target with `NSMicrophoneUsageDescription` baked into `Info.plist`.

## Manual check results (this environment: Linux/WSL2, no macOS)

What was actually run and observed:

- `npm install`, `npm run typecheck`, `npm run build` all succeed cleanly.
- `npx electron . --dev` launches the full app (tray + hidden windows + settings/overlay
  windows load their HTML/JS) and logs `app.start` → `browser.server_started` →
  `shortcuts.registered` → `app.ready` with no errors, then shuts down cleanly on
  `before-quit`/emergency-stop. Confirmed twice.
- Connected a throwaway WebSocket client to `ws://127.0.0.1:17872` standing in for the Chrome
  extension: `hello` handshake logged as `browser.extension_connected`, disconnect logged as
  `browser.extension_disconnected`. This exercises the exact protocol the real extension uses.
- Ran `extractPayload(...)` and `resolveCommand(...)` directly against the required scenarios:
  - `"open notepad"` → app candidate `TextEdit` → resolves to `{ kind: "open_app", appName:
    "TextEdit" }`.
  - `"type hello from dragon"` → `dictatedText: "hello from dragon"` (verbatim, exact required
    text) → resolves to `{ kind: "type_text", text: "hello from dragon" }`.
  - `"set volume to 40"` → `number: 40` → `{ kind: "volume_set", amount: 40 }`.
  - `"search for best pizza near me"` → `searchQuery` extracted verbatim → `{ kind:
    "chrome_search", query: "best pizza near me" }`.
  - `"scroll down"` → `{ kind: "chrome_scroll", direction: "down" }`.
- `npm run package:mac` (via `electron-builder --mac --dir`, run without the `--arm64` flag
  once to see default behavior) produced a real unsigned `Dragon.app` bundle with a correct
  `Info.plist` (bundle id, `NSMicrophoneUsageDescription`, category) — but as `darwin-x64`,
  because `@electron/rebuild`'s native-dependency step ran on this x64 Linux host. The
  `package:mac` npm script now passes `--arm64` explicitly; **this must be re-run on an actual
  Apple Silicon Mac** to confirm it truly cross-compiles the native module step to arm64 from an
  arm64 host (expected to work fine there, but unverified here).

What could **not** be verified in this environment, and exactly what to do about it:

1. **Deepgram/OpenRouter live calls.** No API keys were supplied and this is a sandboxed
   environment; `callJev()` and `DeepgramFluxConnection.connect()` were reviewed against the
   fetched, current API docs (see `DECISIONS.md`) but never hit the real endpoints.
   → *Manual step*: paste real keys into Settings on a Mac and speak a command; watch
   `userData/logs/dragon-YYYY-MM-DD.jsonl` for `stt.turn`, `jev.response`, and
   `pipeline.execution` events.
2. **`osascript`/`open`/`say` execution.** These binaries don't exist on Linux. All AppleScript
   strings in `src/automation/macos.ts` were reviewed by hand for syntax correctness (key
   codes, modifier syntax, quoting/escaping) but never actually run.
   → *Manual step*: run the "Manual alpha check" list below on a Mac.
3. **Real microphone capture end-to-end.** `getUserMedia` needs a real input device;
   confirmed only that the window loads, the permission handler is wired, and the
   downsampling/IPC code typechecks.
   → *Manual step*: same as above; also grant the macOS microphone permission prompt.
4. **Chrome extension loaded in real Chrome.** Verified the localhost protocol independently
   (see above) and read through `content.js`/`background.js` carefully, but never loaded the
   extension in an actual Chrome instance or clicked a real page element.
   → *Manual step*: `chrome://extensions` → Developer mode → "Load unpacked" →
   `chrome-extension/` folder in this repo; confirm the tray/log shows
   `browser.extension_connected`.
5. **macOS Accessibility permission prompts.** The first `osascript ... System Events`
   keystroke/window call on a fresh macOS install triggers an Accessibility permission prompt
   for the Dragon app (or for Terminal/Electron in dev mode); this alpha does not special-case
   that prompt.
   → *Manual step*: System Settings → Privacy & Security → Accessibility → enable Dragon (or
   the terminal you launched it from, in dev mode).
6. **arm64 packaging.** See above — re-run `npm run package:mac` on Apple Silicon.

## Known limitations / simplifications (see DECISIONS.md for full reasoning)

- Push-to-talk is a toggle, not press-and-hold.
- "Maximize" window = fullscreen toggle, not a distinct zoomed state.
- Media controls only work if Spotify or Music.app is the active player; other players are
  silently no-op'd (logged as `automation.media_no_player`).
- The Chrome bridge assumes a single Chrome window/extension connection at a time (fine for a
  personal alpha).
- Manifest V3 service workers go idle; `background.js` reconnects on a 2s timer, so there can be
  a brief window right after Chrome starts (or after long idle) where a command fails with
  "Chrome extension is not connected" until it reconnects. `chrome_open_url`/`chrome_search`
  are unaffected since they don't need the extension.
- No automated tests, by design (see AGENTS.md / plan non-goals).

## Bug fixes

- **Wake word / always listening didn't actually start listening (2026-09-21).** Picking
  "Wake word" or "Always listening" in the activation-mode dropdown (Settings window or tray)
  only updated `settings.activationMode`; the separate `listening` flag stayed `false` until
  toggled via the tray's "Listening: On/Off" item or the push-to-talk shortcut, so the mic
  window never got `mic:start` and Deepgram never connected — symptom was `mic.status:
  "stopped"` repeating with no `stt.*` events at all. Fixed in `src/main/index.ts`:
  `setActivationMode` and the Settings-window `onSettingsChanged` path now set `listening =
  true` whenever the new mode isn't `push_to_talk`. Push-to-talk is unaffected; it still
  requires the explicit hotkey/tray toggle.
- **Transcript shown, nothing executed (2026-09-21, second pass).** A real macOS run with the
  above fix applied showed STT/overlay working but almost no commands actually firing. Root
  causes and fixes, all in this pass (see `DECISIONS.md` for full detail): wake-word mode gave
  no feedback when the wake phrase wasn't heard; the always-listening `addressed` question was
  worded to require literally naming the assistant, defeating the point of that mode; the
  `stopStreaming` wrapper silently dropped its arguments so the new push-to-talk graceful-stop
  option could never reach the pipeline; the Settings window's Save button always resent
  `activationMode`, so *every* save stopped an active session; the tray menu never refreshed
  after hotkey/emergency-stop/Settings-driven changes; there was no reconnect after an
  unexpected Deepgram disconnect; browser-page snapshot fetching was gated on a sometimes-flaky
  frontmost-app read instead of the extension bridge's own connection state; media commands'
  "is it running" check went through System Events (needs Accessibility) instead of plain
  `pgrep`; and `APP_ALIASES` was missing common apps like Cursor, iTerm, Docker, Discord,
  Notion, Figma, and the Office suite. Also added a `chrome.alarms` keepalive to the extension's
  background worker (MV3 workers can be evicted after ~30s idle).
- **Relaunching into a continuous mode didn't start listening; spoken "dot com" never became a
  URL; auto-reconnect retried forever against a bad key (2026-09-21, third pass).** A real run
  with both fixes above applied showed genuine progress — Chrome open/search/scroll executing
  correctly — plus three new bugs, all fixed (see `DECISIONS.md` for full detail): `listening`
  is now seeded from the persisted `activationMode` at startup instead of always defaulting to
  `false`; `extractUrl` now normalizes spoken "X dot com" to "X.com" before matching (dictated
  text is untouched); and the auto-reconnect added in the second pass now only fires for a
  connection that actually opened before dropping (not one that never opened at all, e.g. a bad
  key), is capped at 5 attempts, and a manual stop during the retry gap now reliably cancels
  the pending retry. Also reworded the `open_app`/`shortcut` Jev criteria after observing "open
  cursor" misclassified as `shortcut` once — unverified against live Jev calls in this
  environment, so treat as a nudge, not a guaranteed fix.
- **Still open / not yet re-verified:** clicking browser elements requires the unpacked
  extension to be loaded (confirmed working-as-designed, user hadn't loaded it yet); STT
  mis-hears (e.g. "reddit" → "retit") are an inherent Deepgram accuracy limit, not a code bug;
  Jev occasionally misclassifies uncommon app names (see the `open_app` wording nudge above,
  needs a live re-test to confirm it actually helped).

## Exact next task

Hand off to a macOS machine and work through the "Manual alpha check" section of `README.md`
top to bottom. Priorities given the three bug-fix rounds above: (1) confirm the app resumes
listening on its own after a relaunch into wake-word/always-listening mode, with no manual
toggle, (2) confirm "search for/open X dot com" now navigates directly instead of failing to
resolve, (3) load the unpacked Chrome extension and confirm click/type/select/scroll/tab
commands work, (4) confirm push-to-talk delivers the final utterance after release, (5)
otherwise fix anything the AppleScript-by-inspection review got wrong (most likely spot:
window-control keystrokes and volume AppleScript syntax). Then remove this paragraph and mark
milestone 5 as fully verified in this file.
