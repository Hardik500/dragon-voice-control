# PROGRESS.md — Living status

## Current milestone

**Milestone 8 (Windows packaging and documentation) — implementation complete for both
platforms, pending real macOS *and* real Windows hardware verification.**

All eight milestones from the updated plan have working code: the shared macOS alpha
(Milestones 1-5), the extracted `PlatformAutomation` boundary (Milestone 6), the Windows
execution adapter (Milestone 7), and Windows packaging/docs (Milestone 8). The voice
dictation/editing feature, site-aware search, tab reuse, and generic in-app search requested
alongside Windows support are also implemented. Everything builds and typechecks cleanly on
this Linux sandbox; everything verifiable without real macOS/Windows hardware or live API
keys has been smoke-tested (see "Manual check results" below for exactly what that means).

## Completed capabilities

- **Electron/TypeScript skeleton**: tray/menu-bar app, settings window, floating overlay
  window, hidden mic-capture window, JSON settings persisted to `userData/settings.json`,
  JSONL logging from process start, global shortcuts for push-to-talk-toggle, emergency stop,
  Insert Mode, and Workflow Mode (platform-specific defaults: `Alt+Space`/`Alt+Escape` on macOS,
  `Control+Alt+D`/`Control+Alt+Escape` on Windows, plus `Control+Alt+I` and
  `Control+Alt+Shift+W` for modes). Shortcut registration failure is surfaced in both the log
  and a Settings-window warning banner, not just logged.
- **Microphone capture**: hidden renderer requests `getUserMedia`, downsamples to 16 kHz mono
  Int16 PCM in-browser, streams frames to the main process over IPC, which forwards them to
  Deepgram. Media permission auto-granted for the app's own windows.
- **Deepgram Flux streaming STT**: connects to `wss://api.deepgram.com/v2/listen`, parses
  `Connected`/`TurnInfo`/`Error` messages, tracks turn index → utterance ID, surfaces
  `Update`/`StartOfTurn`/`EagerEndOfTurn`/`TurnResumed`/`EndOfTurn` events, and records STT
  turn latency. Accuracy-oriented Flux settings use a higher final end-of-turn threshold
  (`0.8`), an `8s` final-turn timeout, and a small Dragon app/command keyterm list.
