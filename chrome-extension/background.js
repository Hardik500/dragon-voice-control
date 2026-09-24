// Dragon Browser Control - background service worker.
// Connects to the local Dragon desktop app over a localhost WebSocket and
// relays snapshot/action requests to the active tab's content script, or
// handles tab-level actions (navigation, tabs) directly.
//
// Protocol mirrors src/types/browser-protocol.ts in the desktop app.

const BRIDGE_URL = "ws://127.0.0.1:17872";
const RECONNECT_DELAY_MS = 2000;

let socket = null;
let reconnectTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let nextSocket;
  socket = null;
  try {
    nextSocket = new WebSocket(BRIDGE_URL);
    socket = nextSocket;
  } catch (err) {
    scheduleReconnect();
    return;
  }

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    console.log("[dragon] connected to desktop app");
    send({ type: "hello" });
  });

  nextSocket.addEventListener("message", async (event) => {
    if (socket !== nextSocket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "get_snapshot") {
      const snapshot = await getSnapshotFromActiveTab();
      send({
        type: "snapshot",
        requestId: msg.requestId,
        connected: true,
        url: snapshot.url,
        title: snapshot.title,
        focusedElementId: snapshot.focusedElementId,
        elements: snapshot.elements,
      });
    } else if (msg.type === "action") {
      const result = await performAction(msg.action);
      send({ type: "action_result", requestId: msg.requestId, ok: result.ok, error: result.error });
    }
  });

  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = null;
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    /* close handler will schedule reconnect */
  });
}

function scheduleReconnect() {
  if (socket || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function getSnapshotFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return { url: "", title: "", focusedElementId: null, elements: [] };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "get_snapshot" });
    return response ?? { url: tab.url ?? "", title: tab.title ?? "", focusedElementId: null, elements: [] };
  } catch {
    // Content script may not be injected yet (e.g. chrome:// pages).
    return { url: tab.url ?? "", title: tab.title ?? "", focusedElementId: null, elements: [] };
  }
}

async function performAction(action) {
  try {
    switch (action.kind) {
      case "navigate": {
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.update(tab.id, { url: action.url });
        else await chrome.tabs.create({ url: action.url });
        return { ok: true };
      }
      case "search": {
        const url = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.update(tab.id, { url });
        else await chrome.tabs.create({ url });
        return { ok: true };
      }
      case "focus_or_open": {
        // "Open my existing tabs": reuse a tab that already matches this hostname instead of
        // always creating a new one.
        let targetHost;
        try {
          targetHost = new URL(action.url).hostname.replace(/^www\./, "");
        } catch {
          targetHost = null;
        }
        if (targetHost) {
          const allTabs = await chrome.tabs.query({});
          const existing = allTabs.find((t) => {
            if (!t.url) return false;
            try {
              return new URL(t.url).hostname.replace(/^www\./, "") === targetHost;
            } catch {
              return false;
            }
          });
          if (existing && existing.id != null) {
            await chrome.tabs.update(existing.id, { active: true });
            if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
            return { ok: true };
          }
        }
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.update(tab.id, { url: action.url });
        else await chrome.tabs.create({ url: action.url });
        return { ok: true };
      }
      case "back": {
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.goBack(tab.id);
        return { ok: true };
      }
      case "forward": {
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.goForward(tab.id);
        return { ok: true };
      }
      case "reload": {
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.reload(tab.id);
        return { ok: true };
      }
      case "new_tab": {
        await chrome.tabs.create({});
        return { ok: true };
      }
      case "close_tab": {
        const tab = await getActiveTab();
        if (tab && tab.id) await chrome.tabs.remove(tab.id);
        return { ok: true };
      }
      case "switch_tab": {
        const tab = await getActiveTab();
        if (!tab) return { ok: false, error: "No active tab" };
        const tabs = await chrome.tabs.query({ currentWindow: true });
        tabs.sort((a, b) => a.index - b.index);
        const idx = tabs.findIndex((t) => t.id === tab.id);
        const delta = action.direction === "previous" ? -1 : 1;
        const nextIdx = (idx + delta + tabs.length) % tabs.length;
        await chrome.tabs.update(tabs[nextIdx].id, { active: true });
        return { ok: true };
      }
      case "click":
      case "type":
      case "select":
      case "scroll": {
        const tab = await getActiveTab();
        if (!tab || !tab.id) return { ok: false, error: "No active tab" };
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: "action", action });
          return response ?? { ok: false, error: "No response from page" };
        } catch (err) {
          // "Receiving end does not exist" means no content script is running in this tab —
          // normal on chrome:// pages, the PDF viewer, the Chrome Web Store, or a tab that
          // hasn't finished loading yet (content scripts can't run on any of those).
          const message = err && err.message ? err.message : String(err);
          if (/receiving end does not exist/i.test(message)) {
            return {
              ok: false,
              error: "This page doesn't support Dragon's browser control (chrome:// page, PDF viewer, or still loading) — try a regular web page.",
            };
          }
          throw err;
        }
      }
      default:
        return { ok: false, error: `Unknown action kind: ${action.kind}` };
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

connect();

// Manifest V3 service workers go idle; wake on demand and keep retrying the
// bridge connection so the desktop app can always reach a live connection.
chrome.runtime.onStartup?.addListener(connect);

// MV3 service workers are evicted after ~30s idle even with an open
// WebSocket in some Chrome versions. `chrome.alarms` is the standard
// keepalive: each firing wakes this worker (if it was terminated) and
// reconnects if the socket isn't open. 0.5 minutes is Chrome's enforced
// floor for alarm periods.
chrome.alarms.create("dragon-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dragon-keepalive" && (!socket || socket.readyState !== WebSocket.OPEN)) {
    connect();
  }
});
