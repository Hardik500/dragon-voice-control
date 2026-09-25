# Dragon — macOS + Windows voice-control agent (personal alpha)

Dragon listens for spoken commands and controls desktop applications, text entry, system
volume/media, and your existing Chrome browser — on macOS and Windows. It is a **personal
alpha**: unsigned, no automated tests, no guardrails/confirmation prompts, direct commands
only (no multi-step cross-app planning). See `PROGRESS.md` for exactly what has and hasn't
been verified on real hardware, and `DECISIONS.md` for why things are built the way they are.

## What works

- Push-to-talk and always-listening activation modes.
- Open/activate/hide/quit apps, switch to the previous app, press keys and shortcuts, control
  the active window, adjust/mute system volume, control media playback, open Settings panes
  and Finder/File Explorer locations.
- **Voice dictation**: say "type ..." once, or say "start typing"/"insert mode", then just keep
  talking — Dragon keeps typing everything it doesn't recognize as another command. Insert Mode
  is text-first: app/browser/media commands are typed as text until you say "stop typing" or use
  `Control+Alt+I` to leave. Standalone key presses and shortcuts execute and keep Insert Mode
  active; a keyboard phrase embedded in a longer sentence remains text. Say "new line", "delete
  the last 3
  words", "delete that", "delete everything", or "replace X with Y" to edit what was just
  dictated (computed from an exact tracked copy of what Dragon typed, not by reading the
  app's screen); say "stop typing" or "exit insert mode" to end the session explicitly, or just
  say a different command. `Control+Alt+I` toggles Insert Mode without changing microphone
  state.
- **Workflow Mode**: use `Control+Alt+Shift+W` to toggle a sequential session. A single spoken
  utterance can contain a constrained sequence such as "open Notepad, then open Chrome, then open
  Cursor"; each recognized segment becomes a step. Progress is shown in the overlay, and a failed
  step ends the workflow. This is not an unrestricted natural-language planner.
- Open Chrome and navigate/search (works without the extension, and reuses an already-open
  tab for the same site instead of always opening a new one); click a visible element, type
  into a field, select a dropdown option, scroll, go back/forward/reload, and open/close/switch
  tabs (requires the unpacked extension, see below). Searching while already on a known site
  (YouTube, YouTube Music, GitHub, Reddit, Amazon, Wikipedia, ...) searches that site directly
  instead of Google.
- "Search for X" inside a non-browser app (Slack, Notion, VS Code, Discord, ...) via that
  app's own Cmd/Ctrl+K quick-open shortcut.
- Floating overlay showing live transcript/state/action/latency, short spoken
  acknowledgements, and a persisted command history viewable from Settings.
- Structured JSONL debug logs with latency breakdowns (never containing API keys,
  Authorization headers, or raw audio).
- A standalone, read-only Jev dashboard at `http://127.0.0.1:17873/dashboard`, showing the
  selected intent/target/direction, confidence, probability bars, closest alternatives, and
  STT-turn/Jev-request latency.

## What it is not

No guardrails, confirmation prompts, or action deny-lists (by design — see the plan). No
automated tests. No code signing/notarization. No autonomous multi-step planning — every
command is direct and executes (at most) once; "open Slack, search for X, and type a message"
must be spoken as three separate commands, not one utterance.

## Prerequisites

- **macOS on Apple Silicon** (a recent release) **or Windows 11 x64**.
  (Developed/typechecked on Linux in this project — see `PROGRESS.md` for exactly what could
  and couldn't be run/verified on each real OS.)
- **Node.js 18+** and npm.
- **Google Chrome** already installed (Dragon controls your existing install, not a managed
  browser).
- A **Deepgram** API key: https://console.deepgram.com/ (Flux streaming STT).
- An **OpenRouter** API key with access to System One models: https://openrouter.ai/settings/keys
  (used to call Jev via `POST https://openrouter.ai/api/v1/systemone`).

## Install and run (development)

```bash
git clone <this repo>
cd dragon
npm install
npm run build      # tsc for main/preload + renderer
npm start           # builds then launches `electron .`
```

Works the same way on macOS and Windows — `npm run dev` is an alias for `npm start`. There is
no bundler: main-process/preload TypeScript compiles to `dist/`, renderer TypeScript
(settings/overlay/mic-capture windows) compiles to `dist-renderer/` and is loaded via plain
`<script>` tags from `src/renderer/*.html`. `npm run clean` (used by `npm run build`) uses a
small cross-platform Node script (`scripts/clean.js`), not a shell `rm -rf`.

On first launch:

1. Your OS will prompt for **microphone access** the first time Dragon starts capturing
   audio — allow it. On Windows, also check **Settings → Privacy & security → Microphone →
   Let desktop apps access your microphone** is on.
2. **macOS only:** the first `osascript`/System Events call (app switching, keystrokes,
   window control) will trigger a macOS **Accessibility** permission prompt for Dragon (or
   for your terminal, if running via `npm start` in a dev shell). Go to **System Settings →
   Privacy & Security → Accessibility** and enable it if macOS doesn't prompt automatically.
   Windows has no equivalent permission gate for the `User32`/PowerShell approach Dragon uses.
3. Open the tray icon (menu bar on macOS, system tray on Windows) → **Open Settings…** and
   paste your OpenRouter and Deepgram API keys. Click **Save**. Keys are stored in the
   Electron `userData` directory's `settings.json` (see "Logs and troubleshooting" below for
   the exact path per OS) and are never logged.

## Loading the Chrome extension

DOM-level browser actions (click/type/select/scroll/tabs, and reusing an existing tab for a
site you already have open) need the unpacked extension. Chrome navigation/search on a *new*
tab alone (`open Chrome and go to ...`, `search for ...`) works without it.

1. In Chrome, go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this repo's `chrome-extension/` folder.
4. Make sure Dragon (the desktop app) is already running — the extension's background service
   worker connects to `ws://127.0.0.1:17872` and retries every 2 seconds if the app isn't up
   yet, plus a `chrome.alarms` keepalive every 30 seconds so it survives Manifest V3's
   background-worker eviction.
5. Confirm the connection: check the JSONL log for a `browser.extension_connected` event, or
   just try a click/scroll voice command.

## Required permissions

### macOS

| Permission | Why | Where to grant |
|---|---|---|
| Microphone | Capture audio for Deepgram streaming STT | Prompted automatically; also System Settings → Privacy & Security → Microphone |
| Accessibility | `osascript`/System Events app switching, keystrokes, window control | System Settings → Privacy & Security → Accessibility |
| Automation (may prompt per-app) | AppleScript talking to Music/Spotify/System Events/Finder | Prompted the first time each target app is scripted |

### Windows

| Permission | Why | Where to grant |
|---|---|---|
| Microphone | Capture audio for Deepgram streaming STT | Settings → Privacy & security → Microphone → allow desktop apps |

Windows has no Accessibility-style permission gate for the `User32`/PowerShell calls Dragon
uses — keystroke/window automation works as soon as the app runs, no separate grant needed.
An unsigned `.exe` will trigger **Windows SmartScreen** ("Windows protected your PC") on first
run — click **More info → Run anyway**. This is expected for an unsigned personal alpha build
and is not a bug.

## Settings reference

- **Decision provider** — `Jev via OpenRouter` (default) or `Laya via local server`. Both use the
  same closed decision questions; Laya is an external local process and does not use the OpenRouter
  key. Laya server settings are `http://127.0.0.1:8000` and model `laya` by default.
- **OpenRouter API key** / **Deepgram API key** — pasted, masked, never re-displayed once
  saved (Settings shows "saved" as a placeholder). Leave the field blank on Save to keep the
  existing key. The OpenRouter key is used only by the Jev provider.
- **Activation mode** — push to talk / always listening.
- **Push-to-talk shortcut** — **toggles** listening on/off (Electron has no global key-up
  event, so true press-and-hold isn't possible without a native helper; press once to start,
  press again to stop). Default `Alt+Space` on macOS, `Control+Alt+D` on Windows (macOS's
  default conflicts with a Windows system shortcut). If registration fails (already claimed
  by another app), Settings shows a warning banner — pick a different combination.
- **Emergency stop shortcut** — always active; aborts in-flight decisions, stops any spoken
  reply, stops streaming, and clears Insert/Workflow modes. Default `Alt+Escape` on macOS,
  `Control+Alt+Escape` on Windows.
- **Toggle Insert Mode shortcut** — default `Control+Alt+I`; toggles text-first dictation without
  starting or stopping the microphone.
- **Toggle Workflow Mode shortcut** — default `Control+Alt+Shift+W`; toggles a sequential
  one-step-per-utterance workflow session. A failed step ends the workflow.
- **Speak short replies** — toggles native spoken acknowledgements (`say` on macOS,
  `System.Speech.Synthesis.SpeechSynthesizer` via PowerShell on Windows).
- **Debug log verbosity** — `normal` skips noisy interim (`Update`) STT events; `verbose`
  includes them.

## Laya local provider

Laya is an optional local decision provider. It is not routed through OpenRouter and requires a
separate [laya-server](https://github.com/nvkudva/laya-server) process. Start the server first,
then select **Laya via local server** in Settings, save, and use **Test decision provider**.

The default local endpoint is `http://127.0.0.1:8000`; Dragon accepts only local HTTP Laya URLs.
The first Laya run downloads model weights and loads them into memory, so startup is much slower
than a normal Dragon launch. Laya is explicit opt-in: if its server is unavailable, Dragon reports
the provider error rather than silently falling back to Jev.

## Decision dashboard

With Dragon running, open:

```text
http://127.0.0.1:17873/dashboard
```

The URL is also available from the tray menu or the **Open Dashboard** button in Settings. The
page is a clean, read-only view of the current Dragon session: it shows the transcript, active
application, selected provider/model, intent/target/direction, confidence, probability bars,
closest alternative choices, latency from STT turn start through provider response, the resolved action,
execution outcome, and a compact recent-exceptions list. The bounded session data is exposed
read-only at
`http://127.0.0.1:17873/api/decisions`; restart Dragon to begin a new session. No API keys or
audio are sent to the dashboard.

## Running and stopping

- Dragon lives in the **menu bar** (macOS) / **system tray** (Windows) — no Dock/taskbar
  window. Click the tray icon for: listening on/off, activation-mode picker, show/hide
  overlay, open settings, open the decision dashboard, open logs folder, clear history, quit.
- Use **Quit Dragon** from the tray menu to exit (no main window to close).

## Packaging an unsigned local build

```bash
npm run package:mac   # macOS: electron-builder --mac --arm64 --dir
npm run package:win    # Windows: electron-builder --win portable --x64
```

**macOS**: produces an unsigned, non-notarized `release/mac-arm64/Dragon.app` (no dmg/zip —
just the `.app` bundle). Because macOS refuses to launch anything unsigned+quarantined by
default: right-click the `.app` → **Open** → confirm in the Gatekeeper dialog (first launch
only), or `xattr -dr com.apple.quarantine release/mac-arm64/Dragon.app` before double-clicking.

**Windows**: produces a single unsigned portable `release/Dragon 0.1.0.exe` — no installer, no
NSIS, nothing written outside where you put the file (per the plan: portable first, NSIS is
optional and not built here). Double-click to run; accept the SmartScreen prompt (see above).

Both were run and produced valid, correctly-structured packages from the Linux machine used to
build this alpha (see `PROGRESS.md` for exactly what that does and doesn't prove — neither
package has been run on its actual target OS/architecture yet). macOS came out as `darwin-x64`
(that host's architecture) rather than `arm64`; re-run `package:mac` on a real Apple Silicon
Mac to get a genuine arm64 build.

## Manual alpha check

### macOS check

Do this on a real Mac after pasting real API keys:

1. Launch the app (`npm start`, or the packaged `.app`), paste OpenRouter and Deepgram keys in
   Settings.
2. Grant microphone and Accessibility permissions when prompted.
3. Load the unpacked Chrome extension (above) and confirm it connects.
4. Say **"Open Notepad"** → TextEdit should open.
5. Say **"Type hello from Dragon"** with a text field focused → the exact text should appear.
   Then, without saying "type" again, say a follow-up sentence — it should keep typing. Say
   **"delete the last 2 words"**, **"new line"**, and **"replace hello with hi"** and confirm
   each edits the text correctly. Say **"stop dictation"**.
6. In Chrome: say **"search for &lt;something&gt;"**, then **"click"** a visible result's
   label, **"scroll down"**, **"open a new tab"**, **"switch to the previous tab"**. Say
   **"open youtube music"** then **"search for &lt;a song&gt;"** and confirm it searches
   YouTube Music, not Google.
7. Say **"turn the volume up"**, **"set volume to 30"**, **"mute the volume"**.
8. Repeat one command in each activation mode (push-to-talk and always listening).
9. Open the JSONL log and confirm you can see the transcript, the Jev decision
   (intent/target/direction/confidence), the executed command, latency breakdown, and any
   error — with no API keys or raw audio present.

### Windows 11 check

Do this on a real Windows 11 x64 machine (**unverified by this alpha's author** — expect to
find and fix real bugs; see PROGRESS.md's "Exact next task" for the most likely trouble spots):

1. Launch the portable `.exe` (or `npm start` from a dev checkout), accept the SmartScreen
   prompt, paste OpenRouter and Deepgram keys in Settings.
2. Confirm Windows microphone privacy allows desktop apps and that a transcript appears.
3. Load the same unpacked Chrome extension and confirm the localhost bridge connects.
4. Say **"Open Notepad"** → Windows Notepad should open.
5. Say **"Type hello from Dragon"** → the exact text should appear. Try the same
   dictation/editing follow-ups as the macOS check (continue typing without saying "type"
   again, "delete the last 2 words", "new line", "replace X with Y", "stop dictation").
6. Exercise copy, paste, undo, save, Enter, Escape, Tab, and arrow-key commands.
7. Minimize, maximize, and close a normal non-elevated application window.
8. Open Chrome, search for a phrase, click a visible result, scroll, and switch tabs.
9. Change/mute volume ("volume up"/"volume down"/"mute") and try a media command. Note: exact
   "set volume to N%" is not implemented on Windows yet (see PROGRESS.md) — expect a clear
   spoken/logged error, not silent failure. Note: "mute" and "unmute" both just toggle.
10. Open Windows Settings and a File Explorer standard location (e.g. "open downloads").
11. Repeat a direct command in each activation mode and confirm voice replies can be
    interrupted by starting to speak again.
12. Inspect the JSONL log for transcript, Jev decision, selected platform, execution latency,
    result, and errors without secret values.

## Logs and troubleshooting

- **Logs**: `<userData>/logs/dragon-YYYY-MM-DD.jsonl` (one JSON object per line; rotated
  daily). Open via tray → **Open Logs Folder**. `<userData>` is
  `~/Library/Application Support/Dragon` on macOS and `%APPDATA%\Dragon` on Windows.
- **Settings/history**: `<userData>/settings.json`, `<userData>/history.json`.
- "Chrome extension is not connected" errors on click/type/select/scroll/tab commands → make
  sure the unpacked extension is loaded and Dragon is running; check for
  `browser.extension_connected` in the logs. `chrome_open_url`/`chrome_search` still work
  without it (just won't reuse an existing tab).
- The extension's console shows `WebSocket connection to 'ws://127.0.0.1:17872/' failed:
  ERR_CONNECTION_REFUSED` → Dragon's local bridge server never bound to that port at all,
  most commonly because **another Dragon process is already running** and holding it (e.g.
  you ran `npm start` twice, or launched the packaged app while a dev instance was still up).
  Dragon only allows one running instance — launching a second one just focuses Settings on
  the first and quits, so this shouldn't happen anymore, but if you still see it: quit Dragon
  fully (check Activity Monitor/Task Manager for a leftover process) and relaunch. Settings
  also shows a warning banner (and the log has a `browser.server_bind_failed` event with the
  exact reason) whenever this happens.
- No transcripts appearing → check `stt.connected` / `stt.socket_error` / `stt.fatal_error`
  events in the logs; usually a bad/missing Deepgram key or no microphone permission.
- Jev/decision errors → check `pipeline.decision_failed` / `jev.response` events; usually a
  bad/missing OpenRouter key, no System One access on the key, or a network issue.
- Nothing happens when you speak → check `pipeline.ignored` events (`reason`: `not_addressed`
  in always-listening mode, or `low_confidence_or_incomplete`/`resolution_failed` otherwise).
- A global shortcut doesn't seem to do anything → open Settings; a warning banner appears if
  registration failed (another app already claimed that combination). Pick a different one.
- **macOS**: `osascript ... "not allowed to send keystrokes"` errors → grant Accessibility
  permission (System Settings → Privacy & Security → Accessibility) to Dragon or your
  terminal, then try again. Dragon now surfaces this as a plain-English message.
- **Windows**: "not supported on Windows yet" for exact volume percentage, or unmute
  re-muting → known, documented parity gaps (see PROGRESS.md), not bugs.

## Repository layout

```
src/
  main/        Electron main process: tray, windows, settings/history stores, shortcuts,
               IPC, the local Jev dashboard server, and the pipeline orchestrator
               (activation modes, cancellation, dedup, dictation session state)
  preload/     contextBridge preload scripts for the three renderer windows
  renderer/    settings/overlay/mic-capture/dashboard windows — plain TS→JS, no bundler
  stt/         Deepgram Flux WebSocket client
  decision/    Jev question-building, OpenRouter client, deterministic payload extraction,
               and Jev-answer → executable-command resolution
  commands/    Closed vocabularies: registry-common.ts (platform-neutral names/templates),
               registry-macos.ts / registry-windows.ts (per-OS values), registry.ts
               (platform selector, validates coverage at startup)
  automation/  types.ts (the `PlatformAutomation` interface), index.ts (platform selector),
               macos.ts (open/osascript/say), windows.ts (PowerShell + inline C# User32)
  browser/     Localhost WebSocket bridge server for the Chrome extension
  logging/     JSONL structured logger with key/audio redaction
  types/       Shared types
chrome-extension/   Unpacked Manifest V3 extension (background service worker + content
                     script) — pure JS, identical on both OSes
scripts/            Cross-platform clean script, icon generation (PNG + a hand-built .ico)
assets/             Generated icons (mac tray/app icon, Windows tray icon + .ico)
```
