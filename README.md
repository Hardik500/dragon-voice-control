# Dragon

A voice-control agent for macOS and Windows. Say *"open Notepad"*, *"search for X"*, *"scroll
down"*, *"delete the last 3 words"* — Dragon does it, and shows you its reasoning as it decides.

> **Personal alpha.** Unsigned, no automated tests, no confirmation prompts, and deliberately
> conservative about what it will do on its own. See [Known limitations](#known-limitations).

## Demo

Sixty seconds, no cuts: launching an app and bringing it to the front, dictating a paragraph into
Notepad, then driving Chrome.

[![Watch the Dragon demo](https://www.loom.com/v1/videos/129c880fd1a34c21be42fc4e95d53934/thumbnail.gif)](https://www.loom.com/share/129c880fd1a34c21be42fc4e95d53934)

## Screenshots

### Decision dashboard

Every command, with the reasoning left visible: the transcript, the selected intent and target,
their confidence, the runner-up choices, and the latency split between STT, the decision request,
and execution. Served locally at `http://127.0.0.1:17873/dashboard` while Dragon is running.

<img width="1471" height="958" alt="The Dragon decision dashboard: a transcript, the chosen intent and target with confidence bars and alternatives, and a latency breakdown" src="https://github.com/user-attachments/assets/3b7e8c47-cc8a-40d7-b6fe-4fb3b0d335c4" />

## What it does

Every phrase below is a real command — not a paraphrase. Punctuation is optional.

### Apps and windows

| Say | Result |
|---|---|
| `open notepad` / `launch cursor` / `start terminal` | Launch **and focus** the app |
| `open google chrome` | Focus Chrome — not navigate to google.com |
| `minimize window` · `maximize window` · `close window` | Control the focused window |
| `hide slack` · `quit notepad` | Hide or close a specific app |
| `switch to the previous app` | Alt+Tab |
| `open settings` · `open the sound settings` | Jump to a Settings pane |
| `open downloads` · `go to documents` | Open a File Explorer / Finder location |

### Text and dictation

| Say | Result |
|---|---|
| `start typing` (or `start dictation`, `insert mode`, `start writing`) | Enter **Insert Mode** |
| *anything you say* | Typed verbatim into the focused app |
| `new line` | Newline |
| `delete the last 3 words` (default 3) | Backspace exactly N words of what Dragon typed |
| `delete that` · `delete everything` | Undo the last dictation · clear the field |
| `replace X with Y` | Edit the text Dragon just wrote |
| `stop typing` (or `done`, `that's it`, `exit insert mode`) | Leave Insert Mode |

Insert Mode is **text-first**: app and browser commands are typed as text until you leave it.
Key presses and shortcuts still work while you're in it. Deletions are computed from an exact
record of what Dragon typed — it never reads the contents of the app you're in.

### Chrome

| Say | Result |
|---|---|
| `open reddit dot com` | Navigate (speaks domains as "dot com") |
| `search for cats` (in Chrome) | Search — using the current site's own search if it has one (YouTube, GitHub, …), else Google |
| `click on the first post` | Click a visible element by its label |
| `scroll down` · `back` · `forward` · `reload` | Page control |
| `new tab` · `close tab` · `switch to the previous tab` | Tab control |
| `search for cats` (in Slack, Notion, VS Code, …) | That app's own Cmd/Ctrl+K quick-open |

Navigation and search work without the extension. Clicking, typing, scrolling, and tabs need it.

### System and media

| Say | Result |
|---|---|
| `volume up` · `volume down` · `mute` | System volume |
| `pause` · `next track` · `previous track` | Media keys |
| `press enter` · `escape` · `tab` · `arrow down` | Any named key |
| `copy` · `paste` · `undo` · `save` · `select all` | Common shortcuts |
| `control c` | Literal key combos |

Numbers come through as digits, so `type my number is 5551234` types the digits, not the words.

## Quick start

**System**: macOS or **Windows 11 x64** · Node.js 18+ · Chrome already installed (Dragon drives
*your* Chrome, not a managed one).

**Two API keys.** Both have free tiers, and you paste them into the app — there is no `.env`
file and nothing to configure before it runs.

| Key | Used for | Get one |
|---|---|---|
| **Deepgram** | Speech-to-text | [console.deepgram.com](https://console.deepgram.com/) |
| **OpenRouter** | The decision model. Needs a key with **System One** access | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |

```bash
git clone <this repo> && cd dragon
npm install
npm start          # builds, then launches Electron
```

First launch:

1. **Allow microphone access** when prompted. On Windows also check *Settings → Privacy &
   security → Microphone → Let desktop apps access your microphone*.
2. **macOS only:** the first app-switching or keystroke command triggers an **Accessibility**
   prompt. Grant it under *System Settings → Privacy & Security → Accessibility*, or to your
   terminal if you're running from a dev shell. Windows has no equivalent gate.
3. Click the tray icon (menu bar / system tray) → **Open Settings…** and paste the two keys.
   They're saved to Electron's `userData` and never logged. If the OpenRouter key lacks System
   One access, commands will fail with a decision error — check the log for
   `pipeline.decision_failed`.

### Load the Chrome extension

Needed for click, type, scroll, and tab commands:

1. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick this
   repo's `chrome-extension/` folder.
2. Start Dragon *first* — the extension connects to `ws://127.0.0.1:17872` and retries until it is.
3. Confirm by looking for `browser.extension_connected` in the log, or just try `scroll down`.

> **After editing anything in `chrome-extension/`, press Reload on that page.** An unpacked
> extension won't pick up changes otherwise, and the failure looks like "the extension isn't
> loaded" rather than "it's running stale code".

## Modes and shortcuts

| Shortcut | Action |
|---|---|
| `Control+Alt+D` (`Alt+Space` on macOS) | Toggle listening (push-to-talk **toggles** — press again to stop) |
| `Control+Alt+I` | Toggle Insert Mode without touching the mic |
| `Control+Alt+Shift+W` | Toggle Workflow Mode — one sequential step per utterance |
| `Control+Alt+Escape` (`Alt+Escape` on macOS) | Emergency stop: abort anything in flight and clear modes |

**Activation mode** is either push-to-talk (above) or always-listening, which filters out speech
that wasn't addressed to Dragon. Push-to-talk is more predictable; always-listening is more
fluid. Workflow Mode takes constrained multi-step phrases — *"open Notepad, then open Chrome,
then open Cursor"* — but is not a general planner.

## How it works

```
speech → Deepgram Flux STT → decision layer (Jev via OpenRouter) → resolve → OS automation
```

The **decision layer** is the interesting part. Dragon extracts everything deterministic in code
— app aliases, URLs, key names, numbers, the transcript itself — and the model only ever *picks*
from those candidates. It never invents a string to type or a window to click. Narrow,
deliberately boring regex overrides handle the handful of patterns a general model reliably
muddles (notably: *"open google chrome"* must focus Chrome, not navigate to google.com).

- **Decision provider** is Jev by default. An optional **Laya** local server is supported for
  running without OpenRouter. It's off by default and Dragon never starts it for you — install it
  with `scripts/bootstrap-laya-server.sh` (macOS/Linux) or `.ps1` (Windows), then enable it in
  Settings and press **Start Laya server**. See [`DECISIONS.md`](DECISIONS.md) for the rationale.
- **The decision dashboard** shows each decision live — see [Screenshots](#screenshots).

```
src/main/        Pipeline, tray, windows, shortcuts, IPC, dashboard server
src/stt/         Deepgram Flux WebSocket client
src/decision/    Candidate extraction, question building, answer → executable command
src/commands/    Closed vocabularies, split into common / per-OS / platform selector
src/automation/  Per-OS execution: AppleScript on macOS, PowerShell + User32 on Windows
src/browser/     Localhost WebSocket bridge for the Chrome extension
chrome-extension/  Unpacked MV3 extension — plain JS, identical on both OSes
```

Shared code never imports a platform file directly. `commands/registry.ts` picks the right one
and **throws at startup** if a name exists in the shared vocabulary but not on the running OS, so
a missing alias can't fail silently at runtime.

## Settings

| Setting | Notes |
|---|---|
| **Decision provider** | `Jev via OpenRouter` (default) or `Laya via local server` |
| **API keys** | Masked after saving; leave blank on Save to keep the existing key |
| **Activation mode** | Push to talk, or always listening |
| **Shortcuts** | PTT, emergency stop, Insert Mode, Workflow Mode — all rebindable |
| **Speak short replies** | Spoken acknowledgements (toggle off when recording) |
| **Debug log verbosity** | `normal` drops noisy interim STT events; `verbose` keeps them |

If a shortcut can't register — another app already owns that combination — Settings shows a
warning banner rather than failing quietly.

## Logs and troubleshooting

Logs are one JSON object per line, rotated daily, at `<userData>/logs/dragon-YYYY-MM-DD.jsonl`:

- macOS: `~/Library/Application Support/Dragon`
- Windows: `%APPDATA%\Dragon`

Open the folder from the tray (**Open Logs Folder**). Nothing sensitive is ever written — keys are
redacted and audio is never logged.

| Symptom | Look for |
|---|---|
| Nothing happens when I speak | `pipeline.ignored` — `reason` says whether it was `not_addressed`, `low_confidence_or_incomplete`, or `resolution_failed` |
| Click/scroll/tab commands fail | Extension not loaded, or not **Reloaded** after a code change. Look for `browser.extension_connected` |
| Extension can't connect | Another Dragon instance is already holding port 17872 — quit all of them |
| No transcripts at all | `stt.connected` / `stt.socket_error` — usually a bad Deepgram key or missing mic permission |
| Decision errors | `pipeline.decision_failed` — usually a bad OpenRouter key or no System One access |
| A shortcut does nothing | Settings will show a registration warning; pick another combination |
| Windows: "not supported on Windows yet" | Known parity gap for exact volume %. Use `volume up`/`down` |
| macOS: "not allowed to send keystrokes" | Grant Accessibility permission, then restart Dragon |

## Packaging an unsigned build

```bash
npm run package:mac   # release/mac-arm64/Dragon.app
npm run package:win   # release/Dragon 0.1.0.exe  (single portable file)
```

Both are unsigned. macOS: right-click the `.app` → **Open** on first launch to clear Gatekeeper
(or `xattr -dr com.apple.quarantine release/mac-arm64/Dragon.app`). Windows: accept the
**SmartScreen** prompt via *More info → Run anyway*. Neither package has been run on its target
OS yet — see `PROGRESS.md`.

## Known limitations

These are real and deliberate, not oversights:

- **One command per utterance.** "Open Slack, search for X, and type a message" is three
  commands, not one. Workflow Mode handles a constrained `then`-separated form and nothing more.
- **No confirmation prompts or deny-lists.** A recognised command executes. That's the design.
- **Spoken numbers can still be misheard** — keyterm prompting improves the common command words
  but doesn't eliminate it. "minimize" occasionally arrives as "many".
- **Windows: exact volume % and separate mute/unmute** aren't implemented; mute is a toggle.
- **Windows Store apps** (Calculator, Photos, Settings, …) host their windows under
  `ApplicationFrameHost`, so window targeting is less reliable than for classic Win32 apps.
- **A bare "2 + 2" isn't a command.** Prefix with `type` or use Insert Mode.
- **Insert Mode dictates commands as text** — leave it before saying "open Chrome".
- **No automated tests, no code signing, no notarization.**

`PROGRESS.md` tracks exactly what has been verified on real hardware and what hasn't — including
the parts of this README that are still aspirational on macOS.

## Project documents

| File | What it's for |
|---|---|
| [`PROGRESS.md`](PROGRESS.md) | What works, what's verified, what's next, known issues |
| [`DECISIONS.md`](DECISIONS.md) | Why each non-obvious choice was made, with the reasoning |
| [`AGENTS.md`](AGENTS.md) | Architecture rules and scope discipline for coding agents |

## License

Personal project, unlicensed and closed (`UNLICENSED` in `package.json`).
