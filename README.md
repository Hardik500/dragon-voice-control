# Dragon — macOS voice-control agent (personal alpha)

Dragon listens for spoken commands and controls macOS applications, text entry, system
volume/media, and your existing Chrome browser. It is a **personal alpha**: unsigned, no
automated tests, no guardrails/confirmation prompts, direct commands only (no multi-step
planning). See `PROGRESS.md` for exactly what has and hasn't been verified, and `DECISIONS.md`
for why things are built the way they are.

## What works

- Push-to-talk, wake-word ("Dragon"), and always-listening activation modes.
- Open/activate/hide/quit apps, switch to the previous app, type dictated text, press keys and
  shortcuts, control the active window, adjust/mute system volume, control media playback, open
  System Settings panes and Finder locations.
- Open Chrome and navigate/search (works without the extension); click a visible element, type
  into a field, select a dropdown option, scroll, go back/forward/reload, and open/close/switch
  tabs (requires the unpacked extension, see below).
- Floating overlay showing live transcript/state/action/latency, short spoken acknowledgements,
  and a persisted command history viewable from Settings.
- Structured JSONL debug logs (never containing API keys, Authorization headers, or raw audio).

## What it is not

No guardrails, confirmation prompts, or action deny-lists (by design — see the plan). No
automated tests. No Windows support. No code signing/notarization. No autonomous multi-step
planning — every command is direct and executes (at most) once.

## Prerequisites

- **macOS on Apple Silicon**, a recent release. (Developed/typechecked on Linux in this
  session — see `PROGRESS.md` for exactly what could and couldn't be run there.)
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

`npm run dev` is equivalent to `npm start` (kept as an alias in case you want a different flag
later). There is no bundler: main-process/preload TypeScript compiles to `dist/`, renderer
TypeScript (settings/overlay/mic-capture windows) compiles to `dist-renderer/` and is loaded via
plain `<script>` tags from `src/renderer/*.html`.

On first launch:

1. macOS will prompt for **microphone access** the first time Dragon starts capturing audio —
   allow it.
2. The **first** `osascript`/System Events call (app switching, keystrokes, window control)
   will trigger a macOS **Accessibility** permission prompt for Dragon (or for your terminal, if
   running via `npm start` in a dev shell). Go to **System Settings → Privacy & Security →
   Accessibility** and enable it if macOS doesn't prompt automatically.
3. Open the tray icon (menu bar) → **Open Settings…** and paste your OpenRouter and Deepgram
   API keys. Click **Save**. Keys are stored in `~/Library/Application Support/Dragon/
   settings.json` and are never logged.

## Loading the Chrome extension

DOM-level browser actions (click/type/select/scroll/tabs) need the unpacked extension. Chrome
navigation/search alone (`open Chrome and go to ...`, `search for ...`) works without it.

1. In Chrome, go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this repo's `chrome-extension/` folder.
4. Make sure Dragon (the desktop app) is already running — the extension's background service
   worker connects to `ws://127.0.0.1:17872` and retries every 2 seconds if the app isn't up
   yet.
5. Confirm the connection: check `userData/logs/dragon-*.jsonl` for a
   `browser.extension_connected` event, or just try a click/scroll voice command.

## Required macOS permissions

| Permission | Why | Where to grant |
|---|---|---|
| Microphone | Capture audio for Deepgram streaming STT | Prompted automatically; also System Settings → Privacy & Security → Microphone |
| Accessibility | `osascript`/System Events app switching, keystrokes, window control | System Settings → Privacy & Security → Accessibility |
| Automation (may prompt per-app) | AppleScript talking to Music/Spotify/System Events/Finder | Prompted the first time each target app is scripted |

## Settings reference

- **OpenRouter API key** / **Deepgram API key** — pasted, masked, never re-displayed once
  saved (Settings shows "saved" as a placeholder). Leave the field blank on Save to keep the
  existing key.
- **Activation mode** — push to talk / wake word / always listening.
- **Push-to-talk shortcut** (default `Alt+Space`) — **toggles** listening on/off. Electron has
  no global key-up event, so true press-and-hold isn't possible without a native helper (see
  `DECISIONS.md`); press once to start, press again to stop.
- **Emergency stop shortcut** (default `Alt+Escape`) — always active; aborts in-flight
  decisions, stops any spoken reply, and stops streaming.
- **Wake phrase** — default `Dragon`; case-insensitive; everything before and including the
  phrase is stripped before the remainder is treated as the command.
