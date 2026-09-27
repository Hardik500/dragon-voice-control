# PROGRESS.md — Living status

## Current milestone

**Milestone 8 (Windows packaging and documentation) — implementation complete for both
platforms, and both have been run on real hardware.**

All eight milestones from the updated plan have working code: the shared macOS alpha
(Milestones 1-5), the extracted `PlatformAutomation` boundary (Milestone 6), the Windows
execution adapter (Milestone 7), and Windows packaging/docs (Milestone 8). The voice
dictation/editing feature, site-aware search, tab reuse, and generic in-app search requested
alongside Windows support are also implemented.

**Verification status.** Windows 11 x64 has been run repeatedly and is where all recent work is
verified, including the focus, window-targeting and latency fixes. macOS has been run several
times on real hardware with real logs (see pass 6 below and the 2026-09-21 entries in
`DECISIONS.md`), the most recent on the Windows-support/dictation build. The shared-code changes
made since that macOS run — STT `numerals`/keyterms/`eager_eot_threshold`, and the pipeline
latency restructure — have not been re-run on macOS. The Windows-only changes cannot affect it.
Both platforms are supported and both are expected to have bugs; they are simply not exercised
to the same depth.

Everything builds and typechecks cleanly on this Linux sandbox; everything verifiable without
real hardware or live API keys has been smoke-tested (see "Manual check results" below for
exactly what that means).

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

  21. Twenty-first pass: added a managed external `laya-server` lifecycle. Settings can start and
      stop the command, Dragon polls the local health endpoint until the model is ready, and an
      already-running compatible server is detected but not killed. The command is configurable for
      installations where `laya-server` is not on PATH; Python/model weights remain outside Electron.

  22. Twenty-second pass: added pinned macOS/Linux and Windows bootstrap scripts for the real
      `laya-server` project. The scripts install `uv` when needed, install the server at commit
      `0a2928f7ab415e8dd14bde483dc793e566c9f8fb`, and download the selected checkpoint into the normal
      Hugging Face cache. No model weights are committed to Git. Setup and real model download remain
      unverified in this environment.

  23. Twenty-third pass, from the first real Laya Dragon run: Laya is now receiving provider
      requests, but targetless commands returned HTTP 422 because the shared target question had
      only the `none` choice while System One requires at least two choices. Added a deterministic
      `other` fallback target candidate for the no-candidate case.

  24. Twenty-fourth pass: added a Laya-specific Always Listening addressed threshold of `0.50`,
      based on observed Laya `addressed` values around `0.52` for valid direct commands. Jev keeps its
      existing `0.55` threshold. The threshold and target-schema fixes still require a rebuilt Dragon
      run before their live effect can be confirmed.

  25. Twenty-fifth pass, from the latest Laya run: added a narrow deterministic `new tab` path
      (`new tab`, `open new tab`, and `open a new tab`) so the command bypasses provider intent
      classification and resolves directly to `chrome_new_tab`. Deterministic mode/edit controls
      now suppress interim provider calls and wait for the final turn before executing.

  26. Twenty-sixth pass, from the Jev run of 2026-09-25 17:31 (session `sess_muh8mvmn_l3klaf`),
      which showed four distinct classes of miss. All four are fixed; see DECISIONS.md for the
      heuristic-URL split.

      a. **"Open Google Chrome" never focused Chrome.** `extractUrl()` matched the `google` entry
         in `KNOWN_WEBSITES` (it's a substring of the `google chrome` app alias) and returned
         `https://www.google.com`, so `openAppOverride` bailed on `payload.url` and the
         `open_app` case resolved to `chrome_open_url`. The log shows Jev answering correctly —
         `open_app` / `app:Google Chrome` at confidence 1.0 with `appCandidates: ["Google
         Chrome"]` — and the app then navigating instead of launching. `extractUrl()` now returns
         `{ url, isHeuristic }`; a `KNOWN_WEBSITES` keyword hit is marked heuristic and a
         heuristic URL no longer outranks a matched app alias. An explicitly spoken domain
         ("open right dot com", "open right.com on chrome") still outranks it, so the earlier
         locative-app-name fix is preserved. Verified: "open google chrome" → `activate_app:chrome`,
         "open maps" → `activate_app:maps`, "open youtube" → still navigates, "open right.com on
         chrome" → still navigates.

      b. **The Always Listening "addressed" gate silently dropped real commands.** `Open Warp.`
         (`open_app`), `Escape.` (`press_key`), `Backspace.` (`delete_text`) and `Minimize Chrome.`
         (`hide_app`) were all discarded as `not_addressed` with the correct intent already
         recognized. The gate exempted only explicit media control; it now also exempts a
         standalone keyboard command and a deterministic `open <known app>` (reusing the
         `isDeterministicAppLaunch` predicate exported from `resolve.ts`, so the pattern isn't
         duplicated).

      c. **One utterance could fan out into several concurrent provider calls.** `runDecision`
         read `decisionInFlightByUtterance`, then `await`ed it, and only stored the new promise
         afterwards — two turns landing in the same tick both read the same predecessor, both
         resumed when it settled, and both ran. The log shows three `pipeline.decision_request`
         events 3 ms apart for `utt_1790357552068_8` and three `decision.response` events, with
         one execution. Beyond wasting calls, a response derived from a stale interim transcript
         ("Open Reddit dot") could win that race. The chain is now built synchronously, so only
         the newest link is ever read.

      d. **`Open camera.` failed to resolve twice.** No `camera` entry in the Windows
         `APP_ALIASES`, so `open_app` had no candidate. Added the Windows inbox apps a demo is
         likely to name: camera, clock, calendar, weather, sticky notes, snipping tool, voice
         recorder. These are protocol-handler launch tokens and, like every existing Windows
         entry, are best-effort and version-dependent — **not verified on a real Windows machine**.

      Verified by `npm run typecheck` and by two throwaway harnesses run against the built
      `dist/`: one asserting the resolve/extract behavior for all the phrases above plus
      regression guards, one replicating the old vs. new `runDecision` chaining shape to confirm
      peak concurrency drops from >1 to 1. `DragonPipeline` itself was not instantiated — that
      needs Electron and a real OS — so (b) and (c) are reasoned from the code paths plus the log
      evidence, not executed end to end.

  27. Twenty-seventh pass, from the Jev run of 2026-09-25 17:45 (session
      `sess_muh94ew6_vhsjgw`), which ran on a build including pass 26.

      **Pass 26 confirmed by this run:** "Open Chrome." and "Open Notepad." both executed
      `activate_app` (no google.com hijack), "New tab." twice and "Start typing." resolved
      through the deterministic dictation-control path, and — most clearly — every utterance now
      produced exactly **one** `pipeline.decision_request` followed by `decision_cache_hit` for
      later turns. The previous run had three concurrent requests for a single utterance, so the
      in-flight serialization fix is confirmed working against the real log.

      Two gaps remained:

      a. **Apps opened but never came to the foreground** (reported directly). `activateApp` called
         a bare `SetForegroundWindow`, which Windows refuses for any process that doesn't already
         own the foreground — and Dragon's short-lived PowerShell child never qualifies. The
         cold-start branch was worse: `Start-Process` returned as soon as the process existed and
         never tried to focus the new window at all, so "Open Notepad." from Chrome left Notepad
         behind. Rewritten to (1) `AttachThreadInput` our thread to the target window's thread and
         to the current foreground window's thread, which is what makes the activation calls take
         effect, (2) `BringWindowToTop` + `SetForegroundWindow` + `SetFocus`, (3) a synthetic Alt
         tap (the documented trick for making the caller foreground-eligible) and one more
         `SetForegroundWindow`. Two side fixes came out of the same rewrite: `ShowWindow` is now
         guarded by `IsIconic` so saying "open chrome" while Chrome is maximized no longer shrinks
         it back to normal, and a cold start polls up to 6s for the new main window instead of
         returning immediately.

         `openApp` now delegates to `activateApp` on Windows. It had become reachable again
         ("focus chrome" matches no `openAppOverride` pattern, so `resolveCommand` can return
         `open_app`), and `cmd /c start` on a running app is exactly the background-launch path
         being removed. Windows has no `open -a`/`activate` distinction worth keeping; macOS still
         keeps the two distinct.

      b. **"Start writing." failed twice with `resolution_failed`.** It isn't a mode-entry alias
         (`typing|dictation|insert mode|type mode`), so it fell through to Jev, which returned
         `type_text` — but `extractDictatedText` needs content after the verb, so there was nothing
         to type and resolution failed. Added `writing` / `write mode` / `writing mode` to the
         start aliases and `writing` / `stop writing` to the stop aliases. Verified not to collide
         with the dictated-text path: "write hello" still extracts `hello`, and "start writing my
         essay" is still not a mode command.

      Not fixed, and still worth knowing about before a demo: "Click on exact price video." hit
      `browser_target_missing` because the page snapshot came back with `elementCandidates: 0`.
      The surrounding requests on the same YouTube page returned 3–4 elements, and the empty ones
      cluster right after startup, so this looks like a snapshot racing page load rather than a
      selector problem. A retry on an empty snapshot would likely mask it, but that is an
      extension/page-state change that can't be validated from Linux, so it is left alone and
      recorded here instead.

      Verified by `npm run typecheck`, `npm run build`, and three throwaway harnesses: one dumping
      the exact generated PowerShell for `activateApp` (electron + child_process stubbed) and
      asserting the quoting of process names containing spaces, one for the mode-alias patterns,
      and one re-running pass 26's resolve assertions as a regression guard. **The PowerShell
      itself was never executed — there is no Windows machine here, so the foreground behavior is
      unverified and is the single most important thing to re-test.**

  28. Twenty-eighth pass: the floating overlay was sinking behind other apps. Reported as "when I
      ask to open chrome or other apps the floating bar goes behind them, instead it should
      always stay at the top."

      The overlay already passed `alwaysOnTop: true` at construction, so the cause is the reveal,
      not the flag: the window is built with `show: false` and only made visible later via
      `showInactive()`. On Windows the `WS_EX_TOPMOST` bit is applied when the window is shown, so
      a topmost hint set on a still-hidden window does not reliably survive into the first reveal
      — and both reveal paths (startup, and the tray's show/hide toggle) went straight to
      `showInactive()`.

      Added `showOverlay()` in `main/windows.ts`, which reveals the window and then re-asserts
      `setAlwaysOnTop(true, level)`. Both call sites in `index.ts` now route through it, and the
      overlay additionally re-asserts on its own `show` event so a future reveal path can't
      regress it silently. The level is platform-split: `screen-saver` (the highest `HWND_TOPMOST`
      band) on Windows, so the bar also beats other always-on-top windows, and `floating` on
      macOS, where that same level would float the bar above the menu bar and Dock.

      The Settings window was left alone — this report was specifically about the floating bar.
      Verified with `npm run typecheck` and `npm run build`, and by confirming no `showInactive`
      call remains outside the helper. Whether the bar actually stays above Chrome, Notepad, and
      a full-screen app is a window-manager behavior that still needs a real run to confirm.

  29. Twenty-ninth pass, from the Jev run of 2026-09-25 18:00 (session `sess_muh9od79_zlxyne`).
      Reported as: "we have difficulty when the user speaks a number, we always treat it as word."

      The log shows the user opened Calculator and then spoke numbers, twice:

      ```
      18:03:00.995 stt.turn        transcript="Two plus two"
      18:03:02.111 decision.response  intent=none  intentConfidence=0.86
      18:03:02.111 pipeline.ignored   reason=not_addressed
      18:03:06.035 stt.turn        transcript="Two four two"
      18:03:06.731 decision.response  intent=none  intentConfidence=0.56
      18:03:06.731 pipeline.ignored   reason=not_addressed
      ```

      Root cause: Dragon never asked Deepgram for numeral formatting. `deepgram-client.ts` builds
      the Flux `/v2/listen` query string by hand and passed no `numerals` parameter, so every
      spoken number reached the decision layer as an English word. Added `numerals=true` there (it
      is a connection-time parameter on Flux — sending it in a `Configure` message instead returns
      `UNPARSABLE_CLIENT_MESSAGE` and closes the socket) and logged the value in `stt.connected`
      so a future run can confirm it took effect.

      Verified with `npm run typecheck`, `npm run build`, and a throwaway harness that stubs `ws`
      and captures the real connection URL, asserting `numerals=true` is present alongside the
      existing params and that no key material lands in the query string. Also checked the
      downstream resolvers against digit-form transcripts: "type 2 plus 2" → `type_text("2 plus
      2")`, "type 5551234" → `type_text("5551234")`, "volume 50" → `volume_set(50)`, "delete the
      last 3 words" → count 3.

      Note that a bare "2 + 2" with no verb is still not a command and is still dropped outside
      Insert Mode — that is the documented one-command-per-utterance design, not a numerals
      problem. "type 2 plus 2", or entering Insert Mode first, are the working paths.

      One trade-off to watch, recorded in DECISIONS.md: Numerals also rewrites ordinals, so "the
      first post" can arrive as "the 1st post", and browser element candidates are scored by text
      similarity against the page. A click target labelled "First post" may match slightly worse
      against a digit-form transcript. Worth watching on the next browser run.

      The same session also incidentally confirms pass 27's cold-start work is running:
      "Open calculator." at 18:02:56 took `executionMs: 751` (a cold `Start-Process` plus the
      window poll) and still reported no error.

  30. Thirtieth pass: added 12 core command verbs to the Deepgram `keyterm` list — `open`,
      `close`, `minimize`, `maximize`, `scroll`, `click`, `type`, `search`, `press`, `delete`,
      `volume`, `mute` (33 keyterms / 47 tokens total, against a 500-token limit).

      Scanned all 94 transcripts in the last two days that changed between StartOfTurn and
      EndOfTurn. Most changes are ordinary refinement (`okay`→`open`, `click on`→`click`), but
      the genuine mishearings are almost all command words, none of which were boosted:
      `many`/`mindy`/`midima`→minimize, `match`/`maxim`→maximize, `glue`→close,
      `believe`/`delivery`→delete, `price`→press, `end of`→enter, `cons`→select,
      `that's`→backspace.

      Scope was deliberately kept to the verbs and not widened: deriving keyterms from the
      registry (61 app aliases + 47 key names, ~135 terms) was considered and rejected — app
      names are essentially never garbled in these logs (`browser` once), and broad aliases like
      `code`, `mail`, `word`, `notes` risk altering dictated text, which must stay verbatim.
      40 terms is much closer to Deepgram's own 20–50 guidance than 135 would have been.

      Note this is a best-effort knob, not a fix: `pause` and `play` were *already* keyterms and
      were still misheard (`balls`/`body`/`well,`→pause). Worth judging from the next run's
      transcripts rather than assuming.

  31. Thirty-first pass, from the Jev run of 2026-09-25 18:20 (session `sess_muhaddpf_tmoxje`).
      This run had both STT changes live — `stt.connected` logged `numerals: "true"` and
      `keytermCount: 33` — and both behaved: "2 plus 2" transcribed as digits rather than words,
      and "Open Google Chrome" executed `activate_app` against `app:Google Chrome` instead of
      navigating to google.com. The one-provider-call-per-utterance behavior also held.

      **Fixed:** `type_text` failed to resolve when there was no verb-led dictated span. The log
      shows Jev answering correctly and the resolver refusing:

      ```
      18:20:48.656 stt.turn           transcript="2 plus"
      18:20:49.313 decision.response    intent=type_text  intentConfidence=0.73
      18:20:49.590 pipeline.ignored     reason=resolution_failed
      ```

      `extractDictatedText` only matches a verb-led span (`type|enter|write|dictate` + content), so
      an utterance that *is* the text yielded no payload. Once the decision layer has said "type
      this", the whole utterance is the text, so `resolveCommand` now falls back to it. Verified:
      "2 plus" → `type_text("2 plus")`, "5551234" → `type_text("5551234")`, and the verb-led forms
      still strip the verb ("type hello world" → "hello world", "dictate in hello" → "hello").

      **Not fixed, recorded deliberately — both are scope calls rather than defects:**

      - *Insert Mode types a real command instead of running it.* At 18:21:38 "Open Google
        Chrome" was dictated verbatim as text because a dictation session was active
        (`dictation_direct_text`, reason `text_first`). This is Insert Mode working exactly as
        designed (text-first by decision — see the 2026-09-25 "Make Insert Mode text-only" entry),
        and re-saying it after "Stop typing." worked. The papercut is that there is no way to say
        "open chrome" without first leaving dictation. Changing that is a mode-semantics decision,
        so it is left alone.

      - *Store/UWP apps have no process-owned window, so window targeting misses them.* The same
        run reports `activeApp: "Application Frame Host"` at 18:21:44, 18:21:59 and 18:22:04 while
        Calculator was focused (it read plain `"Calculator"` at 18:20:42, so the ownership is not
        even stable across a session). Windows Store apps host the visible window under
        `ApplicationFrameHost` rather than their own process, which means
        `Get-Process -Name 'CalculatorApp' | Where MainWindowHandle -ne 0` in `activateApp`/`hideApp`
        returns nothing. The practical effect: `activateApp` falls through to `Start-Process` and
        opens a *second* instance instead of focusing the existing window, and `hideApp` silently
        does nothing. This affects most of the inbox apps added in pass 26 (Calculator, Photos,
        Settings, Maps, Store, Snipping Tool, Sticky Notes, Clock, Weather, Calendar). A real fix
        means UWP app activation rather than process-name window lookup, which is well beyond this
        pass — flagged here so it is not rediscovered from scratch.

      Also minor: "Open YouTube Music" transcribed as "OpenUT Music" and was dropped as
      `not_addressed`. `YouTube Music` is a keyterm and still garbled, which is consistent with
      keyterm prompting being best-effort rather than a fix.

  32. Thirty-second pass — **regression from pass 27**, reported 2026-09-26: after "open notepad",
      Notepad was left in a state where typing did nothing, and the screenshot showed the ribbon
      expanded with single-letter KeyTips (F, E, V, H, L, B, I, O, R, P, U, S) overlaid on the
      ribbon commands. Keystrokes were running ribbon commands instead of inserting text.

      Cause: pass 27 added a synthetic Alt tap to `activateApp` as a last-resort
      foreground-eligibility trick. Pressing Alt is precisely what puts a WinUI app's ribbon into
      KeyTips mode, and Notepad's ribbon stays in keyboard-navigation mode after the Alt release,
      so the app was left waiting for a ribbon key. It was the only keystroke injected anywhere in
      the app-activation path, and the previous `activateApp` had none — which matches "this was
      not happening before". Affected any app with a ribbon (Notepad, Word, Excel, File Explorer).

      Fix: removed the Alt tap. The activation path now injects no keystrokes at all, so opening
      an app can never leave a pending key state behind in something the user is about to type
      into. `AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow` + `SetFocus` — the
      part that actually does the work — is unchanged, as is the `IsIconic` guard and the
      cold-start poll. `VK.ALT` and `keyEventLine` remain in use by `switchToPreviousApp` (a real
      Alt+Tab) and the key-press paths, which are legitimate.

      While in there, added the missing telemetry: the script now ends by comparing
      `GetForegroundWindow()` against the target handle and printing `dragon_focus_ok` or
      `dragon_focus_miss`, logged as `automation.activate_app` with the alias, process, and
      `focused` boolean. There was previously no way to tell a working activation from a
      silently-refused one, which is exactly why this regression went unnoticed.

      Verified with `npm run typecheck`, `npm run build`, and a throwaway harness that stubs
      `electron`/`child_process` and asserts on the generated PowerShell: no `keybd_event(18)`,
      no trailing `SetForegroundWindow` after the thread detach, focus markers present,
      `AttachThreadInput` / `IsIconic` / cold-start poll all still there. Not executed on Windows.

  33. Thirty-third pass — **second regression from pass 27**, reported 2026-09-26: after "open
      notepad", the window came to the front but the caret did not, so nothing could be typed
      until the text area was clicked. That also blocked Dragon's own dictated text, which is
      injected as keystrokes and needs the editor control to hold focus.

      Cause: pass 27 added `[Dragon.Win32]::SetFocus($h)` to `activateApp`. `SetFocus` takes a
      window handle and moves keyboard focus to *that window*. For a text editor the caret lives
      in a child control (Notepad's is an EDIT / RichEdit child), so calling `SetFocus` on the
      top-level window — after `SetForegroundWindow` has already delivered `WM_ACTIVATE` and let
      Notepad restore its own child focus — stomped it. The pre-27 cold path was just
      `Start-Process` and return, so Windows activated Notepad naturally and Notepad focused its
      own editor; that is why this only started after that pass.

      Fix: removed the `SetFocus` call and its P/Invoke declaration. The activation sequence is
      now `AttachThreadInput` → `IsIconic`-guarded `ShowWindow` → `BringWindowToTop` →
      `SetForegroundWindow` → detach → verify. Bringing a window to the foreground is Dragon's
      job; choosing which control inside it holds the caret belongs to the app.

      Note the two pass-27 regressions (the Alt tap, now removed in pass 32, and this) came from
      the same root cause: adding a kitchen-sink activation recipe that could not be tested on
      the development machine. Both are now called out in the `activateApp` doc comment so the
      lines are not re-added.

      Verified with `npm run typecheck`, `npm run build`, and a throwaway harness asserting on the
      generated PowerShell: no `SetFocus` in either the P/Invoke block or the script body, no
      Alt tap, and `SetForegroundWindow` / `AttachThreadInput` / `BringWindowToTop` / `IsIconic` /
      cold-start poll / focus verification all still present. Not executed on Windows.

  34. Thirty-fourth pass, reported 2026-09-26: "open chrome" kept raising the YouTube Music PWA
      instead of the browser. Confirmed by the user that closing the PWA window makes "open chrome"
      behave, so the PWA was Chrome's last-focused window and Dragon was selecting it.

      Two independent causes, both "Dragon has no notion of which window is the real one":

      - `automation/windows.ts`: `activateApp` (and `hideApp`) took `Get-Process -Name 'chrome' |
        Where MainWindowHandle -ne 0` and used `$procs[0]`. An app can own several top-level
        windows and `MainWindowHandle` returns whichever Windows considers the process's main
        window, which is not necessarily the one the user means. Now a helper reorders the
        candidates by window title, preferring one that carries the registry `label`
        ("<page> - Google Chrome" vs an app window titled just "YouTube Music"), with the
        original ordering kept as a fallback so it can only reorder, never lose, candidates. The
        discriminator needs no new P/Invoke — `Get-Process` already exposes `MainWindowTitle` —
        which matters given three regressions from this file came from new P/Invoke added blind.
        This path does not involve the extension at all, which is why the extension fix alone
        could not have covered the reported command.

      - `chrome-extension/background.js`: `getActiveTab()` used
        `chrome.tabs.query({ active: true, lastFocusedWindow: true })`. Chrome runs installed
        PWAs in their own window of type `"app"`, and `lastFocusedWindow` is unfiltered, so once
        a PWA had focus every browser command (navigate, search, new_tab, click) landed in it.
        Now queries `windowType: "normal"` first and falls back to the previous behavior when no
        normal window exists. `windowType` is a documented `tabs.query` filter, so no new
        permission is needed.

      Verified with `npm run typecheck`, `npm run build`, and two throwaway harnesses: one
      evaluating the extension's `getActiveTab` against a stubbed Chrome API (PWA last-focused →
      picks the browser window; only a PWA open → still works; no windows → null, no throw), and
      one dumping the generated PowerShell to assert the title preference, its ordering after the
      cold-start poll, the fallback branch, correct quoting for a label containing a space
      ("Docker Desktop"), and that the `SetFocus`/Alt-tap fixes are still intact. The PowerShell
      was not executed — no Windows machine here.

  35. Thirty-fifth pass — latency. From the run of 2026-09-25 20:34 (session
      `sess_muhf6a1w_fe7s5i`, 13 commands). Median end-to-end was `totalMs` 1963, broken down as:

      | Component | Median | Whose cost |
      | --- | --- | --- |
      | `sttTurnMs` (speech + end-of-turn silence) | 847ms | partly tunable |
      | pre-provider overhead (`decisionMs` − `jevMs`) | ~715ms | ours |
      | `jevMs` (the LLM request) | 398ms | theirs |
      | `executionMs` | 121ms (p90 1459) | ours, for app commands |

      The ~715ms was `automation.getActiveAppName()`, which spawns a `powershell.exe` that
      compiles the User32 `Add-Type` block on every call — more expensive than the LLM request it
      was feeding. Three changes, none of which add P/Invoke or touch the resolver:

      - **The cache lookup now runs above the awaits.** The cache key depends only on utterance,
        provider and normalized text, so a hit is detectable without any read. One session had 19
        hits, and all 19 had been paying for an active-app read only the provider path needs. The
        page snapshot still runs on both paths, because `payload` drives the addressed gate and
        the resolver even for a cached answer (a cached `chrome_click` still has to resolve an
        element id).
      - **The two reads are overlapped with `Promise.all`** instead of running sequentially.
      - **Removed the dead `isChromeActive` parameter** threaded through `executeCommand` into
        `openUrlPreferringExistingTab(url, _isChromeActive)`, which never used it. Not just
        cleanup: the cache-hit change makes that flag silently `false` on hits, so leaving a
        parameter that looks load-bearing but is not would have been a latent trap.
      - **`eager_eot_threshold` 0.5 → 0.35** (Deepgram documents 0.3–0.9). This attacks
        `sttTurnMs`, the largest term, which is mostly the silence wait after the user stops
        talking. Interim execution is already gated on intent confidence and sentence
        completeness, so this mostly makes the transcript *available* earlier rather than running
        truncated commands. `eot_threshold` (0.7) and `eot_timeout_ms` (8000) are deliberately
        untouched — those guard the final turn. Pure tuning value, revert in one place if interim
        misfires appear.

      **Added the missing instrumentation:** `activeAppMs` and `snapshotMs` are now logged on
      `pipeline.decision_request`, `pipeline.decision_cache_hit` and `pipeline.execution`. Until
      now the split could only be inferred from `decisionMs - jevMs`, which is why the PowerShell
      cost went unnoticed for so long. Check these first on the next run.

      Verified with `npm run typecheck`, `npm run build`, and two throwaway harnesses: one
      exercising the exact restructured control flow (cache hit → active-app read not called and
      no PowerShell cost, snapshot still fetched; cache miss → both reads overlap so total is
      under the sequential sum; extension disconnected → no snapshot, still works), and one
      asserting the STT connection params (`eager_eot_threshold` 0.35 with `eot_threshold`,
      `eot_timeout_ms`, `numerals` and all 33 keyterms unchanged) plus a resolver regression
      guard. **The measured effect is unknown** — these cannot be executed on Linux. The next run's
      `totalMs` median and the new `activeAppMs` / `snapshotMs` fields are the measurement.

      Still not attempted, and the real fix for both the remaining overhead and the ~1.5s app
      command executions: a persistent PowerShell host instead of one process per action. That
      would take app launches from ~1.5s to tens of milliseconds and delete the pre-provider cost
      outright, but it is a refactor, not a quick fix.

## Manual verification checklist

Restructured the `README.md` alongside a demo recording: 343 lines / 21 KB down to 241 / 12 KB.
The 50-line per-OS "Manual alpha check" moved here (where AGENTS.md says manual verification
steps belong) and was split into a two-minute smoke test plus the full per-platform pass, so the
README is documentation rather than a test plan. The Laya section was compressed to four lines
(it is optional, off by default, and unused), permission tables were folded into the first-run
flow, and the unusable single-bullet Insert Mode description became a phrase table under "What it
does". Added a **Demo** section (the recording ended up hosted on Loom rather than in-repo, since
GitHub markdown does not autoplay a linked video and every clone would carry the file) and a
**Screenshots** section for the dashboard capture, and documented the Chrome-extension **Reload**
gotcha that cost a debugging round on 2026-09-26. Also made the two required API keys explicit in
a short table — Deepgram for STT, OpenRouter with System One access for the decision model — and
noted that there is no `.env` file.

Per AGENTS.md there are no automated tests, so correctness on real hardware is established by
running this by hand.

### Smoke test (~2 minutes, both platforms)

1. Launch Dragon, paste both API keys, grant microphone (and Accessibility on macOS).
2. Load the unpacked `chrome-extension/` folder at `chrome://extensions` and confirm
   `browser.extension_connected` in the log.
3. `Open notepad` — the window must come to the **front** and accept typing immediately, with no
   click into the text area first.
4. `Start typing`, dictate a sentence, `new line`, dictate another, `delete the last 3 words`,
   `replace X with Y`, `stop typing`.
5. `Open google chrome` — must focus Chrome, **not** navigate to google.com.
6. With Chrome on a real page: `search for cats`, `click on` a visible label, `scroll down`,
   `new tab`, `close tab`.
7. `volume up`, `mute`, `minimize window`, `press enter`.
8. Open the log and confirm transcript, decision, execution, and a latency split are present, with
   no API keys or audio.

### Full per-platform check

**macOS** (Apple Silicon) — additionally: the first `osascript`/System Events call triggers the
Accessibility prompt; grant it and restart if commands fail with "not allowed to send
keystrokes". Repeat step 6 in each activation mode. Confirm voice replies are interrupted by
starting to speak again.

**Windows 11 x64** — additionally: accept the SmartScreen prompt on first run. Exercise copy,
paste, undo, save, Enter, Escape, Tab and arrow keys. Check `set volume to 30` produces the
documented "not supported on Windows yet" error rather than a silent no-op, and that `mute` and
`unmute` both toggle. Open a Settings pane ("open the sound settings") and a File Explorer
location ("open downloads"). Repeat one direct command in each activation mode.

**Cross-platform** — the STT transcripts and decision traces are the real signal. Read
`stt.turn` for misheards (keyterm prompting helps but doesn't eliminate them),
`pipeline.ignored` for drops, and `pipeline.execution` for the latency split
(`sttTurnMs` / `activeAppMs` / `snapshotMs` / `jevMs` / `executionMs` / `totalMs`).

  36. Thirty-sixth pass: release builds. Replaced the two ad-hoc `package:*` npm scripts with
      `scripts/build-release.js`, which adds the logic a raw `electron-builder` call was missing.

      **Two real defects in the previous config, both found by building rather than reading.**
      `package:mac` promised `--arm64` but on this x64 Linux host electron-builder emitted a
      `darwin-x64` bundle — an artifact that looks successful and targets the wrong CPU, needing
      Rosetta on Apple Silicon. And `win.signAndEditExecutable: false`, added to avoid "code
      signing", also skips rcedit, which is what appends the `.exe` extension and stamps the
      icon. Removing it produced `Dragon-0.1.0-x64`: a valid 74 MB PE32 file that **Windows will
      not launch on double-click**, carrying Electron's default icon. Being unsigned needs no flag
      at all — electron-builder skips signing on its own when it finds no certificate, and logs
      `no signing info identified, signing is skipped`.

      What the script does:
      - **Gates the target.** `mac` refuses to run off a Mac, explaining the wrong-architecture
        trap. A Windows build on Linux preflights for `wine` (rcedit is a Windows binary) and
        fails in ~0.1 s with the fix, instead of three minutes of work into a stack trace. No
        Linux target: `automation/index.ts` hard-errors off macOS/Windows, so such a bundle
        could not run.
      - **One source of truth for targets.** Nothing target-shaped is passed on the command line;
        `electron-builder.yml` alone declares target, arch, icon and signing, so the two cannot
        drift — which is how the `--arm64` promise survived next to an x64 artifact.
      - **Verifies the artifact** before reporting success: exists, plausible size, `MZ` PE
        header for Windows, `Contents/Info.plist` plus a non-empty `Contents/MacOS` for a `.app`,
        and a `.exe` extension check that names `signAndEditExecutable` as the cause when
        missing.
      - **Reports what the recipient will hit** (SmartScreen / Gatekeeper) and a short list of
        commands to verify the build on its target OS.
      - `artifactName` is now `Dragon-<version>-<arch>`, dropping the space in electron-builder's
        default `Dragon 0.1.0.exe`.

      Verified here: `typecheck`/`build` clean; mac gating, no-default-target and bogus-target
      errors all exit 1 with actionable messages; the Linux-wine preflight exits 1 in 0.09 s
      without creating `release/`; the extensionless-artifact detector correctly flags the
      `Dragon-0.1.0-x64` file the old config produced. **A completed Windows portable build was
      not produced here** — it needs wine, and no wine is installed on this sandbox. Everything
      up to the wine step ran (the unpacked `win-unpacked/Dragon.exe` was produced and its asar
      integrity resource updated), but the final `.exe` is unverified and must be built on
      Windows. The mac path is likewise unrunnable here and is unchanged apart from naming.

  37. Thirty-seventh pass: `scripts/release.js` (`npm run release`), which turns "build on two
      machines, one release" into a single convergent flow. A release *cycle* is one version number
      that both platforms join rather than one release per platform.

      The load-bearing decision is **commits since the latest tag**, not which artifacts are
      attached. That distinction was found by testing, not reasoning: the first cut keyed the
      decision on artifact presence, and running that logic against a *complete* release returned
      "nothing to do" — so a finished release could never be superseded and the automation could
      only ever produce one version. Commit count separates "the other machine added its build"
      (attach, no new version) from "there is unreleased work" (bump), and makes a re-run with
      nothing new a no-op instead of version churn.

      Behaviour, all verified by importing the pure `decideCycle()` on Linux (21 checks): nothing
      published -> create at the `package.json` version; other platform's build present and nothing
      new committed -> attach to that release without bumping; own build present and nothing new ->
      no-op; unreleased commits -> bump patch/minor/major and create; a previous release missing
      this platform's build -> finish that release rather than supersede it. A single-platform repo
      bumps exactly once and then settles across repeated runs. `--force-new` overrides all of it.

      The same harness caught `bump("0.1.99")` producing `0.1.100`; it now rolls over to `0.2.0`.

      Also handles what a naive `gh release create` gets wrong: on macOS a `.app` is a directory and
      must be zipped, and a plain `zip` drops the executable bit so the recipient's app will not
      launch — the script uses `ditto -c -k --sequesterRsrc --keepParent`. It syncs the
      `package.json` version to the release version before building so the artifact name matches
      the tag, pushes main so the tag lands on the right commit, defaults to release notes stating
      the unsigned caveats for both platforms, and supports `--draft`, `--dry-run`, `--minor`,
      `--major`, `--force-new` and `--notes-file`. It refuses to run off Windows or macOS, off
      `main`, with a dirty tree, or with unknown flags.

      Untested end to end: both platform paths need their own host and no release exists yet, so
      the live `gh release create` / `gh release upload` calls have never run. The decision logic,
      the guards and the argument parsing are verified; the first real
      `npm run release -- --draft` is the remaining unknown.

  38. Thirty-eighth pass: two bugs in `scripts/release.js`, both found by running it rather than
      reading it, and the second one would have been invisible without checking.

      `gh release list` has no `assets` field — only `gh release view` does — so the first
      `--dry-run` died on `Unknown JSON field: "assets"`. Split into two calls: the list supplies
      `tagName`/`isDraft`, the view supplies the asset names. Confirmed against gh 2.87.2 that
      `release view --json assets` accepts the field, and that a bogus field on the same command is
      still rejected — otherwise "accepted" would have proved nothing. `gh release list` includes
      drafts unless you pass `--exclude-drafts`, which is what lets the second platform join a
      release the first one staged with `--draft`.

      The quieter one: the code stripped the leading `v` off the tag for version maths and then
      handed that stripped string to `git rev-list 0.1.0..HEAD`, which is not a valid ref. The
      call threw, was caught, and fell back to "0 commits since the tag" — on *every* run. Since
      commit count is the signal that triggers a bump, the script would have reported "nothing to
      do" forever and never produced a second version. Proven in a scratch repo: `0.1.0..HEAD`
      fails with "ambiguous argument", `v0.1.0..HEAD` returns 2. The release object now carries
      both the bare version and the real git ref.

      Also hardened around that lookup: an unresolvable tag now says so (expected for a draft,
      which has no tag until published) and points at `--force-new`; unreadable assets print a
      note and degrade to attaching to the existing release, which is the safe direction because it
      can never bump spuriously. The decision logic is re-verified, 31 checks, now covering drafts
      and the unreadable-assets path. Still untested end to end: the live `gh release create` /
      `upload` calls and both platform builds.

  39. Thirty-ninth pass: a full command-surface audit, because the release script's bugs have all
      come from commands that were never executed rather than from the decision logic.

      Three scripts, ~80 checks, all run rather than reasoned about. npm scripts: 6/6 pass
      (clean, build:main, build:renderer, build, typecheck, icons), with `start`/`dev` skipped as
      GUI-only. Packaging inputs: 16/16 — every path `electron-builder.yml` references exists
      after a build (both icons, all four `files` globs matching 62/8/4/5 files), the yml
      `artifactName` templates match the filenames the scripts predict, the declared archs match
      what release.js looks for, and the win/mac asset regexes do not cross-match. Guards: 36/36,
      each refusal executed and its exit code checked, including that the mac refusal names the
      Rosetta failure mode and the wine refusal names rcedit. README: 12/12 — every documented
      `npm run` exists, no references to the agent working docs, no Workflow Mode. Links: the
      demo, screenshot, Deepgram console and OpenRouter keys all return 200.

      One real bug found, in the ahead-of-main check. `git rev-list --count origin/main..HEAD`
      throws when the remote-tracking ref does not resolve, and the throw escaped to the top-level
      handler and aborted the whole release. It now falls back to pushing anyway, which is a no-op
      when already up to date and otherwise fast-forwards or fails with git's own message —
      aborting a release over a ref that may not exist yet is the wrong trade.

      Two of the five original failures were bugs in the audit script itself (a grep string that
      did not match the real wording, and a scratch repo whose `origin/main` had never been
      pushed). Worth stating plainly: the first version of this audit reported 5 failures, 2 of
      which were its own mistakes. The git one was not — it was the real bug, and it was only
      visible because the scratch repo was wrong in a way that happened to match a real
      condition.

  40. Fortieth pass: a Windows-only release-breaking bug, surfaced by a DeprecationWarning the
      user pasted in. Worth recording how it was found, because the warning was the only evidence
      and it was easy to dismiss as cosmetic.

      `run()` and `capture()` passed `shell: true` on Windows so that `.cmd` shims would resolve.
      A shell concatenates arguments without escaping, so any argument containing a space is split
      in two. The version-bump commit is `git commit -m "release: v0.1.0"` — the message has a
      space. On Windows that reached git as `git commit -m "release:" v0.1.0`, which exits 1 with
      `error: pathspec 'v0.1.0' did not match any file(s) known to git`. Confirmed by running the
      real command both ways in a scratch repo and reading back the recorded subject:
      shell:true -> exit 1, subject still "init"; shell:false -> exit 0, subject "release: v0.1.0".
      `gh release create ... --title "Dragon v0.1.0"` had the same defect, reaching gh as
      `--title Dragon v0.1.0` ("no matches found for `v0.1.0`"). A dry run could never have caught
      it, since it returns before the commit.

      Fix: `needsShell(cmd, args)` allows a shell only for `.cmd`/`.bat`, and refuses loudly if
      such a call is ever given a spaced argument, so the trap cannot be re-entered silently.
      Everything else — git, gh, ditto, node.exe — runs unshelled, where arguments go through as
      an array and spaces are safe. Applied to both `release.js` and `build-release.js`, which
      carried the same blanket shell. `build-release.js`'s existing calls were all space-free, so
      it was latent rather than live.

      Verified: 23 checks, including all 14 real command invocations in release.js confirmed to
      take `shell=false`, both `.cmd` shims confirmed to still get one, a spaced argument to a
      `.cmd` confirmed to be refused, and the old behaviour confirmed to still fail. The DEP0190
      warning itself is gone — re-run under `--throw-deprecation` for each preflight call, with a
      control proving the test is not vacuous. The decision logic is untouched and re-checked.

      My first attempt at proving this was worthless: I counted child-process argv entries with a
      `printf` probe whose format string contained backslashes, which the shell ate, so the counts
      were meaningless and one "failure" was an artifact. Replaced with the ground-truth test above.

  41. Forty-first pass: the first real Windows build attempt, and the first Windows-only blocker.
      Blocked, not broken — it is a machine setting, not a code fault.

      `npm run release -- --draft` on Windows: TypeScript compiled, `electron-updating asar
      integrity` ran, `appOutDir=release\win-unpacked` was produced, and then electron-builder
      failed downloading and unpacking `winCodeSign-2.6.0.7z`. It retried three times, re-fetching
      the same 5.6 MB and failing identically each time (~3 minutes wasted).

      Cause: the archive contains two macOS dylib symlinks
      (`darwin/10.12/lib/libcrypto.dylib` and `libssl.dylib`). 7-Zip must recreate them as
      Windows symlinks, which needs `SeCreateSymbolicLinkPrivilege`; without it, 7z exits 2 and
      fails the entire extraction over those two entries. The log names them explicitly:
      "Cannot create symbolic link : A required privilege is not held by the client."

      This cannot be coded around. electron-builder needs `winCodeSign` for `rcedit`, which is
      precisely what appends the `.exe` extension and stamps the icon — the thing
      `signAndEditExecutable: false` used to disable, and the reason `Dragon-0.1.0-x64` came out
      extensionless and unlaunchable. There is no flag to skip symlink recreation, and the darwin
      entries are irrelevant to a Windows build yet fatal to unpacking one.

      Fix is on the machine, in order of least friction:
        1. clear the four partial extractions electron-builder left behind:
           `rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"`
        2. grant symlink creation, either by enabling Developer Mode
           (Settings > System > For developers, or one elevated command:
           `reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD
            /f /v AllowDevelopmentWithoutDevLicense /d 1`)
           or by running the release once from an Administrator terminal.
      Then re-run `npm run release -- --draft`.

      Not verified: the fix itself, and the build past this point. The `.exe` still has never been
      produced. I could not independently enumerate the archive to confirm the symlink entries —
      7z is not installed here and the archive header is solid/compressed — so the specifics rest
      on the build log, which does name both failing paths explicitly.

      One piece of good news, stated carefully: this is the first run to get past TypeScript
      compilation and into electron-builder's Windows packaging path, so everything before this
      point is confirmed working on the actual target OS.

  42. Forty-second pass: the first verified Windows build, and the first release. The
      `signAndEditExecutable` reasoning is now confirmed by observation rather than inspection.

      After Developer Mode was enabled, the Windows build completed:
      `Dragon-0.1.0-x64.exe`, 70.9 MB, uploaded to a draft `v0.1.0` with sha256 recorded by
      GitHub. Downloaded the first 2 KB of the published asset via a range request and checked
      the headers rather than trusting the filename: `MZ` at offset 0, PE header offset 216
      (0xD8), and `50 45 00 00` — the `PE\0\0` signature — at that offset. It is a genuine
      Windows PE. This is the artifact that used to come out as `Dragon-0.1.0-x64` with no
      extension and Electron's default icon.

      Not verified: that the icon was actually stamped. Icons live in the PE resource
      directory, well past the 2 KB fetched. rcedit appends the extension and stamps the icon
      in one pass, so the extension's presence is strong evidence it ran, but that is inference
      rather than measurement. Also unverified: that the app launches and works.

      The `https://.../releases/tag/untagged-3acd4793f44506ae77d3` URL in the build output is
      not a second release and not a bug. `gh release list` returns exactly one release, the
      draft `v0.1.0`, with exactly one asset. GitHub addresses a draft by an `untagged-<sha>`
      placeholder because a draft has no real tag until it is published; the
      `.../releases/tag/v0.1.0` URL printed by the release script resolves correctly after
      `gh release edit v0.1.0 --draft=false`.

      Correction to pass 40: DEP0190 is not fully gone. It still fires, from the two `.cmd`
      shims — `npm.cmd run build` and `electron-builder.cmd --win` — because Windows requires
      a shell to execute `.cmd` files at all (the CVE-2024-27980 fix makes Node refuse them
      otherwise). Pass 40 tested only the gh and git calls, which no longer use a shell, and I
      over-generalised that into "the warning is gone". It is now cosmetic: it can only come
      from a `.cmd` call, and `needsShell()` refuses any spaced argument to one, so there is no
      way for it to corrupt a command. Both live calls pass only space-free arguments.

  43. Forty-third pass: removed draft mode from the release script. The user's objection was that
      staging a draft and then remembering to promote it is manual work the script should be doing.
      Correct — the script should not need a human to remember a second command.

      `--draft` is gone. `gh release create` now always publishes. Publishing immediately is the
      safe direction, not the risky one: `gh release upload` attaches to a live release exactly as
      happily as to a draft, so the second platform can still join days later. Drafting would mean
      the release sits invisible until the Mac's machine happens to run, and if that machine never
      runs, nothing is ever published at all.

      One problem that created: v0.1.0 is *currently* a draft, created before this change, and
      nothing would ever have promoted it. So the join path now promotes any draft it finds
      (`gh release edit <tag> --draft=false`) after attaching. Nothing creates drafts any more,
      but a pre-existing one is joined and published rather than silently superseded. That makes
      the invariant simple: after any successful run, the release is public.

      The default release notes were rewritten to stop asserting that a specific build is
      attached. They previously described both platforms as if both were always present, which
      was untrue in exactly the window this change creates — published by one machine, the other
      not attached yet. The per-platform caveats are now stated unconditionally, because they hold
      either way, and the release page's own attachment list is the source of truth for what is
      actually there.

      Verified 11 checks: `--draft` rejected as an unknown argument and exits non-zero; the five
      optional flags survive; `gh release create` provably never receives `--draft`; the only
      `--draft` token left in the file is the `edit --draft=false` promotion; the join path both
      uploads and promotes; the notes claim no specific file; and the README no longer documents a
      manual promote step. Two of the audit's own checks were wrong first (a regex that could not
      match the flag array, and a `--draft` grep that missed `--draft=false`); fixing them turned up
      a genuinely stale comment referencing the removed flag. typecheck clean.

      Not verified: no run has exercised the new publish-immediately path. The existing v0.1.0
      draft is promoted by the next run, which will be the Mac's — that run is the first real test
      of both the join path and the promotion.

  44. Forty-fourth pass: asked what happens if the same command runs on Windows while v0.1.0 is
      still a draft and the Mac has not run. Answering it found a real gap in pass 43's own claim.

      Traced it against the live repo: `git ls-remote --tags origin` returns **nothing**. A draft
      release has no git tag — GitHub only creates it at publish time. So the run behaves like
      this:

        commitsSinceTag -> `git rev-list v0.1.0..HEAD` fails, defaults to 0
        decideCycle    -> unreleased=false, Windows artifact present -> action "none"
        main()         -> prints "nothing to do" and returns

      The release stayed a draft. Pass 43 claimed "after any successful run, the release is
      public", and that was false: the promotion lived only on the join path, while this run took
      the no-op path. The exact state that strands a release is one machine staged it and the
      other never arrived, so the no-op path is the one that most needs to publish.

      Fixed: the "nothing to do" branch now publishes first if the latest release is a draft,
      before returning. `--force-new` remains the escape hatch if the zero-commit default was
      wrong.

      Verified 15 checks walking the state the user described, using the actual
      `gh release view v0.1.0` response rather than an invented fixture: Windows now publishes
      the draft and cuts no version; a published release is not re-edited; the Mac then attaches
      to the same v0.1.0 (the tag now exists, so its commit count is real); both machines are a
      clean no-op once both artifacts are attached; new commits do bump to 0.1.1 afterwards; and
      `--force-new` still works from the draft state. typecheck clean.

      Still not verified by execution: the whole sequence, since it needs the Windows and macOS
      hosts. The decision logic and the shape of the promotion are checked; the live
      `gh release edit --draft=false` on this particular draft has not run.

  45. Forty-fifth pass: trimmed the macOS application menu bar. Asked for the
      `File Edit View Window Help` bar to be hidden. That bar was Electron's built-in default —
      Dragon never called `setApplicationMenu`, so it got the full standard menu for free. For a
      tray app (`app.dock?.hide()` already in place) whose only window is a settings pane, it is
      pure noise.

      Now set to `appMenu` + `editMenu`, which drops File, View, Window and Help.

      Cannot go further, and the reason is a platform constraint rather than a choice: macOS will
      not let a regular app have no application menu while it is frontmost, so the bar becomes
      `🍎 Dragon   Edit` rather than disappearing. The only way to get no bar at all is a true
      agent app (LSUIElement), which is not viable here — a window belonging to a non-Dock app
      cannot take keyboard focus, so the settings window could not accept typed or pasted input.

      Edit is kept deliberately rather than dropped for a cleaner bar. On macOS the clipboard
      shortcuts are menu *roles*, not Chromium built-ins, so removing that menu risks breaking
      Cmd+C/Cmd/V, and pasting API keys into the settings fields is that window's main job.
      Consequence worth naming: the View menu is gone, so the Cmd+Alt+I devtools accelerator is
      gone with it. Restore it by adding `{ role: "viewMenu" }`, or a single
      `{ role: "toggleDevTools" }` item, to the same template.

      Not verified: no GUI on this host, so the trimmed bar has not been seen. The roles are
      confirmed present in Electron's typings and `typecheck` is clean.

  46. Forty-sixth pass: "on Windows, quitting the app leaves it in the taskbar" — the app could
      not quit at all, on any platform.

      The settings window's close handler called `e.preventDefault()` unconditionally, so that
      closing the pane hides it instead of destroying it — correct for a tray app, but
      `app.quit()` works by closing every window. The settings window vetoed its own close, the
      window never went away, and the process never exited. `Quit Dragon` in the tray menu called
      `app.quit()` and did nothing.

      macOS hides this. The pane is created `show: false` and only revealed on demand, so after a
      "quit" nothing visible is left and a live tray icon looks completely normal for a tray app.
      Windows shows it as a taskbar button that refuses to disappear, which is how it was found.

      Fixed with a `quitting` flag set in `app.on("before-quit")`; the close handler returns early
      when it is set, letting the app shut down. Verified as a real red-green test rather than by
      reasoning, because the whole claim is about Electron's event ordering: a minimal Electron
      app on this host reproducing the exact pattern, in both forms —

        mode "bug"    -> CALLING_QUIT, STILL_ALIVE_AFTER_QUIT, exit 42
        mode "fixed"  -> CALLING_QUIT, exit 0

      So the premise (quit depends on the window being allowed to close) is now observed, not
      assumed. Grepped for other `close` handlers and other `preventDefault` calls in `src/main`:
      the settings window was the only one, and this is the only remaining veto.

      Also added `logger.event("app.quit")` as the first line of `before-quit`, so a run that is
      stuck can be told apart from one that never began quitting. If a ghost tray icon survives
      this fix, it is Explorer's notification-area cache rather than a live process, and that log
      line is how to tell the two apart.

      Deliberately not bundled: `app.setAppUserModelId()` (recommended for Windows tray apps, and
      relevant to taskbar behaviour, but it would not fix a process that fails to exit, which is
      the reported symptom) and `skipTaskbar` on the settings window (a different complaint — a
      taskbar button while the app is running, not after quitting). Both are noted rather than
      guessed at, since neither can be verified from this host.

  47. Forty-seventh pass: replaced the portable-file distribution with a real installer, at the
      user's request — "why is the installation not working like a setup, it should get installed
      on to the system". `win.target` portable -> nsis (one-click, per-user), `mac.target` dir ->
      dmg. Recorded in DECISIONS.md with the reasoning, including the admission that the original
      "portable first" choice was never actually written down as a decision despite the yml
      comment claiming it was.

      Per-user rather than per-machine is the load-bearing choice. An unsigned installer already
      draws a SmartScreen warning; a per-machine install adds a UAC elevation prompt on top, so the
      recipient would meet two trust asks before an unsigned binary runs. Per-user needs no admin.

      Two knock-on improvements fell out of it rather than being bolted on:

      - The macOS hand-zip is gone, which **retires the ditto-vs-zip executable-bit trap** that
        earlier passes documented at length. Plain `zip` dropped the exec bit and produced an app
        that would not launch; a `.dmg` sidesteps that class of bug entirely, so the whole
        `packageMac()` function and the `ditto` shell-out are deleted.
      - The build verifier got **stronger**, because the old check became weaker. An NSIS
        installer's own filename always ends in `.exe` no matter what rcedit did to the executable
        inside it, so "the artifact ends in .exe" now proves nothing. The verifier additionally
        requires `release\win-unpacked\Dragon.exe` — the file the installer actually places, and
        the exact one the old `signAndEditExecutable: false` bug produced without an extension.
        The macOS check reads the 512-byte `koly` disk-image trailer, the closest thing to "is
        this really a dmg" that does not need a Mac to mount it.

      Verified 20 groups: config keys present and old targets gone; **electron-builder itself
      accepts the nsis/dmg config** (probed with a real `--win --dir` invocation, not just a
      regex); release.js points at both new artifacts and no longer shells out to ditto; the
      win/mac patterns still do not cross-match against the *new* filenames; the verifier expects
      both new names and has both new checks; the docs no longer promise a portable file; and the
      cycle decision logic still converges end to end with the `.dmg` pattern. The `koly` predicate
      was additionally exercised against a synthetic valid trailer and a junk file. Its one
      false-pass case — a file smaller than 512 bytes — is unreachable, since the 20 MB size check
      runs first. typecheck clean.

      Not verified: **the Windows installer has never been produced.** NSIS packaging cannot be
      exercised from this host, and the previous Windows build already failed once on a
      Windows-only issue. The next `npm run package:win` is a real test, not a formality.

      Not bundled, deliberately: `app.setAppUserModelId()`, now genuinely more relevant since a
      Start Menu entry benefits from a stable AppUserModelID. It was not part of the reported
      problem and cannot be verified here, so it is noted in DECISIONS.md rather than guessed at.

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
  testing normal app commands. Open `http://127.0.0.1:17873/dashboard` after a few commands to
  inspect provider probabilities and STT/provider timing; compare the accuracy change against the
  observed STT-turn latency.
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
