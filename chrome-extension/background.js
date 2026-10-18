// Dragon Browser Control — MV3 background service worker.
// The active normal Chrome window is the command target; installed app windows
// are excluded. DOM IDs are scoped to a document and cannot target another tab.
const BRIDGE_URL = "ws://127.0.0.1:17872";
const RECONNECT_DELAY_MS = 2000;
const HEARTBEAT_MS = 20000;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let connectionError = "";

function updateBadge() {
  const connected = socket && socket.readyState === WebSocket.OPEN;
  chrome.action.setBadgeText({ text: connected ? "ON" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#19855b" }).catch(() => {});
  chrome.action.setTitle({ title: connected ? "Dragon — connected" : "Dragon — open the desktop app to connect" }).catch(() => {});
}

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;

  let nextSocket;
  try {
    nextSocket = new WebSocket(BRIDGE_URL);
    socket = nextSocket;
    updateBadge();
  } catch {
    socket = null;
    connectionError = "Could not connect. Open Dragon and check its browser connection in Settings.";
    scheduleReconnect();
    updateBadge();
    return;
  }

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    connectionError = "";
    send({ type: "hello" }, nextSocket);
    // WebSocket traffic also keeps the Chrome 116+ MV3 worker alive.
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: "hello" }, nextSocket), HEARTBEAT_MS);
    updateBadge();
  });

  nextSocket.addEventListener("message", async (event) => {
    if (socket !== nextSocket) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg || typeof msg.requestId !== "string") return;
    try {
      if (msg.type === "get_snapshot") {
        const snapshot = await getSnapshotFromActiveTab();
        send({ type: "snapshot", requestId: msg.requestId, connected: true, ...snapshot }, nextSocket);
      } else if (msg.type === "action") {
        const result = await performAction(msg.action);
        send({ type: "action_result", requestId: msg.requestId, ok: result.ok, error: result.error }, nextSocket);
      }
    } catch (err) {
      const error = err && err.message ? err.message : String(err);
      if (msg.type === "get_snapshot") {
        send({ type: "snapshot", requestId: msg.requestId, connected: true, url: "", title: "", focusedElementId: null, elements: [], error }, nextSocket);
      } else {
        send({ type: "action_result", requestId: msg.requestId, ok: false, error }, nextSocket);
      }
    }
  });

  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    connectionError = "Desktop app disconnected. Open Dragon to reconnect.";
    scheduleReconnect();
    updateBadge();
  });
  nextSocket.addEventListener("error", () => {
    connectionError = "Cannot reach Dragon. Open the desktop app; it must be running on this computer.";
    // Closing guarantees a failed handshake cannot remain stuck in CONNECTING.
    try { nextSocket.close(); } catch { /* close event/retry handles cleanup */ }
  });
}

function scheduleReconnect() {
  if (socket || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY_MS);
}

function send(message, expectedSocket = socket) {
  if (socket === expectedSocket && expectedSocket && expectedSocket.readyState === WebSocket.OPEN) {
    try { expectedSocket.send(JSON.stringify(message)); } catch { expectedSocket.close(); }
  }
}

async function getActiveTab() {
  // Ask Chrome for its most recently focused normal window. Querying every
  // active tab and taking the first controls the wrong window when several
  // browser windows are open; currentWindow can also refer to a PWA.
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (window && window.id != null) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
      if (tab) return tab;
    }
  } catch { /* No normal browser window is open. */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return fallback || null;
}

function pageError() {
  return "This page does not support browser control (Chrome settings, Web Store, PDF, or restricted page). Open a regular web page.";
}

async function sendToPage(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    if (!/receiving end does not exist|could not establish connection/i.test(error)) throw err;
    // Unpacked extensions loaded/reloaded after a page opened have no content
    // script there yet. Inject once on ordinary pages; no manual reload needed.
    if (!/^(https?|file):/i.test(tab.url || "")) throw new Error(pageError());
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      throw new Error(pageError());
    }
  }
}

async function getSnapshotFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return { url: "", title: "", focusedElementId: null, elements: [], error: "No Chrome tab is open." };
  const empty = { url: tab.url || "", title: tab.title || "", focusedElementId: null, elements: [] };
  try {
    return await sendToPage(tab, { type: "get_snapshot" }) || { ...empty, error: "No response from this page." };
  } catch (err) {
    return { ...empty, error: err && err.message ? err.message : String(err) };
  }
}

async function requireActiveTab() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) throw new Error("No active Chrome tab.");
  return tab;
}

async function activateTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

