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

  48. Forty-eighth pass: "when I saved the token and re-opened the app it didn't work, had to paste
      it again". Persistence was never broken — the UI misrepresented it. Found by reading the
      real file rather than reasoning: `%APPDATA%\Dragon\settings.json` on the user's machine
      contained both `openRouterApiKey` and `deepgramApiKey`, written minutes earlier.

      The cause is that secrets are deliberately never sent to the renderer
      (`toRendererSafe` strips them), so on reopen both key fields render **empty**. The only
      signal was a faint grey placeholder reading "saved — leave blank to keep". An empty box
      reads as "not saved", so the conclusion drawn was correct given the evidence on screen and
      wrong about the actual state. Fixed by making a saved key look saved:

      - the field's *value* becomes a mask (`••••••••••••`) rather than the placeholder, so an
        empty field now unambiguously means "no key"
      - an explicit state line under each field: "Saved on this machine." / "No key saved yet."
      - a **Clear** button per key, because blanking the field has never been able to express
        "remove this" — `save()` skips empty values to mean "keep what's stored", so a saved key
        was previously only clearable by hand-editing the JSON
      - `save()` treats the mask as "keep what's stored" and any other typed value as a
        replacement

      Second, real bug found alongside it: `SettingsStore.persist()` caught every write error and
      only logged it, so a failed write still produced "Saved." in the UI. That is what made this
      class of problem invisible, and it could have turned a permissions problem into a silent
      data-loss report. `persist()` now returns a result, `update()` records it on
      `persistedLast`, the `settings:update` handler returns it, and the renderer says
      **"NOT saved — the file could not be written. See the log."** rather than lying. The
      `settings.updated` log event now carries `persisted` too, so this is diagnosable after the
      fact.

      Verified 17 checks against the **real compiled `SettingsStore`** from `dist/`, with
      `electron` stubbed so `getPath()` points at a scratch directory — not a reimplementation:
      a key saved then read back by a brand-new store instance survives and other fields survive
      with it; the renderer payload contains `hasDeepgramKey: true` and still no key material; a
      write forced to fail (a directory in the file's place) reports `persistedLast === false`,
      which is exactly the case the old code reported as success; clearing a key works and stays
      cleared across a reopen; and the mask is never mistaken for a real key in either direction.
      One failure on the first pass was the test's own fault — section 3 destroys the file to force
      a write failure, so section 4 started with no key; re-establishing state fixed it.

      Not verified: the rendered appearance. There is no GUI on this host, so the mask, the state
      line and the Clear button have not been seen.

      Also worth recording: the user's guess that this might be fixed by the app being properly
      installed is not right, and worth saying plainly. Settings live in `%APPDATA%\Dragon`,
      which comes from Electron's `userData` path and is identical for a portable build and an
      installed one. Installing changes nothing about persistence. The NSIS change in pass 47 is
      independent of this fix.

      **Security note:** reading `settings.json` to diagnose this printed the user's live
      OpenRouter and Deepgram API keys into the session transcript. Both should be treated as
      compromised and rotated. The right approach was to read only the key *names* and lengths.

  49. Forty-ninth pass: `nsis:` was nested under `win:` in electron-builder.yml, which
      electron-builder rejects outright — "configuration.win has an unknown property 'nsis'".
      Installer options are a **top-level** key; only genuinely Windows-shaped keys (icon,
      artifactName, target) go under `win:`. Moved. The Windows install had never been built, so
      this was caught by the first real attempt rather than shipped.

      Worth recording how badly my verification failed here, because the failure mode matters more
      than the fix. Pass 47 claimed "electron-builder itself accepts the nsis/dmg config (probed
      with a real --win --dir invocation, not just a regex)". That claim was worthless twice over:

      - It grepped the output for `error|invalid|unknown` rather than checking the exit code, and
        a real build cannot complete on this host anyway — `app-builder` cannot execute here
        (`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`). So the probe was checking for a failure mode it
        was structurally unable to produce, and would have "passed" on almost any output.
      - When I re-ran it checking the exit code, it failed for the *unrelated* app-builder reason
        and I nearly read that as "the config is still broken".

      The check that actually works is calling electron-builder's own `validateConfiguration()`
      directly with `electron-builder/node_modules/app-builder-lib` — validation runs before
      app-builder is invoked, so it is exact and host-independent. It also needs a real
      `debugLogger` argument: passing `null` makes the schema's error *formatter* throw
      (`debugLogger.isEnabled`) while formatting the rejection, which masks the real message behind
      "Cannot read properties of null". That masked my own control test for a while.

      The control matters most: it re-nests `nsis` under `win:` and requires the validator to reject
      it with the same "unknown property 'nsis'" text, so a green result on the real config means
      something. Building that control honestly took three attempts, and the first two passed **for
      the wrong reason** — the splice left `nsis` at zero indent, making it a duplicate top-level
      key with a null `win:`, so the config was rejected as malformed rather than as mis-nested. A
      test that passes for the wrong reason is worse than no test, so the harness now also asserts
      the control is valid YAML and differs *only* by the nesting.

  50. Fiftieth pass: the Windows NSIS installer **built successfully** and then failed on
      "GitHub Personal Access Token is not set" — after packaging, uninstaller, blockmap, and
      signing attempts, so it read as a packaging failure when the packaging was fine.

      Cause: with no `publish` key, electron-builder infers GitHub options from the git remote
      (`git@github.com:Hardik500/dragon-voice-control.git`; there is no `repository` field in
      package.json for it to use instead), decides it should publish, and constructs a
      `GitHubPublisher` — whose **constructor** throws without a token. It never needed to publish
      at all: `scripts/release.js` owns versioning, tagging and `gh release create`.

      Fixed with `publish: "never"` at the top level. Traced through the code rather than assumed:
      `PublishManager.isPublish = publishPolicy != null && publishOptions.publish !== "never" && ...`
      so `"never"` makes it false, the GitHub publisher is never constructed, and no token is ever
      demanded. The config still passes electron-builder's own `validateConfiguration()`.

      Worth noting the schema cannot answer this question: `publish: "never"`, `publish: never`,
      `publish: null`, a generic provider, and a github provider all *validate* identically. Only
      the code distinguishes them. Testing the schema would have "passed" every wrong answer.

      Second, latent bug this surfaced: NSIS writes a `Dragon-...-Setup.exe.blockmap` sidecar, and
      the build verifier's "extensionless artifact" heuristic tested
      `!endsWith(".exe"|".dmg"|".app")` — so a legitimate `.blockmap` would have been reported as
      the old `signAndEditExecutable` bug, sending whoever hit a real build failure down the wrong
      path entirely. Sidecar suffixes are now excluded, verified by extracting the actual regex
      from the shipped `build-release.js` and running it over seven filenames, so the test
      exercises the shipped predicate rather than a hand-copied one.

      Not verified: that the build now completes. The token check happens only after a full NSIS
      packaging run, which needs `app-builder` and therefore a Windows or macOS host. The fix is
      code-confirmed, not execution-confirmed.

  51. Fifty-first pass: `publish: "never"` broke the build with "Cannot find module
      'electron-publisher-never'". My pass-50 fix was wrong, and wrong in an instructive way.

      I had read `PublishManager.isPublish = ... && publishOptions.publish !== "never" && ...` and
      concluded that `"never"` was the config-file opt-out. That line is real, but it checks
      `publishOptions.publish` *after* config resolution, and it is the value the **command-line**
      `--publish never` flag sets. In the config file, a string at `publish` is taken as a
      **provider name**, so electron-builder dutifully tried to `require("electron-publisher-never")`.
      I read one line, confirmed it said "never", and stopped — without reading what happens
      *before* that line.

      Reading the actual resolution path settles it. `getPublishConfigs` walks
      target-specific -> platform-specific -> top level, and returns "no publish" on a **strict
      `=== null`** at each level:

        if (targetSpecificOptions != null) { publishers = targetSpecificOptions.publish;
                                             if (publishers === null) return null; }
        if (publishers == null) { publishers = platformSpecificBuildOptions.publish;
                                  if (publishers === null) return null; }
        if (publishers == null) { publishers = config.publish;
                                  if (publishers === null) return null; }

      So the value is an explicit YAML `null`, and `null` and *absent* are genuinely different:
      absent falls through to auto-detection from the git remote, which is the original bug.
      Changed to `publish: null`, with a comment recording why the obvious spellings are wrong.

      Verified 9 checks, including a reproduction of the cascade proving all three cases: no
      publish key anywhere -> auto-detect and a token demand; `publish: "never"` -> tries to load a
      provider module named "never" (the crash just seen); `publish: null` -> stops. Plus
      `validateConfiguration()` still passes and the rest of the config is unchanged.

      The lesson worth keeping from passes 47-51: the electron-builder config has now produced
      three consecutive defects that a *schema* check would have called valid — `nsis` nested
      under `win:`, and both wrong `publish` values. The schema validates shape, not semantics.
      Every one of these needed reading the implementation, and twice the mistake was reading a
      single line and stopping.

      Not verified: that the build now completes. As before, the publish resolution runs in
      `afterPack`, which needs a real NSIS packaging run and therefore a Windows or macOS host.

  52. Fifty-second pass: the Windows STT failure. Reported as "unable to verify first certificate,
      and then none of the voice actions work".

      **Not fixed — instrumented instead.** Two of my hypotheses in this thread were wrong before
      this one (the TLS-intercepting proxy, and `publish: "never"`), so the pattern here was to
      measure rather than guess. What is established:

      - The certificate is genuine. `api.deepgram.com` presents a Let's Encrypt YR1 leaf, the
        hostname resolves to a **single** IP (208.184.56.201), and that address serves a valid
        chain. Ruled out: interception, and a misconfigured CDN edge.
      - The user's own scoop Node verifies it. Their Electron 33.4.11 / Node 20.18.3 verifies it
        via both `tls.connect` and `https.get`. So it is not a Windows certificate-store problem
        and not a missing corporate root.
      - The same Electron on this host completes **8 of 8** sequential `wss://` connections to the
        exact Dragon URL. So the failure does not reproduce here.
      - **The first connect succeeds; the reconnect fails.** The 09-27 log reads
        `stt.connected` -> `stt.session_connected` -> `stt.closed 1006` after ~1.8s ->
        `stt.socket_error`. The reconnect path is the identical `startStreaming()` call, so nothing
        about the request differs. A third session failed on its *first* connect, 30s after the
        previous process quit, which does not fit a purely reconnect-shaped theory.

      The blocking gap: `logger.error()` recorded only `err.message` and **discarded `err.code`**,
      and the message alone is ambiguous. Node's `UNABLE_TO_VERIFY_LEAF_SIGNATURE` is reported
      only as "unable to verify the first certificate" — which does not distinguish an incomplete
      chain from an untrusted issuer from a self-signed leaf. The leading theory (TLS session
      resumption sending an abbreviated handshake that omits the intermediate) fits "first connect
      fine, immediate reconnect fails" well, but it is a theory, and adding `agent: false` on the
      strength of it would be exactly the guessing that produced the last two wrong answers.

      So the only change is instrumentation: `logger.error` now also records `errorCode` and
      `errorName`, and deliberately does **not** copy the stack (which can carry request detail) or
      anything from `data`. Verified against the compiled logger with 11 checks, including that
      two different codes sharing one message are now distinguishable, that a non-`Error` input
      gains no spurious keys, and that a non-string `code` is ignored rather than written.

      Next: reproduce once with the new build and read `errorCode` from the log. That single value
      discriminates every remaining theory. Two of this pass's own checks were wrong first — it
      asserted a plain `Error` had no `name` (every `Error` does), and grepped for the word
      "stack" which appears in the new comment explaining why the stack is not copied.

  53. Fifty-third pass: "the built app is not working while dev is working". Recorded as **not yet
      reproduced**, and deliberately not "fixed", because the premise does not yet survive scrutiny.

      First caveat, stated plainly: the failures were at 08:31, 09:03 and 09:04, and the successes
      at 09:14 and 09:16. **Nothing in the logs recorded which of those were the installed build and
      which were `npm start`** — `app.start` logged only platform and arch. So "dev works, built
      doesn't" rests on five samples of an intermittent fault with the key variable unrecorded. It
      could be three coincidences. It could also be exactly as described. Right now nobody knows,
      and the cheapest fix is to stop needing to know.

      Searched for a mechanism and found none: no `isPackaged` branch anywhere in `src/`, no
      TLS-related environment variable read (the only `process.env` uses are Chrome paths,
      USERPROFILE, Laya paths and an OPENROUTER/DEEPGRAM dev prefill), and `ws` plainly loads in
      the packaged app because some sessions connected fine. There is no code path that *should*
      behave differently.

      Two changes, both of which are real regardless of how the above resolves:

      - **A superseded socket could report as the live one.** `connect()` reassigns `this.ws`, but
        the previous socket keeps its handlers, and every one of them read `this` — so a late
        `error` or `close` from a torn-down socket was logged as `stt.socket_error` / `stt.closed`
        and pushed into `onError` / `onClose`, triggering a reconnect for a connection that was
        fine. That is precisely the shape of the observed log: a close, then a TLS error, then a
        failed reconnect. Handlers are now bound to the socket they were created for via
        `isCurrent()`, and a superseded event is logged under `stt.superseded_socket_*` instead so
        it stays visible rather than being silently dropped. Verified against the **compiled**
        `DeepgramFluxConnection` with a fake WebSocket: a superseded socket's error neither logs as
        `stt.socket_error` nor reaches the error callback nor triggers a reconnect, while the live
        socket still does all three. 14 checks.
      - **`app.start` now records `packaged`, `electron` and `node`.** A log that does not say
        which build produced it cannot answer a question about which build misbehaves, and this
        cost a full round of back-and-forth to establish by hand.

      Not established: that the packaged build is the variable. Next run of either build now says
      so in its own first log line, and any TLS failure carries `errorCode` (pass 52). Alternating
      installed / dev runs would then settle it without further guessing.

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

