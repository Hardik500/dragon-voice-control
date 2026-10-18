const connection = document.getElementById("connection");
const connectionText = document.getElementById("connection-text");
const connectionHelp = document.getElementById("connection-help");
const pageTitle = document.getElementById("page-title");
const pageStatus = document.getElementById("page-status");
const reconnect = document.getElementById("reconnect");
let checking = false;

async function refresh(retry = false) {
  if (checking) return;
  checking = true;
  if (retry) reconnect.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: retry ? "dragon_reconnect" : "dragon_status" });
    connection.classList.toggle("ready", !!status?.connected);
    connectionText.textContent = status?.connected ? "Connected to Dragon" : status?.connecting ? "Connecting to Dragon…" : "Desktop app disconnected";
    connectionHelp.textContent = status?.connected ? "Voice commands can reach this Chrome window." : status?.error || "Open the Dragon desktop app to connect.";
    pageTitle.textContent = status?.title || "Current Chrome page";
    pageStatus.textContent = status?.pageMessage || "Open a regular web page for browser controls.";
    reconnect.textContent = status?.connected ? "Check connection" : "Reconnect";
  } catch {
    connection.classList.remove("ready");
    connectionText.textContent = "Extension is restarting";
    connectionHelp.textContent = "Reopen this popup after reloading the extension.";
  } finally {
    reconnect.disabled = false;
    checking = false;
  }
}
reconnect.addEventListener("click", () => refresh(true));
refresh();
setInterval(() => refresh(), 2000);