function normalize(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

async function performAction(action) {
  try {
    if (!action || typeof action.kind !== "string") throw new Error("Invalid browser action.");
    switch (action.kind) {
      case "navigate":
      case "search": {
        const url = action.kind === "search" ? "https://www.google.com/search?q=" + encodeURIComponent(action.query) : action.url;
        const tab = await getActiveTab();
        if (tab && tab.id != null) await chrome.tabs.update(tab.id, { url });
        else await chrome.tabs.create({ url });
        return { ok: true };
      }
      case "focus_or_open": {
        const targetUrl = new URL(action.url);
        const targetHost = hostname(action.url);
        const hasDestination = targetUrl.pathname !== "/" || !!targetUrl.search || !!targetUrl.hash;
        const current = await getActiveTab();
        if (targetHost) {
          const allTabs = await chrome.tabs.query({ windowType: "normal" });
          const matches = allTabs.filter((tab) => {
            try {
              const candidate = new URL(tab.url);
              return hostname(tab.url) === targetHost && candidate.protocol === targetUrl.protocol && candidate.port === targetUrl.port;
            } catch { return false; }
          });
          matches.sort((a, b) => Number(b.windowId === current?.windowId) - Number(a.windowId === current?.windowId) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
          if (matches.length) {
            // An origin-only "open Google" can reuse the existing page unchanged. A search,
            // path or fragment is a destination and must actually be applied to the tab.
            const exact = hasDestination && matches.find((tab) => new URL(tab.url).href === targetUrl.href);
            const chosen = exact || matches[0];
            if (hasDestination && !exact) await chrome.tabs.update(chosen.id, { url: action.url });
            await activateTab(chosen);
            return { ok: true };
          }
        }
        // "Open" should preserve the page the user was working on.
        await chrome.tabs.create({ url: action.url, ...(current ? { windowId: current.windowId } : {}) });
        return { ok: true };
      }
      case "back": await chrome.tabs.goBack((await requireActiveTab()).id); return { ok: true };
      case "forward": await chrome.tabs.goForward((await requireActiveTab()).id); return { ok: true };
      case "reload": await chrome.tabs.reload((await requireActiveTab()).id); return { ok: true };
      case "new_tab": {
        const tab = await getActiveTab();
        await chrome.tabs.create(tab ? { windowId: tab.windowId } : {});
        return { ok: true };
      }
      case "close_tab": await chrome.tabs.remove((await requireActiveTab()).id); return { ok: true };
      case "switch_tab": {
        const tab = await requireActiveTab();
        const tabs = await chrome.tabs.query({ windowId: tab.windowId });
        tabs.sort((a, b) => a.index - b.index);
        if (!tabs.length) throw new Error("No Chrome tabs are open.");
        let target;
        if (action.index != null) {
          if (!Number.isInteger(action.index) || action.index < 1 || action.index > tabs.length) throw new Error("There are " + tabs.length + " tabs. Say a tab number from 1 to " + tabs.length + ".");
          target = tabs[action.index - 1];
        } else if (normalize(action.title)) {
          const wanted = normalize(action.title);
          const exact = tabs.filter((candidate) => normalize(candidate.title) === wanted || hostname(candidate.url) === wanted.replace(/^www\./, ""));
          const matches = exact.length ? exact : tabs.filter((candidate) => normalize(candidate.title).includes(wanted) || hostname(candidate.url).includes(wanted));
          if (!matches.length) throw new Error("No tab matches that name. Say a tab number or more of its title.");
          if (matches.length > 1) throw new Error("More than one tab matches. Say a tab number or a more specific title.");
          target = matches[0];
        } else {
          if (!["next", "previous", "first", "last"].includes(action.direction)) throw new Error("Unknown tab direction.");
          const index = tabs.findIndex((candidate) => candidate.id === tab.id);
          if (index < 0) throw new Error("The active tab changed. Say the tab command again.");
          target = action.direction === "first" ? tabs[0] : action.direction === "last" ? tabs[tabs.length - 1] : tabs[(index + (action.direction === "previous" ? -1 : 1) + tabs.length) % tabs.length];
        }
        await activateTab(target);
        return { ok: true };
      }
      case "click":
      case "type":
      case "select":
      case "scroll":
        return await sendToPage(await requireActiveTab(), { type: "action", action }) || { ok: false, error: "No response from page." };
      default: throw new Error("Unknown browser action: " + action.kind);
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "dragon_status" && message.type !== "dragon_reconnect") return;
  if (message.type === "dragon_reconnect") connect();
  (async () => {
    const tab = await getActiveTab();
    let pageAvailable = false;
    let pageMessage = tab ? "This page does not support browser control." : "Open a Chrome tab to use browser commands.";
    if (tab && tab.id != null) {
      try {
        const status = await sendToPage(tab, { type: "get_status" });
        pageAvailable = !!status?.available;
        if (pageAvailable) pageMessage = "Page controls are ready for voice commands.";
      } catch (err) { pageMessage = err && err.message ? err.message : String(err); }
    }
    return {
      connected: !!socket && socket.readyState === WebSocket.OPEN,
      connecting: !!socket && socket.readyState === WebSocket.CONNECTING,
      error: connectionError,
      pageAvailable,
      pageMessage,
      title: tab?.title || "",
    };
  })().then(sendResponse, () => sendResponse({ connected: false, connecting: false, error: "Chrome could not report its status. Reopen this popup." }));
  return true;
});

connect();
chrome.runtime.onStartup?.addListener(connect);
chrome.runtime.onInstalled?.addListener(connect);
// Alarms revive the worker after Chrome restarts or suspends it.
chrome.alarms.create("dragon-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dragon-keepalive" && (!socket || socket.readyState !== WebSocket.OPEN)) connect();
});