## Corporate TLS interception fix (2026-09-28)

The packaged app failed to connect to Deepgram at all on a machine with corporate TLS
interception installed (`stt.socket_error` / `SELF_SIGNED_CERT_IN_CHAIN`), which also would
have broken the Jev/OpenRouter decision call the moment STT got past it — Node's bundled CA
store doesn't trust the interception proxy's root cert that's injected into the macOS System
Keychain. Fixed in `src/main/system-ca.ts` (`trustSystemCaCerts()`, called at the top of
`src/main/index.ts` before any network module is touched): extracts the System Keychain's certs
via `security find-certificate` and monkey-patches `tls.createSecureContext` so every secure
context without its own `ca` gets them merged in. Since it reads whatever's already in the
System Keychain rather than hardcoding a specific proxy's cert, this covers any such
interception tool (or none — on an unaffected machine it just merges in the normal OS-trusted
roots, a no-op in practice). See DECISIONS.md for why `NODE_EXTRA_CA_CERTS` didn't work and why
the import style matters.

Verified end-to-end on an affected machine: ran `npm run dev` and confirmed the log shows
`main.system_ca_loaded` → `stt.connected` → `stt.session_connected` → `decision.response` (real
Jev/OpenRouter response) → `pipeline.execution` for a real spoken command, no
`SELF_SIGNED_CERT_IN_CHAIN` anywhere. Not yet re-verified against a full `package:mac` build
(only `npm run dev`, same compiled `dist/` output) or on Windows (no Windows machine here, and
no report of the same symptom there).

