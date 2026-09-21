// Dragon Browser Control - content script.
// Snapshots visible interactive elements with temporary stable IDs and
// performs click/type/select/scroll actions. Sends only compact element
// data (id, tag, role, short text) back to the background worker.

const ID_ATTR = "data-dragon-id";
const MAX_ELEMENTS = 60;
let idCounter = 0;

function assignId(el) {
  let id = el.getAttribute(ID_ATTR);
  if (!id) {
    id = `el${++idCounter}`;
    el.setAttribute(ID_ATTR, id);
  }
  return id;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity || "1") === 0) {
    return false;
  }
  return true;
}

function shortText(el) {
  const text =
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.value ||
    el.innerText ||
    el.textContent ||
    "";
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

function roleFor(el) {
  return el.getAttribute("role") || el.tagName.toLowerCase();
}

function collectInteractiveElements() {
  const selector = "a[href], button, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true], [tabindex]";
  const nodes = Array.from(document.querySelectorAll(selector));
  const out = [];
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const text = shortText(el);
    out.push({ id: assignId(el), tag: el.tagName.toLowerCase(), role: roleFor(el), text });
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out;
}

function getFocusedElementId() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  return assignId(active);
}

function getSnapshot() {
  return {
    url: location.href,
    title: document.title,
    focusedElementId: getFocusedElementId(),
    elements: collectInteractiveElements(),
  };
}

function findById(id) {
  return document.querySelector(`[${ID_ATTR}="${id}"]`);
}

function scrollAction(direction) {
  const amount = Math.round(window.innerHeight * 0.85);
  switch (direction) {
    case "up":
      window.scrollBy({ top: -amount, behavior: "smooth" });
      break;
    case "down":
      window.scrollBy({ top: amount, behavior: "smooth" });
      break;
    case "top":
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "bottom":
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      break;
    default:
      window.scrollBy({ top: amount, behavior: "smooth" });
  }
}

function performAction(action) {
  switch (action.kind) {
    case "click": {
      const el = findById(action.elementId);
      if (!el) return { ok: false, error: `Element ${action.elementId} not found (page may have changed)` };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true };
    }
    case "type": {
      const el = findById(action.elementId);
      if (!el) return { ok: false, error: `Element ${action.elementId} not found` };
      el.focus();
      if ("value" in el) {
        el.value = action.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = action.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        return { ok: false, error: "Element is not editable" };
      }
      return { ok: true };
    }
    case "select": {
      const el = findById(action.elementId);
      if (!el || el.tagName.toLowerCase() !== "select") return { ok: false, error: "Element is not a <select>" };
      const wanted = (action.text || "").toLowerCase();
      const options = Array.from(el.options);
      const match = options.find((o) => o.textContent.toLowerCase().includes(wanted)) || options[0];
      if (!match) return { ok: false, error: "No matching option" };
      el.value = match.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    case "scroll": {
      scrollAction(action.direction);
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown action kind: ${action.kind}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "get_snapshot") {
    sendResponse(getSnapshot());
    return;
  }
  if (message.type === "action") {
    sendResponse(performAction(message.action));
    return;
  }
});
