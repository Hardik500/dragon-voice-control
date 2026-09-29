import { clipboard, nativeImage } from "electron";
import { execFile, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { APP_ALIASES, KEY_SPECS, LOCATIONS, SETTINGS_PANES } from "../commands/registry-macos";
import { logger } from "../logging/logger";

/**
 * All macOS execution goes through `open` and `osascript`/System Events per
 * DECISIONS.md (no native Swift helper in the alpha).
 */

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(friendlyOsascriptError(`${cmd} failed: ${err.message} ${stderr ?? ""}`.trim(), err.killed)));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** osascript's Accessibility-permission errors are cryptic; surface a clear, actionable message.
 * `timedOut` is set when execFile killed the process after its timeout — distinct from a real
 * permission error, this means System Events itself is stuck (commonly a permission dialog
 * waiting off-screen for a response), which used to get silently mislabeled by callers as
 * "no window found" (see PROGRESS.md 2026-09-28). */
function friendlyOsascriptError(message: string, timedOut = false): string {
  if (/not allowed to send keystrokes|1002|not allowed assistive access|-25211/i.test(message)) {
    return (
      "macOS blocked this because Dragon doesn't have Accessibility permission yet. " +
      "Open System Settings -> Privacy & Security -> Accessibility, enable Dragon " +
      "(or your terminal, in dev mode), then try again."
    );
  }
  if (timedOut) {
    return (
      "osascript timed out waiting on System Events — it may be stuck behind an unanswered " +
      "permission dialog. Check for a hidden Accessibility/Screen Recording prompt, or toggle " +
      "Dragon's Accessibility permission off and back on in System Settings, then try again."
    );
  }
  return message;
}