## Vision-based screen click (`screen_click`) (2026-09-28)

Added point-and-click anywhere on screen for UI elements outside the Chrome DOM path (native app
buttons/icons), via screenshot + vision-LLM instead of Accessibility APIs — see DECISIONS.md for
the full rationale. New pieces: `src/decision/vision-client.ts` (`locateElement()`, calls
OpenRouter's standard chat-completions endpoint with `openai/gpt-4o-mini`);
`automation.captureFrontmostWindow()` / `automation.clickAt()` on both platforms;
`screenClickOverride()` + the `screen_click` case in `src/decision/resolve.ts`; execution wired
in `src/main/pipeline.ts`'s `executeScreenClick()`. `npx tsc --noEmit` passes with no errors.

**Not run/verified in this sandbox** (no GUI, no macOS/Windows machine, same caveat as the rest
of this file):
- macOS `captureFrontmostWindow`/`clickAt` (`osascript`/`screencapture`) — reasoned about by
  inspection only, not executed against a real window.
- Windows `captureFrontmostWindow`/`clickAt` (`GetWindowRect`/`SetCursorPos`/`mouse_event` via a
  new `DragonClickWin32` P/Invoke type) — unverified on real Windows hardware, same as the rest
  of `windows.ts`.
- The actual OpenRouter vision call (`openai/gpt-4o-mini`) — not exercised against a real
  screenshot or API key.

Manual verification still needed on a real Mac: say "click the [visible button label]" with a
native app frontmost and confirm the click lands; say "click on [a link]" with Chrome frontmost
and page elements available and confirm it still goes through `chrome_click`, not `screen_click`
(regression check for `screenClickOverride`'s guard); revoke Screen Recording permission and
confirm the friendly error message surfaces.

### Follow-up fixes from first real-hardware test (2026-09-28)

The first real test (`dragon-2026-09-28.jsonl`, session `sess_mulgi36b_8sftul`) surfaced three
issues, all fixed here:

1. **Every command, not just `screen_click`, was stalling ~10s.** `automation.getActiveAppName()`
   and `captureFrontmostWindow()`'s window-position query both share `run()`'s 10s `execFile`
   timeout meant for slower commands. In this session both were timing out (not erroring fast),
   which `activeAppMs`/`executionMs` in the logs confirm (~10000ms on every single utterance).
   `captureFrontmostWindow()`'s catch block then unconditionally rethrew a generic "no window"
   message, masking the real timeout. Fixed: both quick, read-only queries now use a 3s timeout
   (`QUICK_QUERY_TIMEOUT_MS`), and `friendlyOsascriptError()` now distinguishes a timeout
   (`err.killed`) from a real Accessibility-permission error, producing an actionable message
   ("System Events may be stuck behind an unanswered permission dialog...") instead of the
   generic one. Root cause of *why* System Events itself was stalling is still unconfirmed — most
   likely a hidden/unanswered permission dialog — flagging for the user to check next test.
2. **Retina click-accuracy bug + unnecessary vision cost/latency.** `captureFrontmostWindow()`'s
   PNG is in *pixels* (2x on Retina) while `bounds` is in *points*; `executeScreenClick()` was
   adding the vision model's pixel-space point directly onto point-space bounds — on Retina this
   would click at roughly 2x the intended offset. Fixed by having `captureFrontmostWindow()`
   downscale to a max 1280px width via Electron's built-in `nativeImage` (no new dependency —
   cuts vision-call image tokens, and therefore cost and latency, on large screens too) and
   return the actual sent `imageWidth`/`imageHeight`; `executeScreenClick()` now scales the
   returned point by `bounds.width / imageWidth` (and height) instead of assuming 1:1. Windows'
   `captureFrontmostWindow()` gained the same two fields for interface parity (ratio is 1:1
   there today since `CopyFromScreen` captures exactly `width x height` pixels — unverified on a
   real HiDPI Windows display).
3. **No visible loading feedback.** The overlay already sends a generic "Thinking"/"Executing"
   state for every command (`src/main/pipeline.ts`'s `onOverlay` calls), so no new IPC/state was
   needed. Added a CSS pulse animation to the status dot for those two states
   (`src/renderer/overlay.html`) so a multi-second vision round-trip reads as "in progress"
   rather than looking frozen. If the overlay still isn't visible, check the tray's "Show
   Overlay" checkbox — `overlayVisible` defaults to `true` but persists once toggled.

On the "cheaper/faster vision model" question: `gpt-4o-mini` already prices at $0.15/$0.60 per M
tokens with ~0.5s model latency (OpenRouter, Sept 2026 pricing) — comparable to other
options researched (DeepSeek V4 Flash Vision, Perceptron Mk1). The measured 3.4-5.7s round trip
was mostly screenshot size/network overhead, not model choice, which the downscaling above
directly addresses; kept the model as-is rather than switching to an unverified alternative.

### Second real-hardware test: `clickAt()` hang root-caused and fixed (2026-09-28)

After granting Accessibility/Screen Recording/Automation permissions correctly (confirmed via
screenshots of System Settings — "Electron"/"Dragon" both listed and enabled, "System Events"
enabled under Automation), `screen_click` still failed: `vision.locate_element found:true`
succeeded every time, but `clickAt()` hung for the full 10s timeout, every time, against Slack.

Root-caused by reproducing the hang **outside Dragon entirely** — ran
`osascript -e 'tell application "System Events" to click at {x,y}'` directly from a
fully-trusted terminal (Warp, already granted Accessibility/Automation): instant when the
terminal's own window was frontmost, hung 30+ seconds when Slack was frontmost. This is a
documented AppleScript limitation, not a Dragon permission gap: System Events' `click` command
hit-tests the target app's accessibility tree to resolve what's under the point, and that
hit-test can hang indefinitely for Electron/Chromium-based apps (Slack, VS Code, etc.) with
incomplete AX trees.

**Fixed** in `src/automation/macos.ts`: `clickAt()` now runs a JavaScript-for-Automation script
(`osascript -l JavaScript`) that posts a raw `CGEvent` via `ObjC.import('CoreGraphics')`
(`CGEventCreateMouseEvent` + `CGEventPost` at the HID event-tap level), bypassing System
Events' AX hit-testing entirely. Same Accessibility permission, no new dependency (JXA is
built into macOS). See DECISIONS.md for full detail.

**Verified:** from a terminal, the JXA click returns in ~0.07s with Slack frontmost (previously
hung 30+ seconds in the same scenario). **Not yet re-verified through the full Dragon pipeline**
(screenshot → vision → click) — retest `screen_click` end-to-end and confirm
`pipeline.execution`'s `executionMs` no longer includes a ~10s `clickAt()` stall.

### Third real-hardware test: click lands slightly off-target, overlay "Executing" vanished instantly (2026-09-28)

The `clickAt()` fix worked — the mouse now moves and clicks with no hang — but two issues
surfaced:

1. **Click lands slightly off the intended element.** Root cause: `locateElement()`
   (`src/decision/vision-client.ts`) asked the vision model for raw pixel coordinates within the
   sent image. OpenAI's vision endpoint internally downscales/tiles the uploaded image before the
   model ever sees it (documented image-tokenization behavior), and the model has no way to know
   that resize happened — its pixel answer is relative to whatever resolution OpenAI's backend
   actually processed, not the `imageWidth`/`imageHeight` we sent and used to scale back to screen
   coordinates, producing a systematic offset on top of ordinary vision-model imprecision. Fixed
   by asking for `x_pct`/`y_pct` (0-100 percentage of image width/height) instead of raw pixels —
   percentages are scale-invariant, so OpenAI's internal resizing no longer matters — and
   converting to pixels in `locateElement()` using the caller-supplied `imageWidth`/`imageHeight`.
   `executeScreenClick()` in `src/main/pipeline.ts` now passes those through.
2. **The "Executing" overlay state vanished almost immediately, well before the click actually
   happened.** Root cause: Deepgram keeps streaming ambient audio during a slow command (the
   screenshot+vision+click round trip takes 3-5s), which fires `StartOfTurn`/`Update` events for
   incidental noise; `onTurn`'s handler for those events unconditionally pushed a "listening"
   overlay update, overwriting "Executing" before the command actually finished — with no
   completed action yet to fall back to (`overlay.ts`'s completion-linger logic only kicks in
   after a real "done"/"error"), the action/status text was cleared outright. Fixed by adding
   `executingUtteranceId` to `DragonPipeline`, set for the duration of `executeCommand()` in the
   main decision flow; `onTurn`'s `StartOfTurn`/`Update` branch now skips the "listening" overlay
   push while it's set. Purely cosmetic — only gates the overlay push, not turn processing, so a
   genuine new utterance spoken during execution is still captured normally.

**Verified:** the "Executing" overlay state is now stable through the full round trip. Click
accuracy improved but is still imprecise on dense targets — real-hardware session against Slack
(a busy channel-list sidebar) hit the intended element once ("kudos") but missed to a
nearby-but-wrong row twice in a row for "security" (landed on "pde-all", then
"newco-aapi-erg" — both a few rows away in the same sidebar), landed on the right general area but
not exactly for "activity", and for "Tonya" landed on a post she'd written rather than her
name/avatar specifically. `logger.event("vision.locate_element", ...)` only records
`description`/`found`, not the actual `x_pct`/`y_pct` or resolved screen coordinates, so the
misses couldn't be pinpointed from logs — diagnosed by inspection instead.

Root cause: `locateElement()`'s OpenRouter request never set a `detail` value on `image_url`.
Per OpenAI's documented vision behavior, without `detail: "high"` a busy image can be processed
as a single low-resolution pass — fine for one large isolated button, but the Slack sidebar's
channel rows are only ~10px tall after the existing 1280px-width downscale, well below what a
low-res pass can distinguish between neighbors. **Fixed** in `src/decision/vision-client.ts` by
setting `image_url.detail = "high"`, which makes OpenAI tile the image at full resolution instead.
**Not yet re-verified on real hardware.**

### Overlay jitter: concurrent command executions could stomp each other's display (2026-09-28)

User also reported occasional jitter — the overlay dot/status briefly flashing to "error" (or
some other stale state) before correcting itself to the current spoken prompt. Overlay pushes
(`onOverlay(...)`) aren't logged anywhere, so this couldn't be confirmed against a specific
timestamp in this session's logs (the captured exchange's commands happened to run back-to-back,
not overlapping). Found a plausible unconfirmed cause by inspection: `executeCommand()` has no
cancellation, and `executingUtteranceId` was a single field — if a second command is spoken while
a slow one (e.g. `screen_click`'s 3-6s screenshot+vision+click) is still running, both executions
interleave on the event loop and the **older** one's unconditional "done"/"error" overlay push
(after it finally finishes) can overwrite whatever the newer command has since displayed.

Applied a defensive fix in `src/main/pipeline.ts` regardless, since it's cheap and correct even if
unconfirmed: capture `isCurrentExecution = this.executingUtteranceId === turn.utteranceId` right
after `executeCommand()` returns, before clearing the flag. If a newer command already overwrote
`executingUtteranceId` with its own id, this command is stale — skip reclaiming the flag (it
belongs to the newer command now) and skip this command's own "done"/"error" overlay push. History
logging, `pipeline.execution` events, and the voice reply are unaffected — only the overlay
*display* push is gated. **Not yet re-verified on real hardware** (and still unconfirmed as the
actual cause of the reported jitter).

### Fourth/fifth real-hardware tests: wrong-row picks in dense sidebars, root-caused and fixed (2026-09-28)

`detail: "high"` and switching `openai/gpt-4o-mini` → `openai/gpt-4o` (see `vision-client.ts`)
did not fix the underlying issue: repeated `screen_click` calls against Slack's dense channel
sidebar and macOS System Settings' sidebar kept landing on the **wrong row entirely** ("security"
→ "pde-all", then → "newco-aapi-erg"; "activity" → "my team", then → "copilot-conversation-testing"),
not just imprecisely on the right one. Ruled out the coordinate-scaling and OpenAI image-tiling
(edge-of-image) hypotheses by inspection and by testing a non-edge target in System Settings,
which showed the same failure mode — confirming this is `gpt-4o`'s point-grounding struggling to
discriminate the Nth item among many visually-similar, tightly-packed rows, independent of image
position, model choice, or `detail` setting.

