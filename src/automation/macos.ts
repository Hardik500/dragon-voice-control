import { nativeImage } from "electron";
import { execFile, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { APP_ALIASES, KEY_SPECS, LOCATIONS, SETTINGS_PANES } from "../commands/registry-macos";
import { logger } from "../logging/logger";
import { pasteText } from "./clipboard";

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
  return pasteText(text, async () => {
    await osascript('tell application "System Events" to keystroke "v" using {command down}');
  });
}

export async function pressNamedKey(keyName: string): Promise<void> {
  const spec = KEY_SPECS[keyName];
  if (!spec) throw new Error(`Unknown key phrase: ${keyName}`);
  const commands = (spec.sequence ?? [spec]).map((step) => {
    const mods = step.modifiers.length ? ` using {${step.modifiers.join(", ")}}` : "";
    if (step.keyCode != null) return `key code ${step.keyCode}${mods}`;
    if (step.character) return `keystroke "${escapeAS(step.character)}"${mods}`;
    throw new Error(`Key phrase has no keyCode or character: ${keyName}`);
  });
  await osascript(`tell application "System Events"\n${commands.join("\n")}\nend tell`);
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
  throw new Error("No supported media player is running. Open Spotify or Music, then try again.");
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
    const child = spawn("say", [text], { stdio: "ignore" });
    currentSay = child;
    child.on("exit", () => { if (currentSay === child) currentSay = null; });
    child.on("error", (err) => {
      if (currentSay === child) currentSay = null;
      logger.error("automation.say_failed", err);
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

/** Focused AX window only: no screen pixels, editable values or other app windows. */
export async function getActiveWindowIdentity(): Promise<string | null> {
  const { stdout } = await jxa(`
ObjC.import('AppKit'); ObjC.import('ApplicationServices');
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
var ax = $.AXUIElementCreateApplication(app.processIdentifier), ref = Ref();
if ($.AXUIElementCopyAttributeValue(ax, $('AXFocusedWindow'), ref) !== 0) throw new Error('No focused window');
function frame(name) {
  var value = Ref();
  if ($.AXUIElementCopyAttributeValue(ref[0], $(name), value) !== 0) throw new Error('Window frame unavailable');
  var matches = ObjC.unwrap(value[0].description).match(/[xywh]:(-?[0-9.]+)/g);
  if (!matches) throw new Error('Window frame unavailable');
  return matches.map(function(v){return Number(v.slice(2));});
}
JSON.stringify([Number(app.processIdentifier), Number($.CFHash(ref[0])), frame('AXPosition'), frame('AXSize')]);`, QUICK_QUERY_TIMEOUT_MS);
  return stdout.trim() || null;
}

/** Reads only the focused AX window's identity/frame and matching WindowServer ID.
 * Other windows contribute metadata only; no titles or pixel buffers are read. */
async function getFrontmostCaptureTarget(): Promise<{
  windowId: number;
  identity: string;
  bounds: { x: number; y: number; width: number; height: number };
}> {
  const { stdout } = await jxa(`
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
var pid = Number(app.processIdentifier);
var ax = $.AXUIElementCreateApplication(pid), focused = Ref();
if ($.AXUIElementCopyAttributeValue(ax, $('AXFocusedWindow'), focused) !== 0) throw new Error('No focused window');
function frame(name) {
  var value = Ref();
  if ($.AXUIElementCopyAttributeValue(focused[0], $(name), value) !== 0) throw new Error('Window frame unavailable');
  var matches = ObjC.unwrap(value[0].description).match(/[xywh]:(-?[0-9.]+)/g);
  if (!matches || matches.length !== 2) throw new Error('Window frame unavailable');
  return matches.map(function(v) { return Number(v.slice(2)); });
}
var position = frame('AXPosition'), size = frame('AXSize');
if (size[0] <= 0 || size[1] <= 0) throw new Error('Focused window has no visible frame');
var windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
if (!Array.isArray(windows)) throw new Error('Window list unavailable');
var matches = windows.filter(function(win) {
  if (Number(win.kCGWindowOwnerPID) !== pid || Number(win.kCGWindowLayer) !== 0 || !win.kCGWindowIsOnscreen) return false;
  var b = win.kCGWindowBounds;
  return b && Math.abs(Number(b.X) - position[0]) < 0.5 && Math.abs(Number(b.Y) - position[1]) < 0.5 &&
    Math.abs(Number(b.Width) - size[0]) < 0.5 && Math.abs(Number(b.Height) - size[1]) < 0.5;
});
if (matches.length !== 1) throw new Error('Could not uniquely identify the focused window for capture; try accessibility clicking');
JSON.stringify({
  windowId: Number(matches[0].kCGWindowNumber),
  identity: JSON.stringify([pid, Number($.CFHash(focused[0])), position, size]),
  bounds: { x: position[0], y: position[1], width: size[0], height: size[1] }
});`, QUICK_QUERY_TIMEOUT_MS);
  const target = JSON.parse(stdout);
  if (!Number.isInteger(target.windowId) || target.windowId <= 0 || typeof target.identity !== "string" ||
      !target.bounds || !["x", "y", "width", "height"].every(key => Number.isFinite(target.bounds[key])) ||
      target.bounds.width <= 0 || target.bounds.height <= 0) {
    throw new Error("Could not identify the focused window for capture.");
  }
  return target;
}

export async function captureFrontmostWindow(): Promise<{
  imageBase64: string;
  bounds: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
}> {
  const target = await getFrontmostCaptureTarget();
  const tmpFile = path.join(os.tmpdir(), `dragon-click-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    try {
      // Capture the window's own surface, excluding its shadow. A rectangle
      // capture would include Dragon's overlay and other overlapping windows.
      await run("screencapture", ["-x", "-o", "-l" + target.windowId, tmpFile]);
    } catch {
      throw new Error("Could not capture this window. Check Dragon's Screen Recording permission in System Settings -> Privacy & Security, or try accessibility clicking.");
    }
    const after = await getFrontmostCaptureTarget();
    if (after.windowId !== target.windowId || after.identity !== target.identity) {
      throw new Error("The focused window moved or changed during capture. Say the command again.");
    }
    const buf = await fs.promises.readFile(tmpFile);
    const MAX_IMAGE_WIDTH = 1280;
    let image = nativeImage.createFromBuffer(buf);
    const original = image.getSize();
    if (image.isEmpty() || original.width <= 0 || original.height <= 0) throw new Error("The focused window returned an empty capture.");
    if (original.width > MAX_IMAGE_WIDTH) {
      const scale = MAX_IMAGE_WIDTH / original.width;
      image = image.resize({ width: MAX_IMAGE_WIDTH, height: Math.round(original.height * scale) });
    }
    const sent = image.getSize();
    return {
      imageBase64: image.toJPEG(85).toString("base64"),
      bounds: target.bounds,
      imageWidth: sent.width,
      imageHeight: sent.height,
    };
  } finally {
    await fs.promises.unlink(tmpFile).catch(() => {});
  }
}

export async function clickAt(x: number, y: number, clicks = 1): Promise<void> {
  const px = Math.round(x);
  const py = Math.round(y);
  await jxa(
    `ObjC.import('CoreGraphics');var p=$.CGPointMake(${px},${py});` +
      `for(var i=1;i<=${clicks};i++){` +
      `var d=$.CGEventCreateMouseEvent($(),$.kCGEventLeftMouseDown,p,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(d,$.kCGMouseEventClickState,i);$.CGEventPost($.kCGHIDEventTap,d);` +
      `var u=$.CGEventCreateMouseEvent($(),$.kCGEventLeftMouseUp,p,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(u,$.kCGMouseEventClickState,i);$.CGEventPost($.kCGHIDEventTap,u);}`
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
  var mb = attr(ax, "AXMenuBar");
  if (mb.v) { var mk = attr(mb.v, "AXChildren"); if (mk.v) ObjC.unwrap(mk.v).forEach(function (m) { var t = str(m, "AXTitle"), l = t.toLowerCase(), r = rect(m); if (t && r && terms.some(function (x) { return l.indexOf(x) >= 0; })) { r.label = t; r.menu = true; res.elements.push(r); } }); }
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var electron = $.NSFileManager.defaultManager.fileExistsAtPath(ObjC.unwrap(app.bundleURL.path) + "/Contents/Frameworks/Electron Framework.framework");
  if (electron && res.visited < 30) { delay(0.7); res = walk(w.v, terms); }
  return JSON.stringify({ window: rect(w.v), elements: res.elements });
}`;

export async function findAccessibleElements(terms: string[]): Promise<{
  window: { x: number; y: number; width: number; height: number };
  elements: Array<{ label: string; x: number; y: number; width: number; height: number; menu?: boolean }>;
}> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", AX_FIND_SCRIPT, JSON.stringify(terms)], 8_000);
  const parsed = JSON.parse(stdout.trim());
  if (!parsed.window) throw new Error("Could not find a window to click in — the frontmost app may not have an open window.");
  return parsed;
}
