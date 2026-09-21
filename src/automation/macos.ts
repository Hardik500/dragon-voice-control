import { clipboard } from "electron";
import { execFile, spawn, ChildProcess } from "child_process";
import { APP_ALIASES, KEY_SPECS, LOCATIONS, SETTINGS_PANES } from "../commands/registry-macos";
import { logger } from "../logging/logger";

/**
 * All macOS execution goes through `open` and `osascript`/System Events per
 * DECISIONS.md (no native Swift helper in the alpha).
 */

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(friendlyOsascriptError(`${cmd} failed: ${err.message} ${stderr ?? ""}`.trim())));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** osascript's Accessibility-permission errors are cryptic; surface a clear, actionable message. */
function friendlyOsascriptError(message: string): string {
  if (/not allowed to send keystrokes|1002|not allowed assistive access|-25211/i.test(message)) {
    return (
      "macOS blocked this because Dragon doesn't have Accessibility permission yet. " +
      "Open System Settings -> Privacy & Security -> Accessibility, enable Dragon " +
      "(or your terminal, in dev mode), then try again."
    );
  }
  return message;
}

function escapeAS(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function osascript(script: string): Promise<{ stdout: string; stderr: string }> {
  return run("osascript", ["-e", script]);
}

/** Voice alias keys (e.g. "chrome") are resolved to the real macOS app name here, using this
 * platform's own registry — shared code (extract.ts/resolve.ts) never sees the resolved name. */
function resolveAppName(aliasKeyOrName: string): string {
  return APP_ALIASES[aliasKeyOrName.toLowerCase()] ?? aliasKeyOrName;
}

export async function openApp(aliasKey: string): Promise<void> {
  await run("open", ["-a", resolveAppName(aliasKey)]);
}

export async function activateApp(aliasKey: string): Promise<void> {
  // `open -a` both launches (if needed) and brings the app to the foreground.
  await run("open", ["-a", resolveAppName(aliasKey)]);
}

export async function hideApp(aliasKey: string): Promise<void> {
  await osascript(
    `tell application "System Events" to set visible of application process "${escapeAS(resolveAppName(aliasKey))}" to false`
  );
}

export async function quitApp(aliasKey: string): Promise<void> {
  await osascript(`tell application "${escapeAS(resolveAppName(aliasKey))}" to quit`);
}

export async function switchToPreviousApp(): Promise<void> {
  await osascript('tell application "System Events" to key code 48 using {command down}');
}

export async function typeText(text: string): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);
  try {
    await osascript('tell application "System Events" to keystroke "v" using {command down}');
  } finally {
    // Restore the user's previous clipboard shortly after the paste completes.
    setTimeout(() => {
      try {
        clipboard.writeText(previous);
      } catch (err) {
        logger.error("automation.clipboard_restore", err);
      }
    }, 400);
  }
}

export async function pressNamedKey(keyName: string): Promise<void> {
  const spec = KEY_SPECS[keyName];
  if (!spec) throw new Error(`Unknown key phrase: ${keyName}`);
  const mods = spec.modifiers.length > 0 ? ` using {${spec.modifiers.join(", ")}}` : "";
  if (spec.keyCode != null) {
    await osascript(`tell application "System Events" to key code ${spec.keyCode}${mods}`);
  } else if (spec.character) {
    await osascript(`tell application "System Events" to keystroke "${escapeAS(spec.character)}"${mods}`);
  } else {
    throw new Error(`Key phrase has no keyCode or character: ${keyName}`);
  }
}

/** Presses plain Backspace `count` times in a single osascript call. */
export async function deleteBackward(count: number): Promise<void> {
  const n = Math.max(0, Math.round(count));
  if (n === 0) return;
  await osascript(
    `tell application "System Events"\n  repeat ${n} times\n    key code 51\n  end repeat\nend tell`
  );
}

export async function windowMinimize(): Promise<void> {
  await osascript('tell application "System Events" to keystroke "m" using {command down}');
}

export async function windowClose(): Promise<void> {
  await osascript('tell application "System Events" to keystroke "w" using {command down}');
}

export async function windowFullscreen(): Promise<void> {
  await osascript('tell application "System Events" to keystroke "f" using {command down, control down}');
}

export async function windowMaximize(): Promise<void> {
  // macOS has no single universal "maximize" shortcut; the alpha treats it
  // the same as fullscreen toggle. See DECISIONS.md.
  await windowFullscreen();
}

export async function volumeUp(): Promise<void> {
  await osascript(
    'set current to output volume of (get volume settings)\nset newVol to current + 10\nif newVol > 100 then set newVol to 100\nset volume output volume newVol'
  );
}

export async function volumeDown(): Promise<void> {
  await osascript(
    'set current to output volume of (get volume settings)\nset newVol to current - 10\nif newVol < 0 then set newVol to 0\nset volume output volume newVol'
  );
}

export async function volumeSet(percent: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  await osascript(`set volume output volume ${clamped}`);
}

export async function volumeMute(): Promise<void> {
  await osascript("set volume with output muted");
}

export async function volumeUnmute(): Promise<void> {
  await osascript("set volume without output muted");
}

async function isAppRunning(appName: string): Promise<boolean> {
  // Plain `pgrep`, not System Events, so this works even before the user has
  // granted Accessibility permission (which media commands otherwise don't need at all).
  try {
    await run("pgrep", ["-x", appName]);
    return true;
  } catch {
    return false;
  }
}

async function mediaCommand(verb: "playpause" | "next track" | "previous track"): Promise<void> {
  for (const app of ["Spotify", "Music"]) {
    if (await isAppRunning(app)) {
      await osascript(`tell application "${app}" to ${verb}`);
      return;
    }
  }
  // Neither a known player is running; log and no-op rather than guessing.
  logger.event("automation.media_no_player", { verb });
}

export async function mediaPlayPause(): Promise<void> {
  await mediaCommand("playpause");
}

export async function mediaNext(): Promise<void> {
  await mediaCommand("next track");
}

export async function mediaPrevious(): Promise<void> {
  await mediaCommand("previous track");
}

export async function openSettingsPane(pane: string): Promise<void> {
  const id = SETTINGS_PANES[pane];
  if (!id) throw new Error(`Unknown settings pane: ${pane}`);
  try {
    await run("open", [`x-apple.systempreferences:${id}`]);
  } catch {
    await run("open", ["-a", "System Settings"]);
  }
}

export async function openFinderLocation(location: string): Promise<void> {
  const rel = LOCATIONS[location];
  if (rel == null) throw new Error(`Unknown Finder location: ${location}`);
  const target = rel.startsWith("/") ? rel : `${process.env.HOME ?? ""}/${rel}`;
  await run("open", [target]);
}

let currentSay: ChildProcess | null = null;

/** Speaks a short acknowledgement. Interrupts (kills) any reply already speaking. */
export function say(text: string): void {
  stopSpeaking();
  try {
    currentSay = spawn("say", [text], { stdio: "ignore" });
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
  await run("open", ["-a", "Google Chrome", url]);
}

export async function getActiveAppName(): Promise<string | null> {
  try {
    const { stdout } = await osascript(
      'tell application "System Events" to get name of first application process whose frontmost is true'
    );
    const name = stdout.trim();
    return name || null;
  } catch (err) {
    logger.error("automation.get_active_app", err);
    return null;
  }
}