function escapeAS(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function osascript(script: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return run("osascript", ["-e", script], timeoutMs);
}

/** Runs a JavaScript-for-Automation script (`osascript -l JavaScript`) — built into macOS,
 * no new dependency. Used only for clickAt(): System Events' own `click at {x,y}` command
 * hit-tests the target app's accessibility tree to resolve what's under the point, which
 * hangs indefinitely for Electron/Chromium-based apps (Slack, VS Code, etc.) with incomplete
 * AX trees — a documented AppleScript limitation, not a Dragon permission gap (confirmed by
 * reproducing the hang from a fully-trusted terminal). JXA can post a raw CGEvent mouse click
 * directly, skipping AX hit-testing entirely, gated by the same Accessibility permission. */
function jxa(script: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return run("osascript", ["-l", "JavaScript", "-e", script], timeoutMs);
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

/** Quick, read-only System Events queries should fail fast rather than eating the full 10s
 * command timeout — that 10s stall was blocking every single decision on this call (see
 * PROGRESS.md 2026-09-28), not just screen_click. */
const QUICK_QUERY_TIMEOUT_MS = 3_000;

export async function getActiveAppName(): Promise<string | null> {
  try {
    const { stdout } = await osascript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
      QUICK_QUERY_TIMEOUT_MS
    );
    const name = stdout.trim();
    return name || null;
  } catch (err) {
    logger.error("automation.get_active_app", err);
    return null;
  }
}

export async function captureFrontmostWindow(): Promise<{
  imageBase64: string;
  bounds: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
}> {
  const NO_WINDOW_MSG = "Could not find a window to click in — the frontmost app may not have an open window.";
  let stdout: string;
  try {
    ({ stdout } = await osascript(
      'tell application "System Events" to tell (first application process whose frontmost is true) to get {position, size} of front window',
      QUICK_QUERY_TIMEOUT_MS
    ));
  } catch (err) {
    // Surface a real permission/timeout diagnosis instead of masking it as "no window" —
    // friendlyOsascriptError() already turned Accessibility/timeout failures into an actionable
    // message; only fall back to the generic message for an actual "no window" case.
    throw err instanceof Error && /Accessibility|timed out/i.test(err.message) ? err : new Error(NO_WINDOW_MSG);
  }
  const nums = stdout.trim().split(",").map((s) => parseInt(s.trim(), 10));
  if (nums.length !== 4 || nums.some((n) => Number.isNaN(n))) throw new Error(NO_WINDOW_MSG);
  const [x, y, width, height] = nums;

  const tmpFile = path.join(os.tmpdir(), `dragon-click-${Date.now()}.png`);
  try {
    await run("screencapture", ["-x", "-R", `${x},${y},${width},${height}`, tmpFile]);
  } catch {
    throw new Error(
      "macOS blocked the screenshot needed for clicking — grant Dragon Screen Recording " +
        "permission in System Settings -> Privacy & Security -> Screen Recording, then try again."
    );
  }
  try {
    const buf = await fs.promises.readFile(tmpFile);
    // screencapture's -R region is in points, but on Retina displays the PNG it writes is 2x
    // that in pixels — sending the full-resolution image to the vision model costs more tokens
    // (slower + pricier) for no benefit, and previously left clickAt() adding a pixel-space
    // offset onto point-space bounds (a real click-accuracy bug). Downscaling once here and
    // returning the actual sent pixel dimensions lets the caller compute one correct scale
    // factor back to points, instead of assuming a 1:1 (or fixed 2x) ratio.
    const MAX_IMAGE_WIDTH = 1280;
    let image = nativeImage.createFromBuffer(buf);
    const original = image.getSize();
    if (original.width > MAX_IMAGE_WIDTH) {
      const scale = MAX_IMAGE_WIDTH / original.width;
      image = image.resize({ width: MAX_IMAGE_WIDTH, height: Math.round(original.height * scale) });
    }
    const sent = image.getSize();
    return {
      // JPEG: ~5-10x smaller upload than PNG; upload time dominated the vision round trip.
      imageBase64: image.toJPEG(85).toString("base64"),
      bounds: { x, y, width, height },
      imageWidth: sent.width,
      imageHeight: sent.height,
    };
  } finally {
    fs.promises.unlink(tmpFile).catch(() => {});
  }
}

export async function clickAt(x: number, y: number): Promise<void> {
  const px = Math.round(x);
  const py = Math.round(y);
  await jxa(
    `ObjC.import('CoreGraphics');var p=$.CGPointMake(${px},${py});` +
      `var d=$.CGEventCreateMouseEvent($(),$.kCGEventLeftMouseDown,p,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,d);` +
      `var u=$.CGEventCreateMouseEvent($(),$.kCGEventLeftMouseUp,p,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,u);`
  );
}

/** Walks the frontmost window's AX tree through the AX C API (JXA ObjC bridge), not System
 * Events: System Events costs one Apple event per property per element (~96 elements in 6s),
 * this walks the whole tree in well under a second. Labels are AXTitle/AXDescription, plus
 * AXValue for AXStaticText only (sidebar/list rows expose their text there) — never editable
 * text. `AXManualAccessibility` makes Electron apps (Slack, VS Code) build their tree; the first
 * walk after enabling it can come back near-empty, so it retries once. Terms arrive via argv. */
const AX_FIND_SCRIPT = `ObjC.import("AppKit");ObjC.import("ApplicationServices");
ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id*"]]);
ObjC.bindFunction("AXUIElementCreateApplication", ["id", ["int"]]);
ObjC.bindFunction("AXUIElementSetAttributeValue", ["int", ["id", "id", "id"]]);
function attr(el, name) { var ref = Ref(); var rc = $.AXUIElementCopyAttributeValue(el, $(name), ref); return rc === 0 ? { v: ref[0] } : { rc: rc }; }
function str(el, name) { var a = attr(el, name); if (!a.v) return ""; var s = ObjC.unwrap(a.v); return typeof s === "string" ? s : ""; }
function nums(el, name) { var a = attr(el, name); if (!a.v) return null; var m = ObjC.unwrap(a.v.description).match(/[xywh]:(-?[0-9.]+)/g); return m && m.map(function (t) { return parseFloat(t.slice(2)); }); }
function rect(el) { var p = nums(el, "AXPosition"), s = nums(el, "AXSize"); return p && s ? { x: p[0], y: p[1], width: s[0], height: s[1] } : null; }
function walk(win, terms) {
  var out = [], queue = [win], deadline = Date.now() + 4000, visited = 0;
  while (queue.length && Date.now() < deadline && out.length < 50) {
    var el = queue.shift();
    visited++;
    if (el !== win) {
      var role = str(el, "AXRole");
      var label = str(el, "AXTitle") || str(el, "AXDescription") || (role === "AXStaticText" ? str(el, "AXValue") : "");
      var l = label.toLowerCase();
      if (label && terms.some(function (t) { return l.indexOf(t) >= 0; })) { var r = rect(el); if (r) { r.label = label; out.push(r); } }
    }
    var kids = attr(el, "AXChildren");
    if (kids.v) { var a = ObjC.unwrap(kids.v); for (var i = 0; i < a.length; i++) queue.push(a[i]); }
  }
  return { elements: out, visited: visited };
}
function run(argv) {
  var terms = JSON.parse(argv[0]);
  var ax = $.AXUIElementCreateApplication($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  $.AXUIElementSetAttributeValue(ax, $("AXManualAccessibility"), $.NSNumber.numberWithBool(true));
  var w = attr(ax, "AXFocusedWindow");
  if (!w.v) throw new Error("AX focused window lookup failed (" + w.rc + ")");
  var res = walk(w.v, terms);
  if (res.visited < 30) { delay(0.7); res = walk(w.v, terms); }
  return JSON.stringify({ window: rect(w.v), elements: res.elements });
}`;

export async function findAccessibleElements(terms: string[]): Promise<{
  window: { x: number; y: number; width: number; height: number };
  elements: Array<{ label: string; x: number; y: number; width: number; height: number }>;
}> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", AX_FIND_SCRIPT, JSON.stringify(terms)], 8_000);
  const parsed = JSON.parse(stdout.trim());
  if (!parsed.window) throw new Error("Could not find a window to click in — the frontmost app may not have an open window.");
  return parsed;
}
