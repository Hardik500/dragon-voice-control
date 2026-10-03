# Dragon

A voice-control agent for macOS and Windows. Say *"open Notepad"*, *"search for X"*, *"scroll
down"*, *"delete the last 3 words"* — Dragon does it, and shows you its reasoning as it decides.

> **Personal alpha.** Runs on **macOS and Windows** — both work, and both are equally expected to
> have bugs. Unsigned, no automated tests, no confirmation prompts, and deliberately conservative
> about what it will do on its own. See [Known limitations](#known-limitations).

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

### Click anything on screen (any app)

| Say | Result |
|---|---|
| `click on Bluetooth` · `click accessibility` · `click on sign in options` | Click the labelled element in the frontmost window of **any** app (Settings, WhatsApp, VS Code, …) |
| `click on chat` (several matches) | Dragon picks the best one, or shows a numbered list — say `1`…`5` within 15 seconds |

A literal "click X" is handled deterministically, without waiting on the model's confidence. How
the element is found depends on the **Screen click method** setting (default **Auto**): first the
OS accessibility tree — element *labels* from the frontmost window only, clicked at their exact
position, no screenshot — then, if nothing matches, a vision model on a screenshot of the
frontmost window only. Windows clicks are DPI-aware, and off-screen list items are scrolled into
view only when no match is already visible. macOS vision mode also needs **Screen Recording**
permission.

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
| `Control+Alt+Escape` (`Alt+Escape` on macOS) | Emergency stop: abort anything in flight and clear modes |

**Activation mode** is either push-to-talk (above) or always-listening, which filters out speech
that wasn't addressed to Dragon. Push-to-talk is more predictable; always-listening is more fluid.

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
  Settings and press **Start Laya server**. If the server is unavailable Dragon reports the
  failure rather than silently falling back to Jev, so you always know which model decided.
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
| **Screen click method** | `Auto` (default: accessibility, then vision), `Vision model`, or `Accessibility tree`. Only `Auto` falls back to vision on a miss |
| **Activation mode** | Push to talk, or always listening |
| **Shortcuts** | PTT, emergency stop, Insert Mode — all rebindable |
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

## Publishing a release

```bash
npm run release
```

One command, run once on each machine. It decides everything on its own: whether to cut a new
version or attach to the one already published, whether you're up to date, and what the release
notes say. There is no draft mode and nothing to promote by hand — a release is published the
moment the first machine creates it, and the other platform attaches whenever its machine runs
the same command.

It converges on a single version rather than forking one release per platform. A release *cycle* is
one version that both platforms join:

| Situation | What it does |
|---|---|
| Nothing published yet | Publishes a new release at the `package.json` version |
| Latest release has the other platform's build, nothing new committed | **Attaches** its build to that release, no new version |
| Latest release has your build, nothing new committed | Does nothing — you're up to date |
| Unreleased commits exist | **Bumps** the patch version and publishes a new release |
| A previous release is missing your build | Finishes that release instead of superseding it |

The signal for "is there unreleased work" is **commits since the latest tag**, not which artifacts
are attached. That's what makes re-running harmless: a second run with nothing new does nothing
instead of churning versions, and a single-platform repo bumps once and then settles.

It builds, verifies the artifact, commits the version bump, tags, and publishes via the GitHub CLI.
Optional flags, none of which you need for a normal release: `--dry-run` (print the plan and change
nothing), `--minor` / `--major` (bump style), `--force-new` (cut a version anyway),
`--notes-file NOTES.md` (override the default notes).

Both platforms now produce a single installable artifact directly, so nothing is zipped by hand.

## Installing

**Windows** — run `Dragon-<version>-x64-Setup.exe`. One click, installs into your user profile, and
**never asks for admin** — a UAC prompt stacked on the SmartScreen warning would be two trust asks
before an unsigned binary runs. You get a Start Menu entry, a desktop shortcut, and a proper
uninstaller under Add/Remove Programs.

**macOS** — open `Dragon-<version>-arm64.dmg` and drag Dragon into Applications, the way every Mac
app installs. Then right-click it → Open on first launch to clear Gatekeeper.

## Packaging an unsigned build

```bash
npm run package:win   # release/Dragon-<version>-x64-Setup.exe  (NSIS installer)
npm run package:mac   # release/Dragon-<version>-arm64.dmg      (disk image)
```

Both commands build the TypeScript, package it, then **verify the artifact actually landed**
— electron-builder can exit 0 and still leave you with something missing, truncated, or not
launchable, so the script checks the file, its size, and its format before reporting success. For
Windows it also checks `release\win-unpacked\Dragon.exe` exists, because the installer's own name
always ends in `.exe` no matter what happened to the executable inside it. For macOS it checks the
`koly` disk-image trailer, which is the closest thing to "is this really a dmg" that doesn't need
a Mac to mount it.

**Where to run them.** A Windows build needs a Windows or macOS host, or wine on Linux. A macOS
build **must** be made on a Mac: from Linux or Windows, electron-builder emits a bundle for the
*host's* CPU architecture rather than the configured one, so an "arm64" build on an x64 host
silently ships an x64 app that needs Rosetta. The script refuses that combination rather than
handing you a mislabelled artifact. Building a Linux target is deliberately not supported — the
app hard-errors off macOS and Windows.

Both builds are unsigned. macOS: right-click the `.app` → **Open** on first launch to clear
Gatekeeper (or `xattr -dr com.apple.quarantine <path>.app`). Windows: accept the **SmartScreen**
prompt via *More info → Run anyway*. Neither packaged build has been run on its target OS yet, so
verify it before telling anyone it works.

## Known limitations

These are real and deliberate, not oversights:

- **Both platforms work, and both will have bugs.** macOS and Windows are equally supported and
  equally "expect rough edges". Neither is exercised as heavily as the other — recent work has
  landed on Windows, and macOS was last re-run several commits earlier — so don't read a
  difference in maturity as a difference in support.
- **One command per utterance.** "Open Slack, search for X, and type a message" is three
  commands, not one. There is no natural-language planner that chains them for you.
- **No confirmation prompts or deny-lists.** A recognised command executes. That's the design.
- **Spoken words can still be misheard** — keyterm prompting improves the common command words
  but doesn't eliminate it. "minimize" occasionally arrives as "many" or "mini mice".
- **Windows: exact volume % and separate mute/unmute** aren't implemented; mute is a toggle.
- **Windows Store apps** (Calculator, Photos, Settings, WhatsApp, …) host their windows under
  `ApplicationFrameHost`. Dragon falls back to finding that window by title, which works for
  Settings and WhatsApp but is untested for other Store apps.
- **Screen click on Windows is new and lightly tested.** WebView2/Electron apps (WhatsApp)
  build their accessibility tree lazily, so list items such as contact names may not be found;
  use `Auto` so vision can take over. The latest Windows fixes (DPI scaling, scroll behaviour)
  have not been re-verified on a real machine yet.
- **Insert Mode dictates commands as text** — leave it before saying "open Chrome".
- **No automated tests, no code signing, no notarization.**

## License

Personal project, unlicensed and closed (`UNLICENSED` in `package.json`).