**Fix** (`src/decision/vision-client.ts` + `src/main/pipeline.ts`): the vision prompt now also
asks for the exact visible `label` text at the point it picked. `executeScreenClick()` fuzzy-
matches (`labelMatches()`, token-overlap) that label against the spoken description before
trusting the point; on mismatch it crops a region around the (wrong) point — 50% width / 30%
height of the window, centered on the miss — and re-asks `locateElement()` on just that crop
(less competing UI per pixel). If the second attempt's label still doesn't match, `screen_click`
now fails with a clear error naming what it found instead, rather than silently clicking the
wrong row. The common case (label matches on the first try) is unchanged — one round trip, no
added latency. **Not yet re-verified on real hardware** — retest the same dense-sidebar sequence
("security", "activity") and confirm either a correct click or a clean failure, never a
wrong-row click.

### Sixth real-hardware test: self-reported `label` proven unreliable as a check; switched to an independent read-back (2026-09-28)

The label-verification fix above did not help — logs showed the model's own `label` field
reliably echoing the requested description ("general" → `label:"General"`, "screen time" →
`label:"Screen Time"`) even while `x_pct`/`y_pct` landed on a completely different row (Network,
Sound respectively). This isn't a wrong-row *semantic* pick, it's the model failing to ground its
own correct answer to a pixel — asking it to "find X" and trusting its self-reported label for
the same call shares that bias, so `labelMatches()` never fired.

