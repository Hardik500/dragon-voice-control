import { clipboard } from "electron";
import { execFile, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { APP_ALIASES, KEY_SPECS, LOCATIONS, SETTINGS_PANES, WinAppAlias } from "../commands/registry-windows";
import { logger } from "../logging/logger";

/**
 * All Windows execution goes through PowerShell (per-action processes, per DECISIONS.md) with
 * a small inline C# User32 P/Invoke helper for foreground-window discovery/activation,
 * minimize/maximize/close, and virtual-key injection. `keybd_event` (not the newer `SendInput`)
 * is used deliberately: its signature is simple enough to get right without a Windows machine
 * to test against, at the cost of being a legacy (but still fully supported) API.
 *
 * IMPORTANT: this entire module is unverified on real Windows hardware — see PROGRESS.md.
 */

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${err.message} ${stderr ?? ""}`.trim()));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function runPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

/** Doubles embedded single quotes for a PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Inline User32 P/Invoke helper, prepended to any script that needs it. Safe to repeat: each
 * action runs in its own fresh `powershell.exe` process (no `Add-Type` collision risk). */
const WIN32_TYPE = `Add-Type -Namespace Dragon -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@`;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const WM_CLOSE = 0x0010;

const VK = {
  CONTROL: 0x11,
  ALT: 0x12,
  SHIFT: 0x10,
  WIN: 0x5b,
  TAB: 0x09,
  BACK: 0x08,
  F11: 0x7a,
  VOLUME_MUTE: 0xad,
  VOLUME_DOWN: 0xae,
  VOLUME_UP: 0xaf,
  MEDIA_NEXT: 0xb0,
  MEDIA_PREV: 0xb1,
  MEDIA_PLAY_PAUSE: 0xb3,
};

function keyEventLine(vk: number, up: boolean, extended = false): string {
  const flags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  return `[Dragon.Win32]::keybd_event(${vk}, 0, ${flags}, [UIntPtr]::Zero)`;
}

function tapKeyScript(vk: number, extended = false): string {
  return [WIN32_TYPE, keyEventLine(vk, false, extended), keyEventLine(vk, true, extended)].join("\n");
}

/** Voice alias keys (e.g. "chrome") are resolved to launch tokens/process names here, using
 * this platform's own registry — shared code never sees these representations. */
function resolveAlias(aliasKey: string): WinAppAlias {
  const found = APP_ALIASES[aliasKey.toLowerCase()];
  if (found) return found;
  return { launchToken: aliasKey, processName: aliasKey, label: aliasKey };
}

function findChromeExe(): string | null {
  const candidates = [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["LocalAppData"] && path.join(process.env["LocalAppData"], "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function startProcess(token: string, args: string[] = []): Promise<void> {
  // Mirrors Win+R / `start` resolution: PATH, the "App Paths" registry (how most installers
  // register their app for exactly this purpose), or a URI (ms-settings:, https://, etc.).
  await run("cmd.exe", ["/c", "start", "", token, ...args]);
}

export async function openApp(aliasKey: string): Promise<void> {
  const alias = resolveAlias(aliasKey);
  if (alias.processName.toLowerCase() === "chrome") {
    const exe = findChromeExe();
    if (exe) {
      await run(exe, []);
      return;
    }
  }
  await startProcess(alias.launchToken);
}

export async function activateApp(aliasKey: string): Promise<void> {
  const alias = resolveAlias(aliasKey);
  const script = `${WIN32_TYPE}
$procs = Get-Process -Name '${psQuote(alias.processName)}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if ($procs) {
  $h = $procs[0].MainWindowHandle
  [Dragon.Win32]::ShowWindow($h, ${SW_RESTORE})
  [Dragon.Win32]::SetForegroundWindow($h)
} else {
  Start-Process '${psQuote(alias.launchToken)}'
}`;
  await runPowerShell(script);
}

export async function hideApp(aliasKey: string): Promise<void> {
  const alias = resolveAlias(aliasKey);
  const script = `${WIN32_TYPE}
$procs = Get-Process -Name '${psQuote(alias.processName)}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if ($procs) { [Dragon.Win32]::ShowWindow($procs[0].MainWindowHandle, ${SW_MINIMIZE}) }`;
  await runPowerShell(script);
}

