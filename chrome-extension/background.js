// Dragon Browser Control - background service worker.
// Connects to the local Dragon desktop app over a localhost WebSocket and
// relays snapshot/action requests to the active tab's content script, or
// handles tab-level actions (navigation, tabs) directly.
//
// Protocol mirrors src/types/browser-protocol.ts in the desktop app.

const BRIDGE_URL = "ws://127.0.0.1:17872";
const RECONNECT_DELAY_MS = 2000;

let socket = null;

function connect() {
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    console.log("[dragon] connected to desktop app");
    send({ type: "hello" });
  });

  socket.addEventListener("message", async (event) => {
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

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => {
    /* close handler will schedule reconnect */
  });
}

function scheduleReconnect() {
  socket = null;
  setTimeout(connect, RECONNECT_DELAY_MS);
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
        const response = await chrome.tabs.sendMessage(tab.id, { type: "action", action });
        return response ?? { ok: false, error: "No response from page" };
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
