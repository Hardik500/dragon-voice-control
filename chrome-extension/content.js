// Dragon Browser Control — content script (isolated world).
// Only compact labels cross the bridge. Editable contents never become labels.
(() => {
  if (globalThis.__dragonBrowserControlLoaded) return;
  globalThis.__dragonBrowserControlLoaded = true;

  const MAX_ELEMENTS = 60;
  const documentId = crypto.randomUUID();
  const ids = new WeakMap();
  const targets = new Map();
  let idCounter = 0;
  let lastTarget = null;

  function assignId(el) {
    const fingerprint = targetFingerprint(el);
    let record = ids.get(el);
    if (!record || record.fingerprint !== fingerprint) {
      record = { id: documentId + ":" + (++idCounter), fingerprint };
      ids.set(el, record);
    }
    targets.set(record.id, { el, fingerprint });
    return record.id;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
    if (el.closest("[hidden], [inert], [aria-hidden=true]")) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity || "1") === 0) return false;
    // A hidden/transparent parent can give a child a perfectly normal rectangle.
    for (let parent = parentElement(el); parent; parent = parentElement(parent)) {
      if (parent.matches("[hidden], [inert], [aria-hidden=true]")) return false;
      const ancestorStyle = window.getComputedStyle(parent);
      if (ancestorStyle.visibility === "hidden" || ancestorStyle.display === "none" || parseFloat(ancestorStyle.opacity || "1") === 0) return false;
    }
    return true;
  }

  function isDisabled(el) {
    if (el.matches(":disabled")) return true;
    for (let target = el; target; target = parentElement(target)) {
      if (target.matches("[inert], [aria-disabled=true]")) return true;
    }
    return false;
  }

  function compact(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function staticText(el) {
    // innerText/textContent of contenteditable nodes would leak their contents.
    if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        return !parent || parent.isContentEditable || parent.closest("input, textarea, select, script, style, [aria-hidden=true]")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = "";
    let node;
    while ((node = walker.nextNode()) && text.length < 300) text += " " + node.textContent;
    return compact(text);
  }

  function shortText(el) {
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const root = el.getRootNode();
    const labelledText = labelledBy.map((id) => {
      const label = typeof root.getElementById === "function" ? root.getElementById(id) : document.getElementById(id);
      return label ? staticText(label) : "";
    }).join(" ");
    const labels = el.labels ? Array.from(el.labels).map(staticText).join(" ") : "";
    return compact(
      el.getAttribute("aria-label") || labelledText.trim() || labels.trim() ||
      el.getAttribute("placeholder") || el.getAttribute("title") ||
      (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) ? el.getAttribute("value") : "") ||
      staticText(el) || el.getAttribute("name") || ""
    );
  }

  function targetFingerprint(el) {
    return [el.tagName, el.getAttribute("role"), shortText(el), el.getAttribute("href"), el.getAttribute("type")].join("|");
  }

  function isReachable(el) {
    const rect = el.getBoundingClientRect();
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = parentElement(el); parent; parent = parentElement(parent)) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
    if (right <= left || bottom <= top) return false;
    const root = el.getRootNode();
    const lookup = typeof root.elementFromPoint === "function" ? root : document;
    // Partly covered controls remain available when some of their actual
    // hit area is visible. Fully covered/clipped controls are not actionable.
    for (const x of [0.5, 0.15, 0.85]) {
      for (const y of [0.5, 0.15, 0.85]) {
        const hit = lookup.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y);
        if (hit && (hit === el || el.contains(hit) || (lookup === document && root.host === hit))) return true;
      }
    }
    return false;
  }

  function allRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  function activeElement() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  function collectInteractiveElements() {
    const selector = "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=combobox], [role=switch], [contenteditable]:not([contenteditable=false]), [tabindex]";
    const out = [];
    const active = activeElement();
    const nodes = allRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
    // Keep the focused field available even on pages with more than 60 controls.
    if (active && nodes.includes(active)) {
      nodes.splice(nodes.indexOf(active), 1);
      nodes.unshift(active);
    }
    for (const el of nodes) {
      if (!isVisible(el) || isDisabled(el) || !isReachable(el)) continue;
      out.push({ id: assignId(el), tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || el.tagName.toLowerCase(), text: shortText(el) });
      if (out.length >= MAX_ELEMENTS) break;
    }
    return out;
  }

  function getSnapshot() {
    targets.clear();
    const active = activeElement();
    const focusedElementId = active && active !== document.body && isVisible(active) && !isDisabled(active) ? assignId(active) : null;
    return { url: location.href, title: document.title, focusedElementId, elements: collectInteractiveElements() };
  }

  function requireTarget(id) {
    const record = targets.get(id);
    const el = record && record.el;
    if (!el || !el.isConnected || el.ownerDocument !== document || el.getRootNode({ composed: true }) !== document || targetFingerprint(el) !== record.fingerprint) throw new Error("That control changed or the active tab changed. Say the command again.");
    if (!isVisible(el) || !isReachable(el)) throw new Error("That control is no longer visible. Say the command again.");
    if (isDisabled(el)) throw new Error("That control is disabled.");
    return el;
  }

  function requireWritableTarget(id) {
    const el = requireTarget(id);
    if (el.readOnly || el.getAttribute("aria-readonly") === "true") throw new Error("That control is read-only.");
    const textInput = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|email|tel|url|password|number)$/.test(el.type));
    if (!textInput && !el.isContentEditable) throw new Error("That control is not a text field.");
    return el;
  }

  function parentElement(el) {
    return el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  }

  function canScroll(el, direction) {
    const horizontal = direction === "left" || direction === "right";
    const style = getComputedStyle(el);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    const extent = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (extent <= 1 || (!/auto|scroll|overlay/.test(overflow) && el !== document.scrollingElement)) return false;
    const offset = horizontal ? el.scrollLeft : el.scrollTop;
    return direction === "up" || direction === "left" || direction === "top" ? offset > 0 : offset < extent - 1;
  }

  function scrollAction(direction) {
    if (!["up", "down", "left", "right", "top", "bottom"].includes(direction)) throw new Error("Unknown scroll direction.");
    const seeds = [activeElement(), lastTarget, ...document.elementsFromPoint(innerWidth / 2, innerHeight / 2)];
    let scroller = null;
    for (const seed of seeds) {
      for (let el = seed; el; el = parentElement(el)) {
        if (el !== document.body && el !== document.documentElement && el.isConnected && isVisible(el) && canScroll(el, direction)) {
          scroller = el;
          break;
        }
      }
      if (scroller) break;
    }
    if (!scroller) {
      // Off-centre lists (mailboxes, sidebars, split panes) may contain the only scrollable region.
      let largestArea = 0;
      for (const root of allRoots()) {
        for (const el of root.querySelectorAll("*")) {
          if (el === document.body || el === document.documentElement || !canScroll(el, direction) || !isVisible(el)) continue;
          const rect = el.getBoundingClientRect();
          const area = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
          if (area > largestArea) { largestArea = area; scroller = el; }
        }
      }
    }
    if (!scroller && document.scrollingElement && canScroll(document.scrollingElement, direction)) scroller = document.scrollingElement;
    if (!scroller) return { ok: false, error: "There is no more content to scroll in that direction." };
    const horizontal = direction === "left" || direction === "right";
    const amount = Math.round((horizontal ? scroller.clientWidth : scroller.clientHeight) * 0.85);
    if (direction === "top" || direction === "bottom") {
      scroller.scrollTo({ top: direction === "top" ? 0 : scroller.scrollHeight, behavior: "instant" });
    } else {
      const delta = direction === "up" || direction === "left" ? -amount : amount;
      scroller.scrollBy(horizontal ? { left: delta, behavior: "instant" } : { top: delta, behavior: "instant" });
    }
    return { ok: true };
  }

  function focusTarget(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    lastTarget = el;
  }

  function performAction(action) {
    try {
      if (!action || typeof action.kind !== "string") throw new Error("Invalid browser action.");
      switch (action.kind) {
        case "click": {
          const el = requireTarget(action.elementId);
          lastTarget = el;
          if (typeof el.click === "function") el.click();
          else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          return { ok: true };
        }
        case "type": {
          const el = requireWritableTarget(action.elementId);
          if (typeof action.text !== "string") throw new Error("Missing text to type.");
          const textInput = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
          focusTarget(el);
          // Page focus/beforeinput handlers can replace, disable or relabel a control.
          // Recheck after each callback boundary before editing that same element.
          if (requireWritableTarget(action.elementId) !== el) throw new Error("That control changed. Say the command again.");
          const beforeInput = new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType: "insertReplacementText", data: action.text });
          if (!el.dispatchEvent(beforeInput)) throw new Error("The page did not accept text input.");
          if (requireWritableTarget(action.elementId) !== el) throw new Error("That control changed. Say the command again.");
          if (textInput) {
            // Bypass framework instance setters, then send the events controlled forms observe.
            const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, action.text);
            try { el.setSelectionRange(action.text.length, action.text.length); } catch { /* number/email fields do not expose a selection */ }
            el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: action.text }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            // Native editing retains the browser's undo history where supported.
            if (!document.execCommand("insertText", false, action.text)) {
              el.textContent = action.text;
              el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: action.text }));
            }
          }
          return { ok: true };
        }
        case "select": {
          const el = requireTarget(action.elementId);
          if (el.tagName !== "SELECT") throw new Error("That control is not a dropdown.");
          const wanted = compact(action.text).toLowerCase();
          if (!wanted) throw new Error("Say the option to select.");
          focusTarget(el);
          if (requireTarget(action.elementId) !== el) throw new Error("That control changed. Say the command again.");
          // Focus handlers may rebuild/reorder options or disable one; use the current list.
          const options = Array.from(el.options).filter((option) => !option.disabled && !(option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled));
          const exact = options.filter((option) => compact(option.textContent).toLowerCase() === wanted);
          const matches = exact.length ? exact : options.filter((option) => compact(option.textContent).toLowerCase().includes(wanted));
          if (!matches.length) throw new Error("No matching dropdown option. Say the option's full label.");
          if (matches.length > 1) throw new Error("More than one dropdown option matches. Say the option's full label.");
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex").set.call(el, matches[0].index);
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
        case "scroll": return scrollAction(action.direction);
        default: throw new Error("Unknown page action: " + action.kind);
      }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "get_snapshot") sendResponse(getSnapshot());
    else if (message.type === "action") sendResponse(performAction(message.action));
    else if (message.type === "get_status") sendResponse({ available: true });
  });
})();