- **Jev via OpenRouter**: single combined request per utterance with `complete` + `intent` +
  `target` + `direction` (+ `addressed` in always-listening mode) questions; typed answers
  resolved against deterministically-extracted payload into a concrete `ResolvedCommand`. A
  narrow, deterministic code-level override (`resolve.ts`'s `openAppOverride`) corrects for
  Jev occasionally misclassifying the extremely common "open/launch/start X" pattern.
- **Shared `PlatformAutomation` boundary** (`src/automation/types.ts`/`index.ts`): the pipeline
  imports one `automation` object selected by `process.platform`; never touches
  `macos.ts`/`windows.ts` directly. Vocabulary is split the same way
  (`commands/registry-common.ts` + `registry-macos.ts`/`registry-windows.ts`, selected by
  `commands/registry.ts`, which throws at startup if either platform is missing a common
  name). Voice-alias → executable resolution happens inside each platform module using its
  own registry; shared code only ever sees alias keys (`AppCandidate.appAlias`).
- **macOS execution** (`src/automation/macos.ts`): open/activate/hide/quit app, switch to
  previous app (Cmd+Tab), clipboard-paste text entry, named-key press table (including a
  "delete word" and "quick switcher" entry added for dictation/search-in-app), shortcuts,
  window minimize/close/fullscreen("maximize" = fullscreen), volume up/down/set/mute/unmute,
  media play-pause/next/previous (Spotify then Music, via plain `pgrep` — no Accessibility
  needed), System Settings panes, Finder locations, `say` with barge-in cancellation,
  active-app detection, a friendlier error message for the classic
  "osascript is not allowed to send keystrokes" Accessibility-permission failure, and a new
  `deleteBackward(count)` (precise multi-backspace in one process call, for dictation editing).
- **Windows execution** (`src/automation/windows.ts`, new): every `PlatformAutomation` method
  implemented via per-action `powershell.exe` processes with an inline C# `User32` P/Invoke
  helper (`keybd_event`, `GetForegroundWindow`, `SetForegroundWindow`, `ShowWindow`,
  `PostMessage`, `GetWindowThreadProcessId`). App launch via `cmd.exe /c start "" <token>`
  (Win+R-style resolution); Chrome gets explicit install-path probing
  (`Program Files`/`Program Files (x86)`/per-user `LocalAppData`). Alt+Tab via a real
  hold-Alt/tap-Tab/wait/release-Alt sequence (more reliable than a bare SendKeys). Active-app
  name comes from the foreground window's process's `FileVersionInfo.FileDescription` (so
  Chrome reports as "Google Chrome", matching the macOS convention, with no manual mapping
  table needed). **Unverified on real Windows hardware** — see below for exactly what was and
  wasn't checked.
- **Chrome extension + bridge** (unchanged by the Windows work — pure JS, identical on both
  OSes): unpacked MV3 extension with a content script that snapshots visible interactive
  elements and performs click/type/select/scroll; a background service worker owning the
  WebSocket connection to the desktop app, handling navigate/search/back/forward/reload/
  new-tab/close-tab/switch-tab, plus a new `focus_or_open` action (reuse an existing tab
  matching the target hostname instead of always opening a new one — "open my existing tabs").
  A `chrome.alarms` keepalive fights MV3 service-worker eviction.
- **Two activation modes**: push-to-talk (toggle) and always-listening (the `addressed` question is
  worded to not require literally naming the assistant — a plain "open chrome" counts).
- **Voice dictation and in-session editing** (new): after any "type X" command, or explicitly
  saying "start typing"/"insert mode", subsequent utterances Jev doesn't recognize as another
  command are typed verbatim and folded into a tracked `dictationBuffer`, so the user doesn't
  have to repeat "type" every sentence. Recognized key presses and shortcuts execute and keep
  insert mode active; app/browser/media commands are deliberately typed as text while Insert
  Mode is active. Keyboard phrases embedded inside a longer dictated sentence remain text; only
  standalone final keyboard commands execute, and interim keyboard decisions wait for the final
  transcript. Say "stop typing" or
  "exit insert mode" to leave explicitly. A small deterministic (no-Jev-round-trip) set of
  editing phrases works on that tracked buffer with exact character counts: "new line", "delete
  the last N words"/"delete the last word", "delete/undo that" (last chunk only), "delete
  everything"/"clear all of that", and "replace X with Y" (backspaces only the changed tail,
  retypes only the changed suffix).
- **Site-aware search & generic in-app search** (new): `chrome_search` uses a URL-template
  table (`SITE_SEARCH_TEMPLATES`) keyed by the *current* page's hostname when Chrome is on a
  known site (YouTube, YouTube Music, GitHub, Reddit, Amazon, Wikipedia, Netflix, X/Twitter),
  instead of always falling back to a generic Google search. A new `search_in_app` intent
  presses Cmd/Ctrl+K (the near-universal quick-open/jump-to convention — Slack, Notion,
  VS Code, Discord, etc.) and types the query, for non-browser apps.
- **Reliability controls**: only `EagerEndOfTurn`/`EndOfTurn` trigger a Jev call; max 2
  concurrent Jev requests with oldest-abort; `TurnResumed` aborts the in-flight request;
  per-utterance `executedUtterances` set prevents duplicate terminal actions; interim
  execution restricted to a closed intent set; identical (utteranceId, text) Jev calls are
  cached instead of re-sent; the completeness gate (`complete < 0.5`) now only applies to
  *interim* turns — a final (`EndOfTurn`) turn is judged on intent recognition alone, since
  Jev's "complete" answer reflects sentence-grammar completeness, not speech completeness, and
  a short final command like "Open Slack?" was previously rejected despite being fully spoken.
  Deepgram auto-reconnects after an unexpected drop, but only if the connection had actually
  opened before dropping (not a connection that never opens at all, e.g. a bad key — that
  would otherwise retry forever), capped at 5 attempts.
- **Overlay, voice replies, history, logs**: floating always-on-top overlay; short native
  spoken acknowledgements with barge-in; command history persisted and viewable/clearable from
  Settings; JSONL debug logs rotated per day with key/audio redaction, now including explicit
  latency breakdowns (`sttTurnMs`, `sttToDecisionMs`, `decisionMs`, `jevMs`, `executionMs`,
  `totalMs`) on decision and execution events. Action
  confirmations now remain visible for five seconds across immediate idle/listening updates so
  the result can be read before it is replaced by the next turn.