export async function quitApp(aliasKey: string): Promise<void> {
  const alias = resolveAlias(aliasKey);
  const script = `$procs = Get-Process -Name '${psQuote(alias.processName)}' -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  if (-not $p.CloseMainWindow()) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}`;
  await runPowerShell(script);
}

export async function switchToPreviousApp(): Promise<void> {
  // Alt+Tab: hold Alt, tap Tab, wait, then release Alt — this is the well-documented reliable
  // way to actually invoke the task switcher (a plain "send Alt+Tab" often doesn't register).
  const script = [
    WIN32_TYPE,
    keyEventLine(VK.ALT, false),
    keyEventLine(VK.TAB, false),
    keyEventLine(VK.TAB, true),
    "Start-Sleep -Milliseconds 150",
    keyEventLine(VK.ALT, true),
  ].join("\n");
  await runPowerShell(script);
}

export async function typeText(text: string): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);
  try {
    const script = [WIN32_TYPE, keyEventLine(VK.CONTROL, false), keyEventLine("V".charCodeAt(0), false), keyEventLine("V".charCodeAt(0), true), keyEventLine(VK.CONTROL, true)].join("\n");
    await runPowerShell(script);
  } finally {
    setTimeout(() => {
      try {
        clipboard.writeText(previous);
      } catch (err) {
        logger.error("automation.clipboard_restore", err);
      }
    }, 400);
  }
}

function modifierVk(mod: string): number {
  switch (mod) {
    case "ctrl":
      return VK.CONTROL;
    case "alt":
      return VK.ALT;
    case "shift":
      return VK.SHIFT;
    case "win":
      return VK.WIN;
    default:
      throw new Error(`Unknown modifier: ${mod}`);
  }
}

export async function pressNamedKey(keyName: string): Promise<void> {
  const spec = KEY_SPECS[keyName];
  if (!spec) throw new Error(`Unknown key phrase: ${keyName}`);
  const vk = spec.vk ?? (spec.char ? spec.char.toUpperCase().charCodeAt(0) : null);
  if (vk == null) throw new Error(`Key phrase has no vk/char: ${keyName}`);
  const modVks = spec.modifiers.map(modifierVk);
  const lines = [WIN32_TYPE];
  for (const m of modVks) lines.push(keyEventLine(m, false));
  lines.push(keyEventLine(vk, false));
  lines.push(keyEventLine(vk, true));
  for (const m of [...modVks].reverse()) lines.push(keyEventLine(m, true));
  await runPowerShell(lines.join("\n"));
}

/** Presses plain Backspace `count` times in one PowerShell call. */
export async function deleteBackward(count: number): Promise<void> {
  const n = Math.max(0, Math.round(count));
  if (n === 0) return;
  const lines = [WIN32_TYPE];
  for (let i = 0; i < n; i++) {
    lines.push(keyEventLine(VK.BACK, false));
    lines.push(keyEventLine(VK.BACK, true));
  }
  await runPowerShell(lines.join("\n"));
}

export async function windowMinimize(): Promise<void> {
  await runPowerShell(`${WIN32_TYPE}\n$h=[Dragon.Win32]::GetForegroundWindow(); [Dragon.Win32]::ShowWindow($h, ${SW_MINIMIZE})`);
}

export async function windowMaximize(): Promise<void> {
  await runPowerShell(`${WIN32_TYPE}\n$h=[Dragon.Win32]::GetForegroundWindow(); [Dragon.Win32]::ShowWindow($h, ${SW_MAXIMIZE})`);
}

export async function windowFullscreen(): Promise<void> {
  // No universal Windows "fullscreen toggle"; F11 is the closest widely-supported convention
  // (browsers, VS Code, most media players) — same style of approximation as macOS's
  // maximize-as-fullscreen simplification. See DECISIONS.md.
  await runPowerShell(tapKeyScript(VK.F11));
}

export async function windowClose(): Promise<void> {
  await runPowerShell(`${WIN32_TYPE}\n$h=[Dragon.Win32]::GetForegroundWindow(); [Dragon.Win32]::PostMessage($h, ${WM_CLOSE}, [IntPtr]::Zero, [IntPtr]::Zero)`);
}

