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

## 2026-09-21 — Third pass: startup state, spoken "dot com", and an auto-reconnect retry storm

A real macOS run with the two prior fixes applied showed genuine progress (Chrome open/search/
scroll executing correctly) plus three new findings:

1. **Relaunching into a continuous mode didn't actually start listening.** `listening` is a
   plain in-memory `let`, always `false` on a fresh launch, regardless of the persisted
   `activationMode`. The tray correctly showed "Always Listening" selected, but the mic never
   started until manually toggled off and back on. Fixed in `src/main/index.ts`: `listening` is
   now seeded from `settingsStore.get().activationMode !== "push_to_talk"` right after settings
   load, and `applyListeningState()` is called once at the end of startup (after mic-permission
   and mic-window wiring are in place) to actually act on it.
2. **Spoken "dot com" never became a URL.** Deepgram transcribes "google dot com" as the literal
   words "google dot com", not "google.com" — there's no punctuation-formatting option that
   converts this. Our domain regex required a literal period, so `chrome_open_url` correctly
   inferred by Jev always failed to resolve (`resolution_failed`) for any spoken domain. Added
   `normalizeSpokenDomain` in `src/decision/extract.ts`, applied only inside `extractUrl` (never
   for dictated text, so "type dot com is popular" stays verbatim).
3. **The previous pass's auto-reconnect-on-unexpected-close retried forever against a bad/
   expired key.** A connection that fails its handshake (401, DNS failure, etc.) closes shortly
   after, which the old code treated the same as "was working, then dropped" and rescheduled a
   reconnect — which fails identically, forever, hammering the API roughly once a second.
   Fixed: `DeepgramFluxConnection`'s close handler now reports whether the connection ever
   actually opened (`hadOpened`), and `DragonPipeline` only auto-reconnects when it did,
   capped at 5 consecutive attempts, and gives up with a visible overlay error past that.
   Also fixed a narrow race where manually stopping listening during the ~1s gap between an
   unexpected drop and the scheduled retry wouldn't cancel that pending retry (`stopStreaming`'s
   early-return when already not "streaming" skipped clearing it) by tracking the timer handle
   explicitly and always clearing it in `stopStreaming`.

Also slightly reworded the `open_app`/`shortcut` Jev question criteria after observing "open
cursor" misclassified as `shortcut` at low confidence in one run — `open_app` now explicitly
notes it applies even to unusual/unfamiliar-sounding app names, and `shortcut` now explicitly
excludes opening/launching an application. This is a wording nudge, not a guaranteed fix,
since it depends on the model's behavior and wasn't independently re-verified against live
Jev calls in this environment.

**Consequences:** `DeepgramFluxConnection`'s constructor's 3rd callback parameter type changed
from `() => void` to `(hadOpened: boolean) => void` (exported as `CloseHandler`).

## 2026-09-21 — Windows support added: shared `PlatformAutomation` boundary

**Decision:** Added `src/automation/types.ts` (the `PlatformAutomation` interface),
`src/automation/index.ts` (selects `macos.ts` or `windows.ts` by `process.platform`), and
`src/automation/windows.ts` (new, full Windows implementation). Split
`src/commands/registry.ts` into `registry-common.ts` (platform-neutral names: known websites,
canonical key/settings-pane/location name lists, site-search URL templates) plus
`registry-macos.ts` and `registry-windows.ts` (the actual per-OS values), with `registry.ts`
now a thin selector that also **throws at startup** if either platform's registry is missing
an entry for a common name (`checkCoverage`).

**Reason:** This is exactly Milestone 6 from the updated plan. The pipeline (`extract.ts`,
`resolve.ts`, `pipeline.ts`) must never see OS-specific values (AppleScript key codes, Windows
virtual-key codes, `ms-settings:` URIs, exe paths) — only semantic names. A build-time-ish
coverage check (it runs once at module load) makes "I added a Windows-only alias but forgot
the name on macOS" fail loudly instead of silently no-op'ing a command later.

**Consequences:**
- `AppCandidate`/`ResolvedCommand` gained an `appAlias` field (the raw registry key, e.g.
  `"chrome"`) separate from `appName`/`label` (the friendly display string). Automation calls
  use `appAlias`; overlay/history/voice-reply text uses `appName`. Alias→executable resolution
  now happens *inside* `automation/macos.ts`/`automation/windows.ts`, each using its own
  registry file directly — `extract.ts` only ever sees alias keys via `appAliasKeys()`/
  `appAliasLabel()` in `registry.ts`.