- **Jev decision dashboard**: a standalone, read-only local web app is available at
  `http://127.0.0.1:17873/dashboard`. It shows a bounded, session-only view of the latest Jev
  calls, including the selected `intent`/`target`/`direction`, confidence, selected-choice
  probability bars, top alternatives, transcript, model, timing, resolved action, execution
  outcome, and a compact recent-exceptions list. The same choice probability distributions are
  included in the structured `jev.response` JSONL event. The tray menu and Settings both provide
  an **Open Dashboard** action.
- **Settings UI**: paste OpenRouter/Deepgram keys, activation mode, all four global shortcuts,
  voice-reply toggle, log verbosity, open-logs button, history table + clear button, and a
  shortcut-registration-failure warning banner. Mode toggles are independent from the
  microphone/listening state; the tray and overlay show the active interaction mode.
- **Unsigned packaging for both platforms**: `electron-builder.yml` has both a macOS `dir`
  target and a Windows `portable` target (`npm run package:mac` / `npm run package:win`), with
  a real `.ico` (hand-built, `file`-verified as a valid multi-size PNG-compressed icon
  container — no external icon tool needed) and a Windows-appropriate colored tray icon.

## Manual check results (this environment: Linux/WSL2, no macOS or Windows machine)

What was actually run and observed, this round:

- `npm run typecheck` / `npm run build` succeed cleanly after the full Windows-boundary
  refactor, the latest log-driven fixes, and the Jev dashboard UI additions.
- The standalone Jev dashboard server/page/API were exercised with a stubbed Electron process;
  the page and `/api/decisions` endpoint responded correctly. Live browser rendering and Windows
  shell integration remain unverified in this Linux sandbox.
- `npx electron . --dev` boots cleanly end-to-end (tray/windows/IPC/logging all initialize,
  clean shutdown) — `automation/index.ts`'s Linux dev-only fallback (uses the macOS module,
  logs `automation.unsupported_platform_dev_fallback`) makes this possible; real end users on
  Linux get a hard error instead.
- **Windows registry coverage** verified by monkey-patching `process.platform` to `"win32"`
  and requiring `dist/commands/registry.js` directly — the startup coverage check
  (`checkCoverage` in `registry.ts`) passed, confirming `registry-windows.ts` has an entry for
  every name in `registry-common.ts`'s `KEY_PHRASE_NAMES`/`SETTINGS_PANE_NAMES`/
  `LOCATION_NAMES`.
- **Windows automation logic** verified with a purpose-built harness: monkey-patched
  `require("electron")` to a stub and `child_process.execFile`/`spawn` to capture arguments
  instead of executing them, then called every `PlatformAutomation` method with `process.
  platform` forced to `"win32"`. Confirmed (by reading the captured PowerShell/`cmd` text) that
  `openApp`, `activateApp`, `quitApp`, `windowMinimize`, `pressNamedKey` (both a plain
  virtual-key case and a Ctrl+letter case), `deleteBackward`, `typeText`, `switchToPreviousApp`,
  `getActiveAppName`, `openFinderLocation` (both a plain folder and a `shell:` URI),
  `openSettingsPane`, and `say` all produce syntactically plausible, correctly-parameterized
  scripts — virtual-key codes checked by hand (e.g. Ctrl+A → `keybd_event(17,...)` then
  `keybd_event(65,...)`; Alt+F4 for "close window" → `keybd_event(18,...)` then
  `keybd_event(115,...)`). **This never executed a real `powershell.exe`/`user32.dll` call.**
