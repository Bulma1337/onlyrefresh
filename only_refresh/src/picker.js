// Only Refresh — on-demand element picker (eyedropper).
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Only Refresh contributors.
//
// Injected on demand from the popup (via activeTab) to let the user point at an
// element to use as the auto-scroll target. It renders its own Shadow-DOM UI so
// page CSS can't interfere, uses capture-phase listeners so the click does NOT
// activate the page, and computes a robust, self-contained CSS selector that
// does not depend on the element's text (which changes). The picked selector +
// a short human-readable hint are saved per tab (with the origin) in
// chrome.storage.local.
//
// IMPORTANT: the activation (buildUI/addListeners) runs at the BOTTOM of this
// IIFE, after every `const` (notably PICKER_CSS) is initialised. Running it at
// the top would hit the temporal dead zone and throw before any UI appeared.

(function () {
  'use strict';
  const LP = '[OnlyRefresh picker]';
  const OR = self.OnlyRefresh;
  const I18N = self.OnlyRefreshI18n;
  let LANG = 'en';
  // English fallbacks for the in-page strings, used only if i18n.js didn't load.
  const FALLBACK = {
    pickerBanner: 'Click the spot that should be at the top after reloading · Esc = Cancel',
    pickerSaved: 'Saved · {hint}',
    pickerError: 'Couldn’t save the spot. Please try again.'
  };
  function tp(k, p) {                                     // translate for the page UI
    if (I18N) return I18N.t(LANG, k, p);
    let s = FALLBACK[k] != null ? FALLBACK[k] : k;
    if (p) for (const key in p) s = s.split('{' + key + '}').join(String(p[key]));
    return s;
  }

  if (window.__onlyRefreshPicker) { console.log(LP, 'already active — ignoring'); return; }
  window.__onlyRefreshPicker = true;

  let host = null, hi = null, label = null, banner = null;
  let current = null;        // element currently under the cursor
  let hoverLogged = false;
  let finishing = false;

  // ---- UI (Shadow DOM) -----------------------------------------------------

  function buildUI() {
    host = document.createElement('div');
    host.id = 'only-refresh-picker-host';
    // Full-viewport but click-through, so elementFromPoint sees page elements.
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PICKER_CSS;
    root.appendChild(style);

    banner = document.createElement('div');
    banner.className = 'orp-banner';
    banner.textContent = tp('pickerBanner');

    hi = document.createElement('div');
    hi.className = 'orp-hi';

    label = document.createElement('div');
    label.className = 'orp-label';

    root.appendChild(banner);
    root.appendChild(hi);
    root.appendChild(label);
    document.documentElement.appendChild(host);
  }

  function positionHighlight(el) {
    const r = el.getBoundingClientRect();
    hi.style.display = 'block';
    hi.style.left = r.left + 'px';
    hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px';
    hi.style.height = r.height + 'px';

    label.style.display = 'block';
    label.textContent = describe(el);
    const lx = Math.max(4, Math.min(r.left, window.innerWidth - 224));
    let ly = r.top - 22;
    if (ly < 2) ly = Math.min(r.bottom + 4, window.innerHeight - 22);
    label.style.left = lx + 'px';
    label.style.top = ly + 'px';
  }

  function showBannerError(msg) {
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.add('orp-err');
  }

  // ---- listeners (capture phase) ------------------------------------------

  // Neutralise page interaction for pointer/mouse events while picking.
  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  };

  const onMove = (e) => {
    try {
      const el = elementUnder(e.clientX, e.clientY);
      if (el && el !== current) {
        current = el;
        positionHighlight(el);
        if (!hoverLogged) { hoverLogged = true; console.log(LP, 'hover working —', el.tagName.toLowerCase()); }
      }
    } catch (err) { console.error(LP, 'hover error', err); }
  };

  const onClick = (e) => {
    swallow(e);
    const el = current || elementUnder(e.clientX, e.clientY);
    console.log(LP, 'click captured', el && el.tagName ? el.tagName.toLowerCase() : el);
    if (el) select(el);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { swallow(e); console.log(LP, 'cancelled (Esc)'); cleanup(); }
  };

  const SWALLOW_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'auxclick'];

  function addListeners() {
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    for (const t of SWALLOW_EVENTS) document.addEventListener(t, swallow, true);
  }

  function removeListeners() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    for (const t of SWALLOW_EVENTS) document.removeEventListener(t, swallow, true);
  }

  function elementUnder(x, y) {
    // Host is pointer-events:none, so this returns the page element. Guard
    // against ever returning one of our own nodes anyway.
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (el === host || el.id === 'only-refresh-picker-host' || el.id === 'only-refresh-overlay-host') return null;
    return el;
  }

  // ---- selection -----------------------------------------------------------

  async function select(el) {
    if (finishing) return;
    finishing = true;
    removeListeners();
    try {
      const selector = computeSelector(el);
      const hint = describe(el);
      console.log(LP, 'selector computed', selector);
      // Targets are stored PER TAB (with the origin), so reopening the site in a
      // new tab won't reuse it. Ask the worker for this tab's id.
      const who = await sendMessage({ type: 'or_whoami' });
      const tabId = who && who.tabId;
      if (tabId == null) throw new Error('could not resolve tab id');
      await chrome.storage.local.set({ [OR.targetKey(tabId)]: { origin: location.origin, selector, hint } });
      console.log(LP, 'saved (tab ' + tabId + ')', { selector, hint });
      flashAndScroll(el, hint);
    } catch (e) {
      console.error(LP, 'selection failed', e);
      showBannerError(tp('pickerError'));
      setTimeout(cleanup, 1800);
    }
  }

  function flashAndScroll(el, hint) {
    // Confirm it worked: scroll the element into view and flash the box briefly.
    try { el.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) { /* ignore */ }
    if (banner) banner.textContent = tp('pickerSaved', { hint: hint || describe(el) });
    if (banner) banner.classList.add('orp-ok');
    requestAnimationFrame(() => {
      if (!hi) return;
      positionHighlight(el);
      hi.classList.add('orp-selected');
    });
    setTimeout(cleanup, 1100);
  }

  function cleanup() {
    removeListeners();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = hi = label = banner = current = null;
    window.__onlyRefreshPicker = false;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => { void chrome.runtime.lastError; resolve(resp); });
      } catch (e) { resolve(null); }
    });
  }

  // ---- robust, text-independent selector -----------------------------------

  function describe(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
    let text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 40) text = text.slice(0, 40) + '…';
    return text ? tag + ' · “' + text + '”' : tag;
  }

  // True only for values safe and stable enough to put in a selector.
  function isStableValue(v) {
    if (!v) return false;
    const s = String(v);
    if (s.length > 60) return false;
    // Reject control characters (newline/tab/null/etc.) — they would malform
    // the CSS attribute selector. (Checked via char code, no literal controls.)
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return false;
    }
    if (s.indexOf(':') !== -1) return false;               // e.g. React useId ":r3:"
    if (/^\d+$/.test(s)) return false;                     // pure number
    if (/\d{5,}/.test(s)) return false;                    // long digit run
    if (/[0-9a-f]{8,}/i.test(s)) return false;             // hash-like
    if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false; // uuid-ish
    return true;
  }

  function esc(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function attrEsc(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  const STABLE_ATTRS = ['name', 'role', 'aria-label', 'type', 'data-testid', 'data-test', 'data-qa'];

  function attrSelector(el) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute ? el.getAttribute(a) : null;
      if (v != null && isStableValue(v)) parts.push('[' + a + '="' + attrEsc(v) + '"]');
    }
    // Any other data-* attribute with a stable value.
    if (el.attributes) {
      for (const at of Array.from(el.attributes)) {
        if (at.name.indexOf('data-') === 0 && STABLE_ATTRS.indexOf(at.name) === -1 && isStableValue(at.value)) {
          parts.push('[' + at.name + '="' + attrEsc(at.value) + '"]');
        }
      }
    }
    return parts.length > 1 ? parts.join('') : null;
  }

  function nthOfType(node) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) return tag;
    let idx = 0, n = 0;
    for (const c of Array.from(parent.children)) {
      if (c.tagName === node.tagName) { n++; if (c === node) idx = n; }
    }
    return n > 1 ? tag + ':nth-of-type(' + idx + ')' : tag;
  }

  function structuralPath(el) {
    const segments = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && isStableValue(node.id) && isUnique('#' + esc(node.id))) {
        segments.unshift('#' + esc(node.id));
        return segments.join(' > ');
      }
      const aSel = attrSelector(node);
      if (aSel && isUnique(aSel)) {
        segments.unshift(aSel);
        return segments.join(' > ');
      }
      segments.unshift(nthOfType(node));
      node = node.parentElement;
    }
    segments.unshift(node === document.documentElement ? ':root' : 'body');
    return segments.join(' > ');
  }

  function computeSelector(el) {
    // 1) a unique, stable id
    if (el.id && isStableValue(el.id)) {
      const s = '#' + esc(el.id);
      if (isUnique(s)) return s;
    }
    // 2) tag + a unique combination of stable attributes
    const aSel = attrSelector(el);
    if (aSel && isUnique(aSel) && document.querySelector(aSel) === el) return aSel;
    // 3) structural :nth-of-type path from the nearest stable ancestor
    return structuralPath(el);
  }

  // ---- styles --------------------------------------------------------------

  const PICKER_CSS = `
    :host { all: initial; }
    .orp-banner {
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      max-width: 92vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: rgba(17, 19, 23, 0.92); color: #f4f6f6;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 9px 14px; border-radius: 10px; border: 1px solid #2dd4bf;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); pointer-events: none;
    }
    .orp-banner.orp-ok { color: #2dd4bf; border-color: #2dd4bf; }
    .orp-banner.orp-err { color: #f87171; border-color: #f87171; }
    .orp-hi {
      position: fixed; display: none; pointer-events: none; box-sizing: border-box;
      border: 2px solid #2dd4bf; background: rgba(45, 212, 191, 0.18);
      border-radius: 3px; transition: left 0.04s linear, top 0.04s linear, width 0.04s linear, height 0.04s linear;
    }
    .orp-hi.orp-selected { background: rgba(45, 212, 191, 0.36); }
    .orp-label {
      position: fixed; display: none; pointer-events: none; font-weight: 600;
      max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: #2dd4bf; color: #06231f;
      font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 2px 6px; border-radius: 5px;
    }
  `;

  // Effective UI language: the user's choice (or_settings.lang) or the browser.
  function resolveLang() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(OR.SETTINGS_KEY, (d) => {
          void chrome.runtime.lastError;
          const s = (d && d[OR.SETTINGS_KEY]) || {};
          resolve(I18N ? I18N.resolve(s.lang) : 'en');
        });
      } catch (e) { resolve(I18N ? I18N.detect() : 'en'); }
    });
  }

  // ---- activate (LAST — after all declarations, so no temporal-dead-zone) ---

  (async function activate() {
    try {
      console.log(LP, 'inject start', location.href);
      LANG = await resolveLang();
      buildUI();
      addListeners();
      console.log(LP, 'active', LANG);
    } catch (e) {
      console.error(LP, 'activation failed', e);
      window.__onlyRefreshPicker = false;
      try { cleanup(); } catch (_) { /* ignore */ }
    }
  })();
})();