- `KEY_PHRASES` was renamed/restructured to `KEY_SPECS` (platform-specific representation) +
  `KEY_PHRASE_NAMES` (common list, in `registry-common.ts`). Same pattern for
  `SETTINGS_PANES`/`SETTINGS_PANE_NAMES` and `FINDER_LOCATIONS`→`LOCATIONS`/`LOCATION_NAMES`.
- `src/automation/index.ts` has a **Linux dev-only fallback** (falls back to the macOS module,
  logging `automation.unsupported_platform_dev_fallback`) purely so this Linux sandbox — the
  only environment available while building this — can still boot the app for structural
  verification. Real end users get a hard error on any platform other than `darwin`/`win32`.
- `scripts/clean.js` replaces the shell-specific `rm -rf dist dist-renderer` (Windows has no
  `rm`) using `fs.rmSync`.

## 2026-09-21 — Windows execution: PowerShell + `keybd_event`, not a persistent C# helper

**Decision:** `src/automation/windows.ts` implements every action as a fresh
`powershell.exe -NoProfile -NonInteractive -Command "..."` process (per-action, per the plan),
with a small inline C# type (`Add-Type -Namespace Dragon -Name Win32 -MemberDefinition ...`)
providing `GetForegroundWindow`/`GetWindowThreadProcessId`/`SetForegroundWindow`/`ShowWindow`/
`PostMessage`/`keybd_event`. App launching goes through `cmd.exe /c start "" <token>` (the same
resolution Win+R uses: PATH, the "App Paths" registry, or a URI).

**Reason:** The plan explicitly allows starting with per-action PowerShell processes and only
building a persistent C# helper if measured latency/reliability requires it — premature to add
that complexity before a single real Windows run. `keybd_event` (legacy but still fully
supported) was chosen over the newer, Microsoft-recommended `SendInput` specifically because
its P/Invoke signature (`void keybd_event(byte, byte, uint, UIntPtr)`) is simple enough to
write correctly *without a Windows machine to test on*, whereas `SendInput` requires marshaling
an `INPUT`/`KEYBDINPUT` struct — much easier to get subtly wrong blind.

**Verification performed (no Windows machine available):** Ran `npm run package:win`
(`electron-builder --win portable --x64`) successfully from this Linux sandbox — produced a
real, valid, unsigned Windows PE32 portable `.exe` with no `wine` installed. Separately,
built a small Node harness that stubs `electron` and `child_process.execFile`/`spawn` to
capture the *exact* generated PowerShell/`cmd` command lines without executing them, and
inspected them for every action (`openApp`, `activateApp`, `quitApp`, `windowMinimize`,
`pressNamedKey` for both a virtual-key and a Ctrl+letter shortcut, `deleteBackward`,
`typeText`, `switchToPreviousApp`, `getActiveAppName`, `openFinderLocation` for both a plain
folder and a `shell:` URI, `openSettingsPane`, and `say`) — all produced syntactically
plausible, correctly-parameterized scripts (verified virtual-key codes by hand, e.g.
Ctrl+A = `keybd_event(17,...)` then `keybd_event(65,...)`, Alt+F4 for "close window" =
`keybd_event(18,...)` then `keybd_event(115,...)`). **This is not the same as running them on
Windows** — no real `powershell.exe`/`user32.dll` call was ever made. Treat the entire Windows
adapter as unverified-on-real-hardware until someone runs the manual check on Windows 11.

**Consequences (documented parity gaps, all explicitly allowed by the plan):**
- `volumeSet` (exact percentage) throws a clear "not supported on Windows yet" error rather
  than approximating — Core Audio COM interop (`IAudioEndpointVolume`) would be needed, and is
  exactly the kind of low-level, hard-to-verify-blind code this alpha avoids per plan guidance
  ("ship up/down/mute first... record exact setting as the first parity gap").
- `volumeMute`/`volumeUnmute` both send the **same** `VK_VOLUME_MUTE` toggle key — Windows has
  no separate set-true/set-false without the same COM interop. Calling "unmute" while already
  unmuted will mute it. Logged as `automation.windows_mute_is_toggle` each time.