- `npm run package:win` (`electron-builder --win portable --x64`) produced a real, valid,
  unsigned Windows PE32 portable `.exe` (`file` confirmed: "PE32 executable (GUI) Intel 80386,
  for MS Windows, Nullsoft Installer self-extracting archive") — no `wine` installed on this
  machine, so electron-builder's portable target evidently doesn't need it. This proves the
  packaging *config* is valid and *buildable*, not that the resulting exe runs correctly on
  Windows (untested — no Windows machine).
- Re-ran `npm run package:mac` (`electron-builder --mac --arm64 --dir`) after all the changes
  in this pass — still produces a valid unsigned `.app` bundle (as `darwin-x64` from this x64
  Linux host, same caveat as before; needs a real Apple Silicon Mac to confirm true arm64
  cross-compilation).
- Extraction/resolution unit checks against the exact failing transcripts from two real macOS
  test runs (logs supplied directly by the user, not reconstructed):
  - `"Open cursor."` with Jev answers matching *both* observed misclassifications
    (`intent: "none"` and `intent: "shortcut"`, both low confidence) → both now resolve to
    `{ kind: "activate_app", appName: "Cursor", appAlias: "cursor" }` via the new override.
  - `"Open Slack?"` with `intent: "open_app"`, `complete: 0.31` → now resolves correctly (the
    completeness gate no longer blocks a final turn).
  - `extractDeleteWordCount`: "delete the last 3 words" → 3, "delete the last few words" → 3,
    "delete the last word" → 1.
  - `extractReplacePair("replace draft with final")` → `["draft", "final"]`.
  - Site-aware search: with a mock Chrome page on `music.youtube.com`, "search for imagine
    dragons" → `siteSearchUrl: "https://music.youtube.com/search?q=imagine%20dragons"`.
  - (From an earlier pass, re-confirmed still passing): "open notepad" → TextEdit; "type hello
    from dragon" → exact verbatim text; "set volume to 40" → 40; "search for X dot com" → a
    direct URL, not a literal Google search for the words "dot com".

What could **not** be verified in this environment, and exactly what to do about it:

1. **Everything Windows-specific, on real hardware.** The harness above checked that the
   generated PowerShell/`cmd` text is syntactically sound and correctly parameterized, but
   never ran it. → *Manual step*: run the Windows manual check below on Windows 11 x64.
2. **Deepgram/OpenRouter live calls, real microphone capture, real Accessibility permission
   flow, real Chrome extension loading.** Unchanged from before this pass — see the equivalent
   section in git history / the macOS manual check below.
3. **arm64 macOS packaging and real Windows portable-exe execution.** Both package builds
   succeeded structurally on this x64 Linux host; neither was run on its target architecture/OS.
4. **The dictation buffer-drift risk.** If the user manually clicks elsewhere, edits the text
   by hand, or an app rejects the paste Dragon assumes succeeded, `dictationBuffer` silently
   goes out of sync with reality, and a later "delete the last 3 words" will backspace the
   wrong number of characters. Documented as an accepted limitation (see DECISIONS.md); not
   fixable without reading the target app's actual text content, which is out of scope.
5. **The `search_in_app` Cmd/Ctrl+K assumption and the "ambient phrase collides with an editing
   command" risk** (e.g. dictating a sentence that happens to literally be "delete that") are
   both best-effort/accepted trade-offs, not yet observed in real use.

## Known limitations / simplifications (see DECISIONS.md for full reasoning)

- Push-to-talk is a toggle, not press-and-hold.
- macOS: "maximize" window = fullscreen toggle. Windows: "maximize"/"fullscreen" are two
  genuinely different things (`ShowWindow(SW_MAXIMIZE)` vs. F11), since Windows actually has a
  real maximize concept unlike macOS.
- Windows: exact volume percentage (`volume_set`) is not implemented — throws a clear error
  suggesting "volume up"/"volume down" instead (would need Core Audio COM interop; deferred
  per the plan). Windows `volume_mute`/`volume_unmute` both send the same hardware mute-toggle
  key — there's no separate set-true/set-false without that same COM interop, so "unmute"
  while already unmuted will mute it.
- Windows: third-party app launching (Slack, Discord, Cursor, Docker Desktop, etc.) is
  best-effort — works if the app is on `PATH` or registered a Windows "App Paths" registry
  key (true for Chrome, Firefox, VS Code with "Add to PATH", Office), may fail for apps
  installed only via a per-user/appx installer that registers neither. Only Chrome gets
  explicit install-path probing.
- Media controls only work if Spotify or Music.app (macOS) is the active player; Windows uses
  the OS-level media keys, which work with whatever app is registered with Windows' System
  Media Transport Controls (broader coverage than macOS's per-app AppleScript approach).
- The Chrome bridge assumes a single Chrome window/extension connection at a time.
- Manifest V3 service workers go idle; `background.js` reconnects on a 2s timer plus a
  `chrome.alarms` keepalive every 30s, so there can be a brief window right after Chrome starts
  (or after long idle) where a DOM command fails with "Chrome extension is not connected"
  until it reconnects. `chrome_open_url`/`chrome_search` are unaffected (don't need the
  extension) unless a matching existing tab needs to be found, in which case they fall back to
  always opening a new tab/window.
- Dragon runs one command per utterance by design — "open Slack, search for X, and type a
  message" must be spoken as three separate commands, not one. See AGENTS.md.
- No automated tests, by design (see AGENTS.md / plan non-goals).

## Bug-fix history

See `DECISIONS.md` for full write-ups (dates, reasoning, verification performed) of each pass.
Summary, oldest to newest:

1. Wake-word/always-listening modes didn't auto-start listening (`listening` flag never set).
2. Second pass: wake-word gave no feedback when the phrase was absent; always-listening's
   `addressed` question wrongly required naming the assistant; `stopStreaming`'s wrapper
   dropped its `{graceful}` argument; every Settings save stopped an active session; the tray
   menu went stale after non-tray-driven state changes; no auto-reconnect after a dropped STT
   connection; browser-snapshot fetching gated on a flaky frontmost-app read; media
   `isAppRunning` needed Accessibility unnecessarily; missing common app aliases; MV3
   service-worker eviction.
3. Third pass: relaunching into a continuous mode didn't actually start listening (seeded from
   the wrong default); spoken "X dot com" never became a URL; the second pass's auto-reconnect
   retried forever against a permanently-bad connection.
4. Fourth pass: a fully-spoken final command could be rejected as "incomplete" (completeness
   gate applied regardless of finality); "open cursor" still occasionally misclassified
   (added a deterministic override); latency logging was thin (added `sttToDecisionMs`/
   `totalMs` throughout); unfriendly Accessibility-permission error message.
5. Fifth pass: added Windows support end-to-end (Milestones 6-8), voice dictation/editing,
   site-aware search, tab reuse, generic in-app search.
6. Sixth pass, from a real macOS run of the fifth pass's build: the Chrome extension could not
   connect at all (`ERR_CONNECTION_REFUSED`) because a second Dragon process was silently
   holding the WebSocket port with no user-visible error — added
   `app.requestSingleInstanceLock()` plus a proper bind-failure surface (Settings warning
   banner). Also: dictation continuation was completely blocked in always-listening mode (the
   "addressed" gate ran before the dictation fallback could apply); `delete_text` almost never
   resolved (narrow fast-path regexes plus an always-`null` Jev-path fallback); "type in X"
   typed a spurious leading "in"; `search_in_app` couldn't extract a query from "go to X chat"
   phrasing (only "search for X" worked).
7. Seventh pass, the first real Windows 11 run (win32/x64, logs supplied): the Windows smoke
   test itself passed cleanly — app activation, fullscreen, restore, key presses, select-all,
   open-new-tab (after the extension connected), Chrome search, and Gmail's app-launch all
   executed with no exceptions and normal latencies, and none of the anticipated
   Windows-specific risks (Add-Type script compilation, `keybd_event` injection, Alt+Tab
   timing, launch tokens) surfaced. All five actual bugs were in the shared decision layer
   and are fixed in this commit: (1) `findAppCandidates` substring matching made "Open
   Gmail" launch the *Mail app* — now word-boundary matched; (2) the "open cursor" override
   hijacked "Open right dot com **on Chrome**" into a bare app re-focus because "chrome" was
   locative — the override now backs off whenever a URL was extracted; (3) "Open YouTube
   Music." failed to resolve even though it's a known website — `open_app`/`activate_app`
   now fall back to `chrome_open_url` whenever a URL exists; (4) "Press control c" /
   "Press control z" were unrecognized — `extractKeyName` now maps
   `control/ctrl/command/cmd <letter>` to the semantic action; (5) DOM actions on
   `chrome://`/still-loading tabs threw the raw Chrome "Receiving end does not exist" error —
   the extension now returns an actionable message instead.
  8. Eighth pass, from the latest supplied Windows run: added the missing `antigravity` app
    alias on both platforms; routed File Explorer locations through the successful shell-start
    handoff instead of treating Explorer's process exit status as the operation result; allowed
    exact high-confidence media commands such as `Pause.` through the always-listening
    addressed gate; retained action confirmations for five seconds; and added the session-only
    Jev decision dashboard with choice probabilities and alternatives. The dashboard and Windows
    Explorer/Antigravity behavior still require live Windows verification.

  9. Ninth pass, from the additional Windows log: added STT-turn and Jev timing to the dashboard;
     raised Flux's final-turn threshold to `0.8`, added an `8s` final-turn timeout, and added
     Dragon keyterms for higher-accuracy recognition. Fixed spoken `dot two` → `dev.to` URL
     normalization, stripped trailing `on Google`/`on Google dot com` from search queries, and
     serialized EagerEndOfTurn/EndOfTurn Jev requests per utterance to stop repeated calls from
     cancelling each other. Added a narrow browser-element fallback for explicit `click on X`
     phrases when Jev mislabels them as an app command. The new live accuracy and timing
     settings still require a real Windows run.

  10. Tenth pass: dashboard traces now carry the resolved action, execution latency, and
      pending/success/ignored/error/cancelled outcome. The page shows session counters, a compact
      STT → Jev → action latency strip, recent outcomes, and a small meaningful-exceptions list.
      Outcome updates are attached by utterance ID so EagerEndOfTurn and EndOfTurn traces do not
      produce false duplicate outcomes.

  11. Eleventh pass: added persisted Insert Mode and Workflow Mode shortcuts, independent mode
      toggles, tray/overlay state, workflow step progress, and Emergency Stop cleanup. Workflow
      Mode currently accepts sequential one-utterance browser/app commands and stops on a failed
      step; it is not yet a free-form multi-step planner.

  12. Twelfth pass, from the latest Windows run: constrained comma/`then` workflow utterances now
      split into sequential Jev-backed steps, and each step has explicit started/completed/failed
      logging. Voice aliases now accept natural mode transitions such as "switch to insert mode"
      and "stop workflow mode". The generic embedded-keyboard boundary was confirmed by the live
      log: a long sentence containing "Press enter" is typed instead of executed.

  13. Thirteenth pass, from the latest Windows run: Insert Mode is now text-only for non-keyboard
      input. `Open Chrome.` and `Maximize window.` are now dictated while Insert Mode is active;
      normal app/browser commands require leaving Insert Mode. Keyboard/editing controls remain
      executable, and the text-first path bypasses Jev entirely.

  14. Fourteenth pass, from the latest dashboard observation: the dashboard now collapses Jev
      traces to one canonical row per `utteranceId`, preferring the terminal/final result. Local
      deterministic controls mark any earlier Eager Jev result as cancelled and hide it from the
      dashboard, so stale `Enter` / `Start typing` requests no longer look like duplicate commands.
      The Jev answer cache now normalizes case, terminal punctuation, and whitespace, preventing
      `Open Notepad.` / `Open notepad.` and similar Eager/End variants from making another request.
      Duplicate suppression still prevents repeated execution; the dashboard now presents the
      terminal decision per utterance.

  15. Fifteenth pass, from the latest Windows log review: the cache normalization is visible in
      practice (`Minimize notepad.` and `Open Gmail dot com` reuse the Eager decision), while
      materially revised transcripts still make new requests as expected. The remaining concrete
      gaps are browser-element coverage (`Click on reply.` returned zero candidates), Chrome
      extension connection churn (five connections during one startup), and end-to-end latency
      outliers dominated by STT final-turn latency (up to 3.3 seconds in this session).

  16. Sixteenth pass: browser-target resolution failures now report that no matching clickable
      element was found, the dashboard history shows Jev's target separately from Dragon's resolved
      action, and Deepgram keyterms now include the Insert/Workflow mode phrases. The Chrome
      extension now uses a single-flight connection guard with one reconnect timer so startup,
      alarms, and stale service-worker events cannot create overlapping sockets. TypeScript build
      and extension syntax checks pass; real Windows behavior still needs verification.

  17. Seventeenth pass: lowered Flux's final EOT threshold from `0.8` to `0.7` after analyzing 108
      recorded utterances. At `0.7`, 65 utterances had a usable Eager transcript versus 33 at
      `0.8`, with a median Eager-to-final gap of about 46 ms. The active STT thresholds are now
      logged at connection time; real Windows accuracy and latency comparison remains pending.

  18. Eighteenth pass, from the `dragon-2026-09-25.jsonl` log: fixed Wake Word mode's standalone
      wake-word handling. `Dragon.` no longer leaves `.` for Jev; it arms a 10-second window for
      the next command, while `Dragon open Chrome` remains supported. The log also showed a Deepgram
      `INACTIVE_CLIENT` disconnect after 60 seconds without a ping; the STT client now closes
      protocol-error sockets immediately so the existing reconnect path runs deterministically.
      Real Windows behavior remains to be verified.

  19. Nineteenth pass: removed Wake Word mode from the active product surface to keep the alpha
      simple. Existing persisted `wake_word` settings migrate to `always_listening`; wake-word
      settings, stripping, latching, tray/UI options, and current documentation were removed. The
      Deepgram protocol-error reconnect fix remains.

  20. Twentieth pass: added an explicit decision-provider seam for Jev and Laya. Jev remains the
      default through OpenRouter; Laya uses a separately running local `laya-server` at a loopback
      HTTP URL, with configurable model and a Settings connectivity check. The shared question
      builder, resolver, and execution path are unchanged. Provider/model are now included in logs
      and dashboard traces, and Laya failures do not silently fall back to Jev. Laya model startup,
      Windows support, and live comparison runs remain unverified.

## Exact next task

Re-test on Windows with this build, paying attention to the fixed decision-layer bugs and to
the extension-connected tab state:

- DOM-level commands (click/type/select/scroll) now return an explicit
  "This page doesn't support Dragon's browser control" error instead of the raw
  "Receiving end does not exist" when the active tab is a `chrome://` page, PDF, or still
  loading — navigate to a normal web page and retry. Make sure the extension is loaded and a
  regular page is active before testing "open new tab" / "scroll down" / clicking.
- Re-exercise the previously-broken phrases: "Open Gmail." (must navigate to gmail.com, not
  launch the Mail app), "Open right dot com on Chrome." (must actually open right.com),
  "Open YouTube Music." (must open music.youtube.com), "Press control c" / "Press control z"
  (copy / undo).
- The brief `browser.extension_disconnected` → `extension_connected` blip ~2s after boot in
  the supplied log looked harmless (single reconnect), but keep an eye on it — if repeated
  disconnect/reconnects appear during a session, that's worth its own look.
- Re-test "Open Antigravity." (now has a closed-vocabulary alias), "Go to desktop." (now uses
  the shell-start handoff), and bare "Pause." in always-listening mode. Re-test
  "Search for learn Japanese on Google dot com." (the query should be only "learn Japanese") and
  "Open dev dot two on Google." (should resolve to dev.to). For insert mode, say
  "Start typing", dictate two sentences, say "Press enter", dictate another sentence, then
  "Stop typing"; verify the keyboard action executes and ordinary speech continues typing. While
  Insert Mode is active, say "Open Chrome" and verify it is typed as text; leave Insert Mode before
  testing normal app commands.
  Open
  `http://127.0.0.1:17873/dashboard` after a few commands to inspect provider probabilities and
  STT/provider timing; compare the accuracy change against the observed STT-turn latency.
- Start `laya-server` separately, select **Laya via local server** in Settings, save, and use
  **Test decision provider**. Run the same app/window/browser commands with Jev and Laya separately;
  compare provider latency, model output, and action agreement. Keep Jev selected when Laya is
  unavailable so the failure is explicit.
- Press `Control+Alt+I` to toggle Insert Mode without changing microphone state, then press it
  again to leave. Press `Control+Alt+Shift+W` to start a sequential Workflow Mode session,
  execute two browser steps, and press it again to finish. Confirm Emergency Stop clears both
  modes and the dictation buffer.

Still unverified on real hardware (documented, not bugs): the dictation/editing flow on
Windows, Windows-specific automation against third-party apps (Slack/Discord/Cursor/Docker),
and the Alt+Tab switch timing.

macOS track is unchanged: work through the "macOS check" in `README.md` on a real Mac,
particularly the dictation/editing commands and site-aware search.

Then remove this paragraph and mark milestone 8 as fully verified in this file.