**Fix**: added `readLabelAtPoint()` (`src/decision/vision-client.ts`) — a second, separately-
framed call with no "find X" hint. It's given a small crop (6% width / 3.5% height of the window,
`VERIFY_CROP_MARGIN` in `src/main/pipeline.ts`) centered on the candidate point and asked "what
text is here?", forcing an independent read instead of a repeat of the target. `executeScreenClick()`
now verifies every point this way (not just on a self-reported mismatch), and only falls back to
the wider re-localization crop (`RELOCATE_CROP_MARGIN`, previously the whole fix) when the
independent read disagrees. The original `locateElement().label` field is kept for logging only,
no longer trusted for verification. Adds one extra vision call on the common path (every click is
now verified, not just retried on suspicion) — acceptable latency/cost tradeoff for correctness on
an alpha. **Not yet re-verified on real hardware** — retest "general"/"screen time"/"focus" in
System Settings and confirm the independent read-back actually disagrees when the point is wrong
(check `vision.read_label_at_point` in the logs), and that a correct point is never rejected.

### Seventh real-hardware test: independent verification works, but the retry crop assumed the wrong failure mode (2026-09-28)

The read-back verification above worked as intended — it correctly rejected a bad point ("Harshit"
→ landed on Slack's "DMs" tab, verification caught the mismatch and refused to click it). But the
retry then failed too: `locateElement`'s wrong point (5.4%, 20.5%) was near Slack's top tab bar,
while "Harshit Agarwal" is a row further down in the Activity list — the `RELOCATE_CROP_MARGIN`
crop centered on the *wrong* point never contained the real target, so re-asking on it deterministically
returned `found: false`, and `screen_click` failed outright instead of clicking anything.

This is a different failure mode than the one the relocate-crop retry was designed for: a
*close-but-imprecise* miss (row N-1 instead of row N, still inside the crop) is fixed by a tighter
crop; a *wrong-region* miss (tab bar instead of list) is not, because the target was never in
frame. **Fix** (`executeScreenClick` in `src/main/pipeline.ts`): after the relocate-crop retry
still doesn't verify (either `found: false` or the read-back still mismatches), fall back to one
more fresh full-image `locateElement` call before giving up — gpt-4o's point-picking is stochastic
enough that a second independent full pass often lands correctly (seen earlier with "focus"
landing right on a second full attempt). No new dependencies or grid/tiling scheme; reuses the
same `locateElement`/`readLabelAtPoint` building blocks. Only adds latency on the (already rare)
double-failure path. **Not yet re-verified on real hardware** — retest the Slack "Harshit"/dense-list
case and confirm it either clicks correctly or fails cleanly, and that the common one-shot-correct
path is unaffected.

### Retested same day: fallback fires correctly, but 3 independent attempts still all miss (2026-09-28)

Retested "Harshit" in the same dense Slack Activity list right after the fix above. Log:

```
locate_element  xPct:90.5 yPct:14.2 label:"Click \"Harshit\""   (attempt 1, full image)
read_label_at_point  label:""                                   (verify: empty — correctly rejected)
locate_element  found:false                                      (relocate-crop retry — target wasn't in that crop at all)
locate_element  xPct:4.5  yPct:8.5  label:"Harshit Agarwal"      (fallback: fresh full-image attempt)
read_label_at_point  label:"Activity"                            (verify: reads the panel header, not the row — correctly rejected)
→ error: Could not confidently locate "Harshit" on screen (found "Activity" instead).
```

Good news: the independent verification worked exactly as designed on *every* attempt — it never
clicked the wrong thing, it just ran out of attempts and failed cleanly. Bad news: the fresh
full-image fallback (the new 3rd attempt) is subject to the *exact same* grounding weakness as
attempt 1 — gpt-4o landed on the "Activity" header (y≈8.5%, near the top of the panel) instead of
the "Harshit Agarwal" row beneath it. One extra fresh attempt isn't consistently enough for this
specific case (dense list, low-frequency target); it happened to work for "focus" (2-of-2) but not
here (3-of-3 failed).

**Options for tomorrow, cheapest first:**
1. **Bump the fresh-attempt retry budget** (e.g. loop the fresh full-image attempt up to 2-3 times
   instead of once) before giving up — same building blocks, zero new code paths, just a bigger
   budget on the already-rare multi-failure branch. Cheapest, but doesn't fix the underlying
   grounding weakness, just plays the stochastic odds harder; latency grows on hard cases.
2. **Parallel multi-sample + agreement**: fire 2-3 fresh `locateElement` calls concurrently (instead
   of serially retrying), verify each with `readLabelAtPoint`, click the first (or majority-clustered)
   one that verifies. Same latency as one round-trip since parallel; better odds than serial retry
   at the same call budget.
3. **Structural alternative (bigger change, not for tomorrow without discussion)**: read the target
   element's on-screen position from the OS accessibility tree instead of vision coordinates, for
   apps where it's available — sidesteps LLM grounding entirely for text lookups. `DECISIONS.md`
   (2026-09-28) already rejected building AX traversal for *clicking* (hangs on Electron), but that
   was about `AXUIElement`-driven clicks specifically; whether read-only AX tree *lookup* (find the
   element, get its frame, then click via the existing `CGEvent`-based `clickAt`) also hangs on
   Electron/Slack is untested and would need its own investigation before reopening that decision.

Leaning toward option 2 (parallel multi-sample) as the next thing to try — same call budget as a
naive retry-budget bump, but should improve hit rate faster since it's not betting on a single
stochastic redraw. Not yet implemented — to be built and tested tomorrow.

### Multi-match discovery + Jev disambiguation for `screen_click` (2026-09-29)

Implemented the plan at `plan-screen-click-disambiguation-2026-09-29.md` — a different angle on
the wrong-row problem above: instead of asking the vision model for one point and retrying when
it's wrong, ask it for *every* on-screen match up front, verify each independently, and only
fall back to single-point retry/disambiguation logic when that's ambiguous or empty.

- `src/decision/vision-client.ts`: `locateElement()` → `locateElements()`, returning up to
  `MAX_LOCATE_MATCHES = 5` scored `{x, y, label}` points from one vision call instead of one.
- `src/decision/jev-client.ts`: added `askDisambiguationChoice()` + `DisambiguationAnswer` — an
  ad-hoc single-question follow-up (reuses `callDecisionProvider`'s provider/endpoint plumbing
  but a minimal one-question schema, since the fixed 5-question bundle requires
  intent/target/direction/complete that don't apply here).
- `src/main/pipeline.ts`'s `executeScreenClick()`: calls `locateElements()`, independently
  verifies each candidate via the existing `readLabelAtPoint()` read-back, then:
  - 0 verified → falls back to the existing single-point recovery path (`recoverScreenClickPoint()`,
    logic unchanged from the prior single-point retry/relocate-crop/fresh-attempt chain).
  - 1 verified → click it directly, no extra round trip.
  - 2+ verified → `disambiguateScreenClickCandidates()` asks Jev to choose using the full
    utterance transcript plus a coarse position description per candidate (`describeRegion()`:
    top/middle/bottom × left/center/right of the window). Falls back to a deterministic pick
    (topmost, then leftmost) if Jev can't be asked, times out, or answers below
    `SCREEN_CLICK_DISAMBIGUATION_CONFIDENCE_THRESHOLD = 0.35` — a click should still happen even
    with no disambiguating signal.
- `executeCommand()`/`executeScreenClick()` now take `transcript`/`signal` params (threaded from
  `runDecisionInternal`'s existing `effectiveText`/`controller.signal`) so disambiguation can use
  the full utterance and respect in-flight cancellation.

`npx tsc --noEmit` and `npm run typecheck` (main + renderer) both pass. **Not yet run on real
hardware** — same caveat as the rest of this section: no GUI/macOS/Windows machine in this
sandbox, so the actual OpenRouter multi-match vision call and the Jev disambiguation round trip
are unverified end-to-end. Retest the dense-list cases above ("Harshit" in Slack's Activity list,
"General"/repeated-label cases) and confirm: a single unambiguous match still clicks in one round
trip (no regression on the common path), 2+ genuinely distinct matches trigger disambiguation and
land on the one matching the spoken transcript's intent, and the zero-verified-match path still
fails cleanly via the unchanged recovery logic.

### `screen_click` accuracy + latency pass (2026-09-29)

Implemented `plan-screen-click-perf-and-correctness-2026-09-29.md`. Accuracy first: the wrong-row
misses trace to the vision model's grounding ability (see DECISIONS.md 2026-09-29), so the model
changed; the rest are latency/robustness fixes that apply whichever model wins.

- `src/decision/vision-client.ts`:
  - `VISION_MODEL` = `google/gemini-3-flash-preview` (was `openai/gpt-4o`); single switch for all vision calls.
  - `locateElements()` asks for `box_2d` ([ymin,xmin,ymax,xmax], 0–1000) instead of `x_pct/y_pct`;
    `LocatedPoint` gains `box` (image px), `x,y` = box centre. `temperature:0`,
    `reasoning.effort:"low"`, `response_format: json_object`. Logs `model` + `imageBytes`.
  - `readLabelAtPoint()`: `detail:"low"`, `temperature:0`, `reasoning.effort:"minimal"`.
  - `labelMatches()` ignores filler words (`the, and, click, tap, press, button, on, icon, link,
    tab`) and 1–2 letter tokens; new `labelExact()`; new `dedupeMatches()` (IoU > 0.5 or centre
    inside a higher-ranked box).
- `src/automation/macos.ts` / `windows.ts`: screenshot is JPEG (q85 / GDI+ default) instead of PNG.
- `src/main/pipeline.ts`:
  - Screenshot decoded once per click; crops are JPEG.
  - Verify crop = element box + 8px pad (never smaller than the old fixed margin).
  - All candidates verified concurrently (`Promise.allSettled`); one failed read-back drops only
    that candidate, all failing rethrows the first error.
  - Recovery runs the relocate-crop and fresh full-image attempts concurrently.
  - Disambiguation skips Jev when exactly one verified label equals the spoken target.
  - Failed / ambiguous clicks save the frontmost-window screenshot to
    `os.tmpdir()/dragon-screenclick-<ts>.jpg` (logged as `screen_click.debug_image`, deleted
    after 24h) for offline model comparison.

Expected round trips: unambiguous = 1 locate + 1 parallel verify; ambiguous adds 1 Jev call only
when no label matches exactly; zero-verified adds 1 parallel recovery round.

**Verified here:** `npm run typecheck` passes; a throwaway harness (electron stubbed) asserted
`labelMatches`/`labelExact`, `box2dToPixels` y/x order, and `dedupeMatches`. **Not run on real
hardware**: the Gemini calls through OpenRouter (including whether `reasoning`/`response_format`
are accepted together with an image), JPEG capture on Windows, and actual hit rate. Retest Slack
"Harshit" (Activity list) and System Settings "General"/"Screen Time"; compare
`pipeline.execution.executionMs` with the 2026-09-28 logs. To compare models on saved
screenshots, a throwaway replay script lives at `/tmp/dragon-replay/replay.mjs` (outside the
repo; usage in its header). Success bar: ≥ 90% correct click or clean failure, 0 wrong-row clicks.
If Gemini still misses dense lists, next levers are a numbered-grid overlay, then local OCR
(which would need an AGENTS.md invariant change).


## 2026-09-29 — screen_click accessibility-tree toggle

- Settings → "Screen click lookup": Vision model (default) or Accessibility tree (experimental).
- `automation.findAccessibleElements(terms)` (macOS: JXA + AX C API; Windows: UIA) returns
  labelled elements whose label contains a search term. `executeAccessibilityClick()` in
  `src/main/pipeline.ts` filters with `labelMatches`, keeps on-screen ones, dedupes, and reuses Jev
  disambiguation when several remain.

**Verified here (real macOS):** `npm run typecheck` passes. The exact embedded JXA script was run
against live apps: System Settings "general" → one element, "General" at (293,409) 74×24, 567ms;
Slack "harshit" → Activity rows, 297ms; frontmost Warp → 0 elements (no AX tree). **Not run:** a
full voice-to-click through Dragon in this mode, and anything on Windows (UIA script unverified).
Next: try Slack "Harshit" and System Settings "General"/"Screen Time" in both modes; compare hit
rate and `pipeline.execution.executionMs`.


## 2026-09-29 - auto mode

- Added `"auto"` screen click mode (default), Electron-only AX retry, and the Jev app-intent override fix. Typecheck passes; not run end-to-end. To test: Warp "click Spring Boot" (falls back to vision), System Settings "click General" (accessibility), "click on Chrome" (focuses Chrome).

## 2026-10-01 - implicit click verbs, numbered picker, keyterms

- **Decision:** (1) "select/choose/pick/change to/set to/turn on/turn off/toggle X" route to `screen_click` (`extractImplicitClickTarget`); "go to"/"switch to" excluded (app launch / search_in_app own them), "select all" excluded. (2) When 2+ matches remain and Jev is not confident, Dragon no longer clicks the first; it sets `pendingChoice` and shows "Which one? Say a number" in the overlay. The next final utterance "1".."5" clicks, "cancel" clears, anything else clears. (3) Added select/choose/toggle/cancel to `STT_KEYTERMS`.
- **Reason:** user had to say "click" every time, and Slack duplicate names clicked the wrong row. Wispr Flow has no developer API (cloud consumer app), so it cannot replace Deepgram; local Whisper deferred.
- **Consequences:** picker is text in the overlay (no on-screen badges). "Click this" cursor hit-test, dynamic app-name keyterms and `stt.low_confidence` logging are not done. Typechecked only; not run through Dragon. Unknown whether numeric replies pass the always-listening addressed gate.

## 2026-10-01 - picker hardening

- **Decision:** Ambiguous click prompt throws ChoiceRequiredError (overlay listening, outcome ignored, not an error). Reply path dedupes via executedUtterances, records history, surfaces clickAt failures, accepts homophones (won/to/too/for), drops the choice if the frontmost app changed, and ignores non-final turns while a choice is live.
- **Reason:** Prompt looked like a failure; reply path skipped duplicate suppression; stale coordinates and misheard numbers.
- **Consequences:** Typechecked only; not run on hardware.

## 2026-10-01 - Windows corporate TLS interception fix

**Symptom:** certificate failure running the built app on a Windows machine. The macOS fix from
2026-09-28 turned out never to have applied on Windows: `src/main/system-ca.ts` opened with
`if (process.platform !== "darwin") return;`, so `trustSystemCaCerts()` was a no-op there and
Dragon connected with Node's bundled CAs only. Same root cause as the macOS report — Node doesn't
read the OS trust store, so an MDM/TLS-inspection root is invisible to it.

**Change** (`src/main/system-ca.ts` only; no other file touched). The cert source is now chosen
per platform and the existing `tls.createSecureContext` merge is shared by both:
- `win32` (new): reads `Cert:\CurrentUser\Root` and `Cert:\LocalMachine\Root` via
  `powershell.exe -NoProfile -NonInteractive -Command`, deduped by thumbprint, emitted as PEM.
  Reading `LocalMachine\Root` needs no elevation.
- `darwin`: unchanged (`security find-certificate -a -p /Library/Keychains/System.keychain`).
- `main.system_ca_loaded` now carries `platform` as well as `certCount`, so one log line says
  which branch ran.

**Verified here (Linux, no Windows machine available).** Throwaway harness in `/tmp/opencode`
(never committed; AGENTS.md forbids test suites) stubs `electron`, forces `process.platform`,
and stubs `execFileSync` to return a PowerShell-shaped PEM. Against a locally generated
root -> intermediate -> leaf chain shaped like real interception:
- Before the patch, handshake fails `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (the real symptom).
- After, `tls.connect` succeeds, `https.get` returns 200 (the `ws`/Deepgram path) and global
  `fetch()` returns 200 (the Jev/vision path).
- The merged `ca` array held all 121 Node bundled roots plus the injected one, so public CAs
  were not un-trusted by the merge.
- A server signed by an unrelated CA is still rejected (`DEPTH_ZERO_SELF_SIGNED_CERT`) — roots
  are merged, verification is not disabled.
- An explicit caller-supplied `ca` is still passed through untouched.
- macOS branch re-checked after the refactor: same `security find-certificate` call, certs
  merged, bundled roots intact.

**Not verified:** no real `powershell.exe` ran (none on this host), so the script is correct by
inspection only, and nothing has run on Windows hardware. `npm run package:win` also can't run
here — `scripts/build-release.js` refuses a Windows target on Linux without `wine` because
electron-builder needs `rcedit` to stamp the icon, and without it Windows won't launch the exe.
Build on the Windows machine instead.

**Trap found while verifying, worth not re-introducing:** if a PEM's last base64 line isn't
newline-separated from the `-----END CERTIFICATE-----` armour, Node **silently ignores that
certificate** — no throw, just `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` at connect time (confirmed:
`ERR_OSSL_PEM_BAD_END_LINE`). `[Convert]::ToBase64String(bytes, "InsertLineBreaks")` breaks every
64 chars but emits no trailing break, so the script's `AppendLine($b64)` is load-bearing. A plain
`Append` there would make the whole fix a silent no-op.

**To verify on Windows:** run the app, then check `%APPDATA%\Dragon\logs\dragon-*.jsonl` for
`main.system_ca_loaded` (`platform: "win32"`, `certCount` in the hundreds) followed by
`stt.connected` -> `stt.session_connected` -> `decision.response`. `main.system_ca_load_failed`
means the PowerShell read threw; no line at all means the store held nothing extra.

### Follow-up: first Windows log was ambiguous (2026-10-01, later same day)

The first build carrying the Windows branch produced logs with **no** `main.system_ca_*` line at
all: neither `loaded` nor `load_failed`, on either of two sessions. `stt.socket_error` was
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` as before. That absence was undiagnosable because the code had
`if (certs.length === 0) return;` — a zero-cert read logged nothing, which is byte-identical to
the code not having run (stale build). Removed the early return; zero is now a logged result.

Also observed in that log, independent of the fix: on 2026-09-29 the same machine had
`stt.connected` at 20:21/20:22 **and** `stt.socket_error` at 20:25. So the failure is
intermittent on a per-run basis, which fits a network-dependent TLS-inspecting proxy (different
network/VPN state) rather than a permanently missing root.

Second change in the same pass, for robustness: the Windows read now uses .NET's `X509Store`
directly instead of the `Cert:` PowerShell drive. The drive is a module-provided convenience layer
and can be unavailable under AppLocker/WDAC, which failed silently; the API cannot. Each store is
independently try/caught so one unreadable store can't hide the other's certs, and a failure
message rides on stdout as `#error <store> <message>` (stderr is only reachable through a thrown
error's message, i.e. never on the success path).

**Verified on Linux** (harnesses in `/tmp/opencode`, not committed):
- Empty stores -> `main.system_ca_loaded` `certCount:0` `LocalMachine:0` `CurrentUser:0` is
  logged (previously silent). This is the regression guard for the ambiguity above.
- One store errors -> the other still contributes: `certCount:1` plus
  `CurrentUser_error:"The system cannot find the file specified"`.
- `#store`/`#error` lines are parsed out of stdout into the log and never reach the `ca` array.
- All prior TLS checks still pass: fails `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` before the patch;
  succeeds after via `tls.connect`, `https.get` and global `fetch()`; all 121 Node bundled roots
  retained; an unrelated CA still rejected; explicit caller `ca` untouched.
- macOS branch re-checked: unchanged.

**Still not verified:** no real `powershell.exe`, no Windows hardware. The next Windows log now
distinguishes all three cases that were previously conflated:
`certCount` in the hundreds = loaded; `certCount:0` = read succeeded, store genuinely held nothing
extra (interception then isn't the cause and the diagnosis must be revisited); `*_error` or
`main.system_ca_load_failed` = the read itself failed, with the reason.

### Resolved on Windows hardware (2026-10-02)

Reported working on the user's Windows machine after a clean rebuild
(`%LOCALAPPDATA%\Programs\Dragon` and `release\` removed first, then `npm run package:win` from
current source). The Deepgram `wss://` connects and Jev/OpenRouter responds, no
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

**The earlier "still broken after installing the latest build" was a stale binary, not a failed
fix.** Two causes compounded: `artifactName` is `Dragon-${version}-${arch}-Setup.exe` and the
version was still `0.1.1`, so every rebuild had an identical filename with nothing to signal it
was new; and installing the same version over an existing same-version install is a reliable way
to keep running the old binary on Windows. `scripts/build-release.js` also does not clear
`release/` before packaging. The log settled it: that build emitted no `main.system_ca_*` line
at all, which the current code makes impossible on Windows (every launch logs exactly one of
`..._loaded` / `..._load_failed`). Version was deliberately NOT bumped to work around this.

Worth remembering for any future "I rebuilt and it still fails" report on this project: check
whether the log shows the code's own fingerprint before believing the fix was exercised. The
earlier round of this same issue was spent chasing a stale binary partly because the zero-cert
path logged nothing, making old and new code indistinguishable in the log.

**Caveat on the causal claim.** Intermittent by nature: on 2026-09-29 the packaged build logged
`stt.connected` at 20:21/20:22 and `stt.socket_error` at 20:25 on the same machine, so the
failure tracked network/VPN state rather than the binary. Whether the corporate root was actually
present in the Windows store on the working run is not yet confirmed from the log's `certCount` —
if that value turns out to have been 0, the fix was not the cause and the original failure needs
re-diagnosis. Worth one `Select-String` for `system_ca` over `dragon-2026-10-02.jsonl`.

### Confirmed: 59 roots merged, interception was the cause (2026-10-02)

The working packaged build's log:

```
{"stage":"main.system_ca_loaded","platform":"win32","certCount":59,"LocalMachine":59,"CurrentUser":0}
```

This closes the open item above, and in the direction that confirms the fix:

- The new code definitely ran (`main.system_ca_loaded` is a fingerprint the old code cannot emit).
- The PowerShell read worked. Both stores were attempted and **neither errored**; `CurrentUser: 0`
  means CurrentUser was read and genuinely empty, not silently skipped — which the old
  `Cert:`-drive version could not distinguish from a failure.
- 59 roots were merged into Node's CA set alongside its bundled 121, all from `LocalMachine`,
  which is where MDM/inspection agents install theirs.

The trust store is the only functional difference between the failing build and this one (same
Electron 33.4.11, same Node 20.18.3, same machine), and the outcome went fail -> pass, so one of
those 59 was the missing chain anchor. That is the causal claim, and it now rests on the log
rather than on inference.

**Residual, stated honestly:** which of the 59 is the inspection root isn't recorded, so the
identification is "one of these 59" rather than a named cert. Naming it would mean logging
certificate subjects (or an admin-scope PowerShell query on the Windows box), which isn't worth
another build-and-run cycle for an app that now works. The 09-29 intermittency — same binary
connecting at 20:21 and failing at 20:25 — also means network/VPN state was a possible
co-factor; the fix removed the cert problem, but the trigger may still be network-dependent.

## Windows accessibility click matched nothing (2026-10-02)

**Symptom:** accessibility-based `screen_click` never worked on Windows; the same commands worked
smoothly on macOS. `auto` mode hid it completely, because a miss just logs
`screen_click.fallback` and silently uses vision instead — so "accessibility is broken" was never
visible as an error.

**How it was found.** Not by reading the code. Component probes were run against the reported
machine first, and two plausible theories were killed by measurement rather than argument:

- *"Chrome doesn't expose page content to UIA"* — true, but irrelevant: the user was testing
  native OS UI (Windows Settings), not a webpage.
- *"the unbounded `Descendants`/`TrueCondition` walk blows the 10s timeout"* — false on this
  machine: 148 elements read in ~33ms against a 10,000ms budget.

Reproducing `findAccessibleElements()` verbatim (same `Add-Type` block, same
`GetForegroundWindow()`, same filter loop, same `ConvertTo-Json`) with instrumentation at each
stage then showed the real cause in one line.

**Root cause.** The terms line was

```powershell
$terms = @('["a","b"]' | ConvertFrom-Json)
```

`ConvertFrom-Json` emits a JSON array as a *single* pipeline object, and `@()` wraps that object
without flattening it. So `$terms` was a 1-element array whose element is an `Object[]`, not two
strings — the run printed `terms parsed: System.Object[]  count=1`. The filter then called
`$label.Contains($_)`, and `String.Contains(String)` cannot accept an `Object[]`, so every
comparison threw, nothing matched, and the result was always an empty list.

macOS never hit this: it passes the JSON as an `osascript` **argument** (`run("osascript", [...,
JSON.stringify(terms)])`), where JXA parses it into a proper flat array. Only the Windows path
inlined the JSON into a script string and piped it through `ConvertFrom-Json`.

Measured against a real Windows Settings window: **144 elements, 120 named labels** — including
`System`, `Bluetooth & devices`, `Accessibility`, `Privacy & security` — and **0 matches**. The
accessibility read was never the problem; matching was.

**Fix** (`src/automation/windows.ts`): inline the terms as a flat PowerShell array literal,
`@('system','bluetooth')`, which removes the pipeline-flattening subtlety entirely. `psQuote`
already doubles embedded single quotes and single-quoted PowerShell strings treat backticks
literally, so inlining has no other escape to get wrong. Also added the guard macOS already had:
empty stdout or a zero-size window now throws a message naming the cause instead of
`JSON.parse("")` -> `Unexpected end of JSON input`.

**Verified on the reported machine** (fixed script, real Windows Settings window):

```
### terms count=2 type=String values=system,bluetooth
### window=[Settings]
### elements=148  MATCHED=4
    'System' at 1409,795 419x54
    'Bluetooth & devices' at 1409,855 419x54
    'Bluetooth devices' at 1910,1341 744x126
    'Bluetooth devices' at 1948,1379 668x40
```

**Still to do:** rebuild and confirm end-to-end through Dragon itself ("click Bluetooth" in
Settings, in accessibility mode). Note that substring matching legitimately returns several
candidates here (sidebar item plus page content), which is what the numbered picker
(`pendingChoice`, see the 2026-10-01 picker entries) exists to resolve.

**Lesson worth keeping:** the two most confident theories were both wrong, and both were cheap to
test directly. Two earlier probes were also thrown off by measuring the wrong window — the
foreground window was the terminal running the probe. Target windows by process handle instead of
by focus when probing this code.

### Verified end-to-end on Windows; three residual misses (2026-10-02)

Read the real Windows logs directly (this dev host is WSL2 with `/mnt/c` mounted, so
`%APPDATA%\Dragon\logs` is readable from here — no need to paste).

**Accessibility matching is fixed.** Nine `automation.click_at` events with
`method:"accessibility"` and no vision fallback, across two sessions:

- maximized Settings (`-7,-7 2575x1455`): `Gaming` rel(242,730), `Windows Update` rel(242,909)
- restored Settings (`915,346 1415x641`): `System` rel(704,476), `Bluetooth & devices`
  rel(704,536) — `Bluetooth` matched **5** labels, deduped to 1 candidate, clicked cleanly, which
  is exactly what the standalone verify script predicted
- earlier session: `System`, `Home`, `Personalization`, all correct sidebar positions

`main.system_ca_loaded` also appears once per session, so the CA-trust fix is live in the
packaged build.

**Three misses remain, all in `accessibility` mode** (so they surface as errors rather than silent
vision fallbacks, per `executeScreenClick`'s `AccessibilityMissError` handling):

```
20:41:17  Could not find "Windows Update"
20:41:35  Could not find "gaming"
20:41:39  Could not find "accounts"
```

Each follows a successful click that navigated Settings to a new page, and the window changed
from maximized to restored mid-sequence. The most likely explanation is that a narrower Settings
window collapses its navigation pane, so those sidebar labels are genuinely absent from the UIA
tree. **Not proven from this log**: whether UIA returned 0 labels or the window-bounds /
`labelMatches` filters dropped them. That distinction is precisely what the `screen_click.ax_lookup`
event added in commit `7d26bee` records, and that commit landed *after* the run being read here —
so the next attempt answers it directly.

**Not yet done:** no confirmed root cause for the three misses, and no fix attempted for them.

## 2026-10-02 Windows scroll-into-view + literal click override

- `src/automation/windows.ts` `findAccessibleElements`: if a matched element is `IsOffscreen`, empty, or outside the window rect, call UIA `ScrollItemPattern.ScrollIntoView()` and re-read its bounds. Targets the `matchCount:1, candidateCount:0` misses in the restored window (session `sess_muq1lven_g5h4hy`).
- `src/decision/resolve.ts` `isDeterministicScreenClick` + `src/main/pipeline.ts`: a literal "click/tap X" on a final turn (not in dictation/workflow) skips the not-addressed gate and the `none`/low-confidence drop. Fixes "Click system." being ignored.
- Verified: `npx tsc --noEmit` clean. **Not run on Windows hardware.** Does not help if the nav pane collapses into a hamburger menu.
- Open: Settings `activate_app` `focused:false` (6.5s; UWP app hosted by `ApplicationFrameHost`), and merging lookup + click into one PowerShell call.