export async function volumeUp(): Promise<void> {
  await runPowerShell(tapKeyScript(VK.VOLUME_UP, true));
}

export async function volumeDown(): Promise<void> {
  await runPowerShell(tapKeyScript(VK.VOLUME_DOWN, true));
}

export async function volumeSet(_percent: number): Promise<void> {
  // Deferred per DECISIONS.md/PROGRESS.md: exact volume percentage needs Core Audio COM
  // interop (IAudioEndpointVolume), which is easy to get subtly wrong without a Windows
  // machine to test against. Ship up/down/mute first, as the plan explicitly allows.
  throw new Error(
    "Setting an exact volume percentage isn't supported on Windows yet in this alpha. Try \"volume up\"/\"volume down\" instead."
  );
}

export async function volumeMute(): Promise<void> {
  // Windows only exposes a single mute *toggle* key, not separate set-true/set-false, without
  // Core Audio COM interop (deferred, same as volumeSet). This will unmute if already muted.
  logger.event("automation.windows_mute_is_toggle", {});
  await runPowerShell(tapKeyScript(VK.VOLUME_MUTE, true));
}

export async function volumeUnmute(): Promise<void> {
  logger.event("automation.windows_mute_is_toggle", {});
  await runPowerShell(tapKeyScript(VK.VOLUME_MUTE, true));
}

export async function mediaPlayPause(): Promise<void> {
  await runPowerShell(tapKeyScript(VK.MEDIA_PLAY_PAUSE, true));
}

export async function mediaNext(): Promise<void> {
  await runPowerShell(tapKeyScript(VK.MEDIA_NEXT, true));
}

export async function mediaPrevious(): Promise<void> {
  await runPowerShell(tapKeyScript(VK.MEDIA_PREV, true));
}

export async function openSettingsPane(pane: string): Promise<void> {
  const uri = SETTINGS_PANES[pane];
  if (!uri) throw new Error(`Unknown settings pane: ${pane}`);
  await startProcess(uri);
}

export async function openFinderLocation(location: string): Promise<void> {
  const rel = LOCATIONS[location];
  if (rel == null) throw new Error(`Unknown File Explorer location: ${location}`);
  const target = rel.startsWith("shell:") ? rel : path.join(process.env.USERPROFILE ?? "", rel);
  // Explorer is a shell process and may return a non-zero status after successfully
  // opening the requested folder. Use the same shell-start path as app launching and treat
  // cmd's successful handoff as the operation's result instead of misreporting explorer.exe.
  await startProcess(target);
}

let currentSay: ChildProcess | null = null;

/** Speaks a short acknowledgement via System.Speech. Interrupts any reply already speaking. */
export function say(text: string): void {
  stopSpeaking();
  try {
    const script = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.Speak('${psQuote(text)}')`;
    currentSay = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
    currentSay.on("exit", () => {
      currentSay = null;
    });
  } catch (err) {
    logger.error("automation.say_failed", err);
  }
}

/** Barge-in support: stop any in-progress spoken reply immediately. */
export function stopSpeaking(): void {
  if (currentSay) {
    try {
      currentSay.kill();
    } catch {
      /* ignore */
    }
    currentSay = null;
  }
}

export async function openUrlInChrome(url: string): Promise<void> {
  const exe = findChromeExe();
  if (exe) {
    await run(exe, [url]);
    return;
  }
  try {
    await run("cmd.exe", ["/c", "start", "chrome", url]);
  } catch (err) {
    logger.error("automation.chrome_not_found_fallback_default_browser", err);
    await run("cmd.exe", ["/c", "start", "", url]);
  }
}

export async function getActiveAppName(): Promise<string | null> {
  const script = `${WIN32_TYPE}
$h = [Dragon.Win32]::GetForegroundWindow()
$procId = 0
[void][Dragon.Win32]::GetWindowThreadProcessId($h, [ref]$procId)
if ($procId -ne 0) {
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $desc = $null
    try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch {}
    if ($desc) { Write-Output $desc } else { Write-Output $p.ProcessName }
  } catch {}
}`;
  try {
    const { stdout } = await runPowerShell(script);
    const name = stdout.trim();
    return name || null;
  } catch (err) {
    logger.error("automation.get_active_app", err);
    return null;
  }
}