- **Speak short replies** — toggles native `say` acknowledgements.
- **Debug log verbosity** — `normal` skips noisy interim (`Update`) STT events; `verbose`
  includes them.

## Running and stopping

- Dragon lives in the **menu bar** (no Dock icon, no main window). Click the tray icon for:
  listening on/off, activation-mode picker, show/hide overlay, open settings, open logs folder,
  clear history, quit.
- `Cmd+Q` doesn't apply (no menu-bar-app main window); use **Quit Dragon** from the tray menu.

## Packaging an unsigned local build

```bash
npm run package:mac
```

Runs `electron-builder --mac --arm64 --dir`, producing an unsigned, non-notarized
`release/mac-arm64/Dragon.app` (no dmg/zip — just the `.app` bundle, per the plan's "unsigned
development builds" decision). Because macOS will refuse to launch anything unsigned+quarantined
by default, either:

- Right-click the `.app` → **Open** → confirm in the Gatekeeper dialog (first launch only), or
- `xattr -dr com.apple.quarantine release/mac-arm64/Dragon.app` before double-clicking.

This step was run and produced a valid unsigned bundle on the Linux machine used to build this
alpha (as `darwin-x64`, since that machine's native-module rebuild step used its host
architecture) — see `PROGRESS.md`. Re-run it on an Apple Silicon Mac to get a genuine arm64
build.

## Manual alpha check

Do this on a real Mac after pasting real API keys:

1. Launch the app (`npm start`, or the packaged `.app`), paste OpenRouter and Deepgram keys in
   Settings.
2. Grant microphone and Accessibility permissions when prompted.
3. Load the unpacked Chrome extension (above) and confirm it connects.
4. Say **"Open Notepad"** → TextEdit should open.
5. Say **"Type hello from Dragon"** with a text field focused → the exact text should appear.
6. In Chrome: say **"search for &lt;something&gt;"**, then **"click"** a visible result's
   label, **"scroll down"**, **"open a new tab"**, **"switch to the previous tab"**.
7. Say **"turn the volume up"**, **"set volume to 30"**, **"mute the volume"**.
8. Repeat one command in each activation mode (push-to-talk, wake word, always listening).
9. Open `~/Library/Application Support/Dragon/logs/dragon-<date>.jsonl` and confirm you can see
   the transcript, the Jev decision (intent/target/direction/confidence), the executed command,
   timing, and any error — with no API keys or raw audio present.

## Logs and troubleshooting

- Logs: `~/Library/Application Support/Dragon/logs/dragon-YYYY-MM-DD.jsonl` (one JSON object per
  line; rotated daily). Open via tray → **Open Logs Folder**.
- Settings/history: `~/Library/Application Support/Dragon/settings.json`,
  `~/Library/Application Support/Dragon/history.json`.
- "Chrome extension is not connected" errors on click/type/select/scroll/tab commands → make
  sure the unpacked extension is loaded and Dragon is running; check for
  `browser.extension_connected` in the logs.
- No transcripts appearing → check `stt.connected` / `stt.socket_error` / `stt.fatal_error`
  events in the logs; usually a bad/missing Deepgram key or no microphone permission.
- Jev/decision errors → check `pipeline.decision_failed` / `jev.response` events; usually a
  bad/missing OpenRouter key, no System One access on the key, or a network issue.
- Nothing happens when you speak → check `pipeline.ignored` events (`reason`: `not_addressed`
  in always-listening mode, or `low_confidence_or_incomplete`/`resolution_failed` otherwise).

## Repository layout

```
src/
  main/        Electron main process: tray, windows, settings/history stores, shortcuts,
               IPC, the pipeline orchestrator (activation modes, cancellation, dedup)
  preload/     contextBridge preload scripts for the three renderer windows
  renderer/    settings/overlay/mic-capture windows — plain TS→JS, no bundler
  stt/         Deepgram Flux WebSocket client
  decision/    Jev question-building, OpenRouter client, deterministic payload extraction,
               and Jev-answer → executable-command resolution
  commands/    Closed vocabularies: app aliases, key/shortcut table, settings panes,
               Finder locations, known websites
  automation/  macOS execution via `open`/`osascript`/`say`
  browser/     Localhost WebSocket bridge server for the Chrome extension
  logging/     JSONL structured logger with key/audio redaction
  types/       Shared types
chrome-extension/   Unpacked Manifest V3 extension (background service worker + content script)
scripts/            One-off asset generation (tray/app icons)
assets/             Generated icons
```