- "Maximize"/"fullscreen" both approximate: `windowFullscreen` presses F11 (the closest
  widely-supported convention — browsers, VS Code, most media players); `windowMaximize` calls
  `ShowWindow(SW_MAXIMIZE)` directly (an actual maximize, unlike macOS where "maximize" is
  aliased to fullscreen — Windows *does* have a real maximize concept via `ShowWindow`, so it
  gets a real implementation here, not just parity with macOS's simplification).
- Third-party app launching (Slack, Discord, Cursor, Docker Desktop, etc.) is best-effort:
  Windows has no single equivalent of macOS's `open -a "<App Name>"`. It works if the app is on
  PATH or registered an "App Paths" registry key (true for Chrome, Firefox, VS Code with "Add
  to PATH" checked, Office, and many installers) and may fail for apps installed only via a
  per-user/appx installer that doesn't register either. `Docker Desktop`'s launch token is a
  literal guess (`"Docker Desktop"`) with no verified install-path probing like Chrome got.
- `openApp`/`openUrlInChrome` special-case Chrome with `findChromeExe()`, probing the three
  standard install locations (`Program Files`, `Program Files (x86)`, per-user `LocalAppData`)
  since Chrome is the one third-party app the plan's manual check explicitly requires.

## 2026-09-21 — Platform-specific default global shortcuts and tray icon

**Decision:** `DEFAULT_SETTINGS` now resolves `pushToTalkShortcut`/`emergencyStopShortcut` to
`Control+Alt+D`/`Control+Alt+Escape` on Windows (macOS keeps `Alt+Space`/`Alt+Escape`), per the
plan. Shortcut *registration failure* (e.g. already claimed by another app) is now surfaced,
not just logged: `registerShortcuts` returns `{pushToTalkOk, emergencyStopOk}`, which flows
through the existing `status:get`/`status:update` IPC channel into a warning banner in the
Settings window. Also added a colored Windows tray icon (`assets/tray-icon-win.png`) and a
real multi-size `.ico` (`assets/app-icon.ico`, hand-built as a valid PNG-compressed ICO
container, verified with `file`) — macOS's monochrome "template" tray icon convention doesn't
apply on Windows, where an all-black icon would look wrong.

**Reason:** `Alt+Space` opens the window system menu on Windows; a silently-failed shortcut
registration with no user-visible feedback would otherwise look identical to "the app is
broken" (this exact class of bug was already found and fixed once for tray-menu staleness in
an earlier pass — apply the same "surface it, don't just log it" standard here).

## 2026-09-21 — Voice dictation mode: continuous typing, deterministic in-session editing

**Decision:** Added a small dictation state machine to `DragonPipeline`: `dictationActive`
becomes true after any `type_text` executes; while active, an utterance Jev doesn't recognize
as any other command (`intent: "none"` or low confidence) is typed verbatim and folded into a
tracked `dictationBuffer` instead of being discarded, so a user can keep talking naturally
after one initial "type ..." without repeating the word "type" every sentence. A small,
*deterministic* set of editing phrases — "new line", "delete the last N words", "delete/undo
that" (removes exactly the last appended chunk), "delete everything"/"clear all of that", and
"replace X with Y" — are matched by regex and executed **without calling Jev at all**, using
exact character counts computed from the tracked buffer (backspacing precisely `oldLength -
newLength` characters, or for replace, backspacing only the tail after the longest shared
prefix and retyping only the changed suffix). Any other successfully-executed command
(`open_app`, `chrome_search`, etc.) ends the dictation session. Two new intents,
`insert_newline` and `search_in_app` (see below), and two more, `delete_text`/`replace_text`,
exist mainly so Jev's own classification of these phrases (when the fast path doesn't fire,
e.g. dictation isn't active) still resolves sensibly instead of falling through to "no
command recognized".

**Reason:** Explicitly requested. Dragon does not read the focused app's actual text content
(no Accessibility text APIs, no vision, per the plan's non-goals) — the *only* way to make
"delete the last 3 words" or "replace draft with final" reliable without that is to track
exactly what Dragon itself typed and compute exact keystroke counts from that tracked copy,
which is why the buffer-tracking design was chosen over any heuristic based on word-boundary
keystrokes alone (those remain as a documented fallback risk, not the primary mechanism).
Bypassing Jev for the editing phrases themselves is a latency/reliability choice, not a
guardrail — these are a small, fixed, unambiguous set of regexes.

**Consequences:**
- If the user manually edits the field, switches apps, or the app doesn't accept a paste the
  way Dragon assumes, the tracked buffer silently drifts out of sync with reality, and a
  subsequent delete/replace will backspace the wrong number of characters. This is an
  inherent limitation of not reading the target app's content, documented in PROGRESS.md/
  README.md rather than solved (solving it would require Accessibility text APIs on macOS and
  UI Automation `ValuePattern` on Windows — a much bigger addition, deferred).
  "Ambient" words that happen to match an editing phrase (e.g. dictating a sentence that
  contains "select all my belongings") are not caught by this fast path (it requires the
  *entire* utterance to match one of the control regexes, not a substring), which avoids the
  worst false-positive risk, but real free-form dictation will occasionally contain a full
  sentence that happens to *be* one of these phrases and get misinterpreted as a control
  command instead of typed. Accepted trade-off, matches the plan's alpha philosophy.
- Added `PlatformAutomation.deleteBackward(count)` — presses Backspace `count` times in a
  single OS call (one `osascript`/`powershell.exe` process, not `count` of them).

## 2026-09-21 — "Open youtube.com" (already worked); site-aware search; tab reuse; in-app search

Four related, smaller additions toward the requested use cases:

1. **"Open youtube.com" → Chrome:** already worked end-to-end before this pass (Deepgram
   transcribes "open youtube dot com"; `normalizeSpokenDomain` in `extract.ts` — added in an
   earlier pass for the "search for google dot com" bug — turns that into "youtube.com";
   `extractUrl` matches the domain regex; `chrome_open_url` executes via
   `automation.openUrlInChrome`, which explicitly launches Chrome regardless of what's
   currently focused). No new code needed; confirmed via the extraction unit check in
   PROGRESS.md.
2. **Site-aware search ("open youtube music" then "search for X" plays the right thing):**
   `registry-common.ts`'s `SITE_SEARCH_TEMPLATES` maps a hostname fragment (e.g.
   `music.youtube.com`, `github.com`, `reddit.com`, `amazon.`, `wikipedia.org`) to a URL-based
   search template. `extract.ts`'s `computeSiteSearchUrl` checks the *current* Chrome page's
   hostname (from the extension's snapshot) and, if it matches, attaches that URL to the
   `chrome_search` `ResolvedCommand` instead of a generic Google search. Two ordinary
   sequential commands — no multi-step planning, no DOM click needed for the search step
   itself (only for actually clicking a result afterward, which still needs the extension).
3. **"Open my existing tabs" (avoid duplicate tabs):** added a new `BrowserAction` kind,
   `focus_or_open`, implemented in `chrome-extension/background.js`: before opening a URL,
   check whether any existing tab (any window) already has a matching hostname and, if so,
   just focus that tab/window instead of creating a new one. `chrome_open_url`/`chrome_search`
   now route through `DragonPipeline.openUrlPreferringExistingTab`, which tries this when the
   extension is connected and falls back to the plain OS-level open (always a new tab/window)
   when it isn't.
4. **"Open Slack, ... type a message" (generic in-app search, not Slack-specific):** added a
   `search_in_app` intent that presses the target app's own quick-open/jump-to shortcut
   (Cmd/Ctrl+K — a near-universal convention: Slack, Notion, VS Code, Discord, Linear, and
   many other apps all bind it), pastes the query, and presses Enter. This is generic, not
   Slack-specific automation, and does not attempt to chain "open app" + "search" + "type" into
   one action — per AGENTS.md's one-command-per-utterance rule, the user says three separate
   commands and each one individually works.

**Consequences:** `search_in_app`'s Cmd/Ctrl+K convention doesn't hold for every app (some use
Cmd/Ctrl+F, some have no such shortcut at all) — best-effort, matching the plan's general
stance on third-party app integration. `focus_or_open`'s hostname match is intentionally loose
(any tab on the same hostname, not the exact URL/path) so "open youtube music" reuses an
already-open YouTube Music tab even if it's on a different video/search page.

## 2026-09-21 — Fourth pass: completeness-vs-finality gate, "open cursor" override, richer latency logs

A further real macOS run (logs supplied directly, not reconstructed) surfaced two more
concrete bugs, both fixed in this pass:

1. **A fully-spoken, final command could still be rejected as "incomplete".** Jev's `complete`
   answer is a *semantic* completeness judgment (is this a well-formed sentence), not a
   *speech* completeness judgment (has the user finished talking) — Deepgram's `EndOfTurn`
   already tells us the latter. Observed: `"Open Slack?"` scored `complete: 0.31` (the
   trailing "?" read as a question, not a command) despite being a fully final, fully
   executable utterance, and was silently dropped by the `summary.complete < COMPLETE_THRESHOLD`
   check regardless of `turn.isFinal`. Fixed in `src/main/pipeline.ts`: the completeness gate
   (`incomplete`) now only applies when the turn is *not yet final* — its job is purely to
   avoid acting on a truncated interim guess; once `EndOfTurn` has fired, only the intent
   confidence/recognition gates still apply.
2. **"Open cursor" still occasionally misclassified.** Even after the `open_app`/`shortcut`
   Jev-criteria wording nudge from an earlier pass, "open cursor" was observed scoring
   `intent: "none"` (0.49 confidence) in one run and `intent: "shortcut"` (0.4 confidence) in
   another — plausibly because "cursor" reads as a UI/mouse/text-cursor concept as often as
   the app name. Added a small, deterministic, code-level override in `resolve.ts`
   (`openAppOverride`): when the utterance matches `/^(?:open|launch|start|switch to|go to)/i`
   **and** a known app alias was found in the transcript, resolve to `activate_app` for that
   app regardless of what intent Jev chose (unless Jev chose `quit_app`/`hide_app`, which stay
   intentional). This is documented as a narrow, closed-pattern exception in AGENTS.md — not a
   general "trust extraction over Jev" policy.
3. **Latency logging.** `pipeline.decision_request` now includes `sttToDecisionMs` (time from
   the Deepgram turn event to Dragon starting to process it); `pipeline.execution` now includes
   `sttToDecisionMs`, `decisionMs`, `executionMs`, and `totalMs` together (previously only
   `decisionMs`/`executionMs` separately); the overlay's latency indicator now shows that same
   `totalMs`. `pipeline.dictation_control`/`pipeline.dictation_continue` events (new, from the
   dictation feature above) also carry a `totalMs`.
4. Also added a friendlier error message in `automation/macos.ts` for the classic
   `osascript ... "not allowed to send keystrokes" (1002)` Accessibility-permission error
   (observed once in the same log batch) — it now names the exact System Settings path instead
   of surfacing the raw AppleScript error text.

**Verification performed:** re-ran the exact failing transcripts (`"Open cursor."` with Jev
answers matching both observed misclassifications, `"Open Slack?"` with `complete: 0.31`)
through `extractPayload`/`resolveCommand` directly — both now resolve correctly. Latency and
the friendlier error message were verified by code inspection only (both are straightforward
enough not to need a harness), consistent with AGENTS.md's verification-honesty rule.

## 2026-09-21 — Fifth pass: the Chrome extension couldn't connect at all, plus dictation gaps

A real macOS run using the Windows-support/dictation build (real logs supplied directly)
surfaced one severe bug and several real dictation-coverage gaps.

1. **`ws://127.0.0.1:17872/` refused the connection outright.** Root cause: Electron does not
   enforce single-instance by default, and `BrowserBridge.start()`'s `WebSocketServer` bind
   failure only ever got logged (`browser.server_error`, now `browser.server_bind_failed`) —
   never surfaced anywhere a user would see it, and the old code even logged
   `browser.server_started` unconditionally right after the constructor call, before the
   `listening`/`error` event told us whether the bind actually succeeded, so the log itself
   was misleading. A second Dragon process (from re-running `npm start`, or launching the
   packaged app while a dev instance was still up) would silently fail to bind the fixed port
   while otherwise running completely normally — voice commands mostly still worked (STT/Jev/
   macOS automation don't touch this port), which is exactly why the rest of the pipeline
   looked fine in the logs while the extension flatly couldn't connect. **Fixed:**
   `app.requestSingleInstanceLock()` in `src/main/index.ts` — a second launch attempt now
   quits immediately and just focuses the first instance's Settings window instead of
   silently stealing (or failing to steal) the port. `BrowserBridge` now logs
   `browser.server_started` only on the actual `listening` event, exposes `getBindError()`
   (with a specific, actionable message for `EADDRINUSE`), and that surfaces as a Settings
   warning banner (same pattern as the shortcut-registration warning).
   **Verification:** reproduced both failure modes directly — launched two real Electron
   instances back to back (second one's log stops immediately after module-load, before
   `app.start`, confirming the lock works) and separately pre-bound port 17872 with a plain
   Node `net.createServer()` before launching Dragon (confirmed `browser.server_bind_failed`
   fires with the exact `EADDRINUSE` message). Did not reproduce the *original* multi-instance
   scenario on real macOS (no Mac available) — the fix addresses the mechanism directly
   (Electron's own single-instance API), so it should hold regardless of exactly how the user
   ended up with two processes.
2. **Dictation continuation was silently blocked in always-listening mode.** The
   `activationMode === "always_listening"` "addressed" gate ran *before* the dictation
   fallback ever got a chance — ordinary continued speech ("How are you doing?") scores low on
   "is this addressed to an assistant" almost by definition, so every dictation-continuation
   utterance was rejected as `not_addressed` before reaching the code that would have typed it.
   Fixed: the addressed gate is now skipped entirely while `dictationActive` — the user already
   explicitly started dictating with a real command, so continued unrecognized speech during
   that session doesn't need to re-pass an "is this addressed to Dragon" check.
3. **`delete_text` almost never resolved.** Two compounding causes: the fast-path regexes in
   `matchDictationControl` required specific phrasing ("delete that", "delete everything") and
   didn't match a bare "Delete.", "Remove content.", or "Clear text."; and `resolve.ts`'s
   `delete_text` case *always* returned `null` even when Jev correctly recognized the intent,
   so there was no fallback once the fast path missed. Fixed: added a single shared, generously
   permissive `extractDeleteScope` in `extract.ts` (matches any `delete`/`remove`/`clear`/`undo`
   phrasing — safe to be generous since it's only ever consulted while a dictation session is
   already active) used by *both* the fast path and `resolve.ts`'s `delete_text` case, which
   now returns a real `ResolvedCommand` instead of `null`. `pipeline.ts`'s `executeCommand`
   gained a `delete_text` case that requires an active dictation session (clear error
   otherwise) and delegates to the same delete-execution logic the fast path uses.
4. **"Type in hello" typed "in hello".** `extractDictatedText`'s regex captured everything
   after the trigger word verbatim, including filler like "in"/"out" ("type in X", "type out
   X" are both common phrasings). Fixed: the regex now optionally consumes a single filler word
   (`in`/`out`/`that`) right after the trigger before capturing the rest.
5. **`search_in_app` queries phrased as "go to X chat" / "open X's chat" extracted nothing**,
   only "search for X" worked. Added `go to X (chat|channel|conversation|dm|profile)`, `open/
   click on X's chat`, a bare `go to X` fallback, and `find X` to `extractSearchQuery` (ordered
   most-specific first so the trailing "chat"/"'s" gets stripped when present).

**Verification performed:** unit-checked all five extraction fixes directly against the exact
transcripts from the supplied logs (`extractDictatedText("Type in hello...")` →
`"hello..."`; `extractDeleteScope` against `"Delete."`, `"Remove content."`, `"Clear text."`,
`"delete the last 3 words"`, `"undo that"` → all resolve to a sensible scope;
`extractSearchQuery` against `"Go to Anushi's chat."`, `"Go to Anshul."`, `"go to hardship
chat"`, `"Open Anshul Gupta chat."` → all now extract a clean name). The single-instance-lock
and bind-error fixes were verified by direct reproduction (see above), not just inspection.

## 2026-09-21 — First pass on real Windows 11: five real bugs, all in the shared decision layer

The first real `win32` run produced the expected rough edges, and — importantly — *none* of
the suspected Windows-specific risk spots (see PROGRESS.md's risk list: `Add-Type` in a
`-Command` invocation, `keybd_event` injection, `FileVersionInfo.FileDescription`, Alt+Tab
timing, third-party launch tokens) actually failed. The Windows automation adapter ran the
app-activation, fullscreen, key-press, select-all, and search commands cleanly with no
exceptions and double-digit millisecond execution. Every real bug was in exactly two shared
files: `extract.ts` and `resolve.ts`.

1. **`findAppCandidates` used plain substring matching, so "Open Gmail" opened the Mail app.**
   "gmail" contains "mail" → the Mail alias matched, Jev was handed `app:Mail` as the only
   candidate, picked `open_app`, and the user got the Windows Mail app instead of gmail.com.
   Fixed: word-boundary regex matching (`\bkey\b`) with regex-metachar escaping instead of
   `lowerT.includes(aliasKey)`. (Same class of false positive would have hit any site whose
   name contains an alias key, e.g. "warp" inside a longer word.) Labels are still compared by
   exact equality, so the `zoom.us` label is unaffected.
2. **`openAppOverride` hijacked "Open right dot com **on Chrome**" into a bare app re-focus.**
   "chrome" appears as a *locative* in the sentence, matched the app candidate, the override
   blindly returned `activate_app`, and right.com was never navigated to. The URL-extraction
   signal lost. Fixed: the override now returns `null` whenever `payload.url` is present — a
   concrete extracted URL (from the closed website vocabulary or a dot-com pattern) is always
   a stronger navigational signal than an app-name substring match. "open cursor" /
   "open chrome" (no URL) still override exactly as before.
3. **"Open YouTube Music." was `resolution_failed` even though it's a known website.**
   `extractUrl` knew it (music.youtube.com), Jev picked `open_app` (fine — the phrase *is*
   "open X"), but there was no app alias "youtube music" and no fallback, so resolution died.
   Fixed: `open_app`/`activate_app` in `resolve.ts` now route to `chrome_open_url` whenever a
   URL was extracted (URL wins over app-focus); only URL-less utterances fall through to the
   app candidate path. This subsumes the fix for #2's Jev-side path too.
4. **"Press control c" / "Press control z" were unrecognized.** Only semantic names
   ("copy", "undo") existed in `KEY_PHRASE_NAMES`; the literal key-combo phrasing resolved to
   nothing (`shortcut` + no `keyName` → `resolution_failed`). Fixed: `extractKeyName` gained a
   `control/ctrl/command/cmd <letter>` → semantic-action table (c→copy, v→paste, x→cut,
   a→select all, z→undo, y→redo, s→save, f→find, t→new tab, w→close tab, q→quit, r→refresh),
   consulted only when no known phrase already matched. The platform layer still resolves the
   *semantic* name to its OS-specific combo, so "command c" on macOS and "control c" on
   Windows both land on the right key via the existing `KEY_SPECS` table.
5. **Browser DOM actions on non-scriptable pages threw a raw error.** "Scroll down" /
   "Scroll page" while a `chrome://`/blank/PDF tab was active failed with the terse Chrome
   message "Could not establish connection. Receiving end does not exist." (no content script
   can run there — Chrome limitation, not a Dragon bug). Fixed: `background.js` now catches
   that specific error and returns an actionable explanation
   ("This page doesn't support Dragon's browser control — try a regular web page.").

**Not fixed, deliberately:** the first "Open new tab" before the extension connected
(no extension yet — correctly reported); the scroll failure on tab 0 if that tab is
`chrome://new-tab-page` (content scripts can't run there by Chrome design); "Open antigravity"
(a genuinely unknown target — correctly ignored); "Detailed entire paragraph" (STT mishears
of "delete the entire paragraph" — no dictation session was active, correctly ignored);
"Delete." / "delete text" with nothing typed (correct "Nothing to delete" guard).

**Verification performed:** 20-assertion harness (`/tmp/opencode/verify-windows-fixes.js`)
against the compiled `dist/decision/*` modules with `electron` stubbed (the DECISIONS.md
documented harness pattern), covering every bug case above plus unchanged-behavior guards
("Open Chrome." still activates, "open cursor" override still fires, "Press enter." /
"Select all." still resolve, all alias keys in both platform registries verified word-char
only). Full `npm run build` + `npm run typecheck` + `node --check` on background.js all clean.
