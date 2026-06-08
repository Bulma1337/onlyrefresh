// Only Refresh — content script: countdown timer, overlay, auto-scroll.
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Only Refresh contributors.
//
// Injected (and re-injected on every reload via a registered script) into the
// page the user started refreshing. It reads its session from chrome.storage,
// drives a 1-second countdown, renders the overlay, triggers reloads, resumes
// seamlessly after each load, and tears everything down on stop / finish.
//
// Security notes:
//   * Any picked CSS selector / page text is treated strictly as data: selectors
//     go only to querySelector, text only to matching. Nothing user-derived is
//     ever written into the DOM as HTML. No eval / innerHTML with dynamic data.
//   * The overlay lives in a closed-off Shadow DOM so page CSS can't bleed in
//     and our styles can't leak out.
//
// Element picking lives in a separate, on-demand script (picker.js); this file
// only consumes the saved per-tab target selector for auto-scroll.
//
// Tab visibility: the absolute nextFireAt timestamp is the single source of truth
// (never a decremented counter). When the tab is hidden we either PAUSE (freeze
// the remaining time) or hand the schedule to the service worker for BACKGROUND
// reloads; on becoming visible we re-snap the ring + badge immediately.

(function () {
  'use strict';
  const OR = self.OnlyRefresh;
  const OLP = '[OnlyRefresh overlay]';

  // Guard against double-injection within the same page load (registration and
  // executeScript can both fire on the very first Start).
  if (self.__onlyRefreshActive) return;
  self.__onlyRefreshActive = true;

  let tabId = null;
  let sessionKey = null;
  let session = null;

  let tickTimer = null;
  let scrollEngine = null;  // { observer, poll, hardTimeout } — see beginScrollEngine
  let storageListener = null;
  let dragCleanup = null;
  let ui = null;            // { host, prog, label, circumference }
  let firing = false;
  let destroyed = false;

  init();

  async function init() {
    const who = await sendMessage({ type: 'or_whoami' });
    if (!who || who.tabId == null) { releaseGuard(); return; }
    tabId = who.tabId;
    sessionKey = OR.sessionKey(tabId);

    const data = await chrome.storage.local.get(sessionKey);
    session = data[sessionKey];

    // Not our tab / not running -> stay dormant.
    if (!session || !session.running) {
      releaseGuard();
      return;
    }

    // Running session but we've landed on a different origin (e.g. the page
    // navigated away): stay dormant and clear any stale badge for this tab.
    if (session.origin !== location.origin) {
      await sendMessage({ type: 'or_clearBadge' });
      releaseGuard();
      return;
    }

    // Max reached: the previous load was the final reload. Tear down now.
    if (session.max > 0 && session.count >= session.max) {
      await finish();
      return;
    }

    // Change 1: the very first injection after Start reloads once immediately
    // (counting as reload #1), then the normal countdown runs after that reload.
    if (session.pendingImmediate) {
      session.pendingImmediate = false;
      await fire();
      return;
    }

    listenForStop();
    addVisibilityListeners();
    if (session.overlay && !session.overlayHidden) {
      const pk = OR.posKey(tabId);
      const pd = await chrome.storage.local.get(pk);
      const pos = pd[pk];
      // Only restore a saved position if it was set on THIS origin.
      buildOverlay(pos && pos.origin === location.origin ? pos : null);
    }
    startAutoScroll();

    // Start in the correct state for the current visibility (Parts 1 & 2).
    if (document.visibilityState === 'hidden') handleHidden();
    else startTick();
  }

  // ---- timer ---------------------------------------------------------------

  function startTick() {
    stopTick();
    tick();                                   // paint immediately (snaps to nextFireAt)
    tickTimer = setInterval(tick, 1000);
  }

  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function tick() {
    if (destroyed || !session) return;
    // Never count or fire while paused (frozen) or while the tab is hidden —
    // background mode hands reloads to the worker; pause mode just freezes.
    if (session.paused || document.hidden) return;
    const remaining = session.nextFireAt - Date.now();   // absolute timestamp = source of truth
    updateOverlay(remaining);
    postBadge(remaining);
    if (remaining <= 0) fire();
  }

  // Change 2: stream the remaining seconds to the worker once per second while
  // running; the worker formats and shows it as the toolbar badge for this tab.
  function postBadge(remaining) {
    const seconds = Math.max(0, Math.round(remaining / 1000));
    try {
      chrome.runtime.sendMessage({ type: 'or_tick', seconds }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* worker not reachable — ignore */ }
  }

  async function fire() {
    if (firing || destroyed) return;
    firing = true;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }

    const newCount = (session.count || 0) + 1;
    session.count = newCount;

    const maxed = session.max > 0 && newCount >= session.max;
    if (!maxed) {
      const cycleMs = OR.pickCycleMs(session);
      session.cycleMs = cycleMs;
      session.nextFireAt = Date.now() + cycleMs;
    }

    // Persist BEFORE navigating so the next load resumes from fresh state.
    try { await chrome.storage.local.set({ [sessionKey]: session }); } catch (e) { /* ignore */ }
    updateOverlay(0);

    if (session.hardRefresh) {
      // Content scripts can't bypass the cache; the service worker does it.
      await sendMessage({ type: 'or_hardReload' });
    } else {
      location.reload();
    }
    // The document is about to be replaced; nothing else to do here.
  }

  // ---- visibility / background handoff (Parts 1 & 2) -----------------------

  function addVisibilityListeners() {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onWindowFocus);
  }

  function removeVisibilityListeners() {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onWindowFocus);
  }

  function onVisibility() {
    if (destroyed || !session) return;
    if (document.visibilityState === 'hidden') handleHidden();
    else handleVisible();
  }

  // Window regained OS focus while the tab is already visible — re-snap the ring
  // and badge to the true remaining time right away (Part 1).
  function onWindowFocus() {
    if (destroyed || !session) return;
    if (document.visibilityState !== 'visible' || session.paused) return;
    tick();
  }

  function handleHidden() {
    stopTick();
    if (session.background) {
      // Hand the schedule to the worker (content-script timers are throttled here).
      sendMessage({ type: 'or_bgArm' });
    } else if (!session.paused) {
      // Pause: freeze the remaining time; ensure no reload happens while hidden.
      session.paused = true;
      session.pausedRemaining = Math.max(0, session.nextFireAt - Date.now());
      saveSession();
    }
    // else: already paused (e.g. a manual reload while hidden) — keep the stored
    // pausedRemaining so we don't lose the frozen time.
  }

  async function handleVisible() {
    if (session.background) {
      // Take the schedule back from the worker. AWAIT the cancel so the alarm is
      // cleared BEFORE we resume ticking — otherwise the worker's alarm and our
      // own tick() could both fire a reload (double reload / count desync) if the
      // tab becomes visible exactly as the cycle is due.
      await sendMessage({ type: 'or_bgCancel' });
      if (destroyed || !session) return;        // may have torn down during the await
    } else if (session.paused) {
      // Resume exactly where we froze: next fire = now + the stored remainder.
      session.nextFireAt = Date.now() + (session.pausedRemaining || 0);
      session.paused = false;
      delete session.pausedRemaining;
      saveSession();
    }
    startTick();   // tick() runs immediately -> snaps overlay + badge, fires if due
  }

  function saveSession() {
    try { chrome.storage.local.set({ [sessionKey]: session }); } catch (e) { /* ignore */ }
  }

  // ---- overlay -------------------------------------------------------------

  function buildOverlay(savedPos) {
    const host = document.createElement('div');
    host.id = 'only-refresh-overlay-host';
    // Keep the host itself out of the page's layout/inheritance; default to the
    // top-right corner (overridden by applyPosition below if a position is saved).
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px;';

    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    root.appendChild(style);

    const box = document.createElement('div');
    box.className = 'or-box';

    const ringWrap = document.createElement('div');
    ringWrap.className = 'or-ring-wrap';

    const NS = 'http://www.w3.org/2000/svg';
    const size = 64, stroke = 6, r = (size - stroke) / 2, c = size / 2;
    const circumference = 2 * Math.PI * r;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'or-ring');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));

    const track = document.createElementNS(NS, 'circle');
    track.setAttribute('class', 'or-track');
    track.setAttribute('cx', String(c));
    track.setAttribute('cy', String(c));
    track.setAttribute('r', String(r));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', String(stroke));

    const prog = document.createElementNS(NS, 'circle');
    prog.setAttribute('class', 'or-prog');
    prog.setAttribute('cx', String(c));
    prog.setAttribute('cy', String(c));
    prog.setAttribute('r', String(r));
    prog.setAttribute('fill', 'none');
    prog.setAttribute('stroke-width', String(stroke));
    prog.setAttribute('stroke-linecap', 'round');
    prog.setAttribute('stroke-dasharray', String(circumference));
    prog.setAttribute('stroke-dashoffset', '0');

    svg.appendChild(track);
    svg.appendChild(prog);

    const label = document.createElement('div');
    label.className = 'or-label';
    label.textContent = '00:00';

    ringWrap.appendChild(svg);
    ringWrap.appendChild(label);

    const close = document.createElement('button');
    close.className = 'or-close';
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Hide Only Refresh countdown');
    close.textContent = '×';            // ×
    close.addEventListener('click', onClose);

    box.appendChild(ringWrap);
    box.appendChild(close);
    root.appendChild(box);

    // Attach to <html> so it survives even if the page rewrites <body>.
    document.documentElement.appendChild(host);
    applyPosition(host, savedPos);

    ui = { host, prog, label, circumference };
    enableDrag(host, box, close);
  }

  // Apply a saved position, clamped into the current viewport (measured after
  // the host is in the DOM). With no saved position the default top-right
  // placement from the inline cssText is kept.
  function applyPosition(host, pos) {
    if (!pos || typeof pos.left !== 'number') return;
    host.style.right = 'auto';
    host.style.left = pos.left + 'px';
    host.style.top = pos.top + 'px';
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    host.style.left = Math.max(0, Math.min(pos.left, maxLeft)) + 'px';
    host.style.top = Math.max(0, Math.min(pos.top, maxTop)) + 'px';
  }

  function updateOverlay(remaining) {
    if (!ui) return;
    const total = session.cycleMs || 1;
    let frac = remaining / total;
    if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
    // Deplete: full ring at the start of a cycle, empty at zero.
    ui.prog.setAttribute('stroke-dashoffset', String(ui.circumference * (1 - frac)));
    ui.label.textContent = OR.formatClock(Math.max(0, remaining));
  }

  async function onClose() {
    // Hide the overlay but keep refreshing; stays hidden across reloads.
    removeOverlay();
    if (session && !destroyed) {
      session.overlayHidden = true;
      try { await chrome.storage.local.set({ [sessionKey]: session }); } catch (e) { /* ignore */ }
    }
  }

  function removeOverlay() {
    if (dragCleanup) { dragCleanup(); dragCleanup = null; }
    if (ui && ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
  }

  function enableDrag(host, box, closeBtn) {
    let dragging = false, moveLogged = false, pointerId = null;
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

    const clamp = (left, top) => {
      const rect = host.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      return { left: Math.max(0, Math.min(left, maxLeft)), top: Math.max(0, Math.min(top, maxTop)) };
    };

    const onMove = (e) => {
      if (!dragging) return;
      const p = clamp(baseLeft + (e.clientX - startX), baseTop + (e.clientY - startY));
      host.style.left = p.left + 'px';
      host.style.top = p.top + 'px';
      if (!moveLogged) { moveLogged = true; console.log(OLP, 'dragging'); }
    };

    const onUp = async () => {
      if (!dragging) return;
      dragging = false;
      box.classList.remove('or-dragging');
      try { if (pointerId != null) box.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      pointerId = null;
      const left = parseFloat(host.style.left) || 0;
      const top = parseFloat(host.style.top) || 0;
      console.log(OLP, 'drag end -> saving', { left, top });
      if (session && !destroyed) {
        // Stored under its own per-tab key (with the origin), independent of the
        // session, so it never races with the reload write.
        try {
          await chrome.storage.local.set({ [OR.posKey(tabId)]: { origin: location.origin, left, top } });
          console.log(OLP, 'position saved for tab', tabId);
        } catch (e) { console.error(OLP, 'save failed', e); }
      }
    };

    const onDown = (e) => {
      if (e.target === closeBtn) return;          // close button isn't a drag handle
      if (e.button != null && e.button !== 0) return;
      const rect = host.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      // Switch from right-anchored to absolute left/top so dragging is precise.
      host.style.left = baseLeft + 'px';
      host.style.top = baseTop + 'px';
      host.style.right = 'auto';
      startX = e.clientX;
      startY = e.clientY;
      dragging = true;
      moveLogged = false;
      pointerId = e.pointerId;
      box.classList.add('or-dragging');
      // Pointer capture guarantees move/up reach us even if the pointer outruns
      // the box or crosses other page elements — the drag can't be swallowed.
      try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      box.addEventListener('pointermove', onMove);
      box.addEventListener('pointerup', onUp);
      box.addEventListener('pointercancel', onUp);
      e.preventDefault();
      e.stopPropagation();
      console.log(OLP, 'drag start at', { left: baseLeft, top: baseTop });
    };

    box.addEventListener('pointerdown', onDown);
    dragCleanup = () => {
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      try { if (pointerId != null) box.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    };
  }

  // ---- auto-scroll (Change 3) ---------------------------------------------
  //
  // Robust against slow / dynamic pages (e.g. tracking sites that stream content
  // in well after load). We never scroll immediately: we wait for the target to
  // exist AND be laid out (MutationObserver + polling fallback, up to a timeout),
  // scroll, then keep re-adjusting through a short "settle" window as the page
  // keeps shifting, and finally disconnect everything. We deliberately do NOT
  // restore a saved pixel offset — page heights change, so an absolute Y is
  // unreliable; we re-resolve the live element/bottom each time instead.

  function startAutoScroll() {
    // Auto-scroll is now a simple on/off that always targets the saved element.
    // Any value other than 'pick' (off, or the legacy 'bottom') does nothing.
    if (session.scrollMode !== 'pick') return;
    const tk = OR.targetKey(tabId);
    chrome.storage.local.get(tk).then((d) => {
      const t = d[tk];
      // Only use the target if it was picked for THIS origin on THIS tab.
      if (!destroyed && t && t.selector && t.origin === location.origin) {
        beginScrollEngine('pick', t.selector);
      }
    });
  }

  function beginScrollEngine(action, selector) {
    stopScrollEngine();                 // never run two at once

    const TIMEOUT_MS = 15000;           // give up waiting after ~15s
    const SETTLE_MS = 3000;             // keep re-pinning for ~3s after the first hit
    const TICK_MS = 300;
    const startedAt = Date.now();
    let found = false;
    let settleEndsAt = 0;

    const resolve = () => {
      if (action === 'bottom') return document.scrollingElement || document.documentElement;
      return selector ? safeQuery(selector) : null;
    };

    const isReady = () => {
      if (action === 'bottom') {
        const el = document.body || document.documentElement;
        return !!el && el.scrollHeight > 0;
      }
      const el = resolve();
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;   // exists AND has a layout box
    };

    const performScroll = () => {
      if (action === 'bottom') {
        const h = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        window.scrollTo(0, h);
      } else {
        const el = resolve();
        if (!el) return;
        // Land the element at the TOP of the viewport, below any sticky header.
        const top = window.scrollY + el.getBoundingClientRect().top - stickyOffset();
        window.scrollTo(0, Math.max(0, top));
      }
    };

    const onChange = () => {
      if (destroyed) { stopScrollEngine(); return; }
      if (!found) {
        if (isReady()) {
          found = true;
          settleEndsAt = Date.now() + SETTLE_MS;
          performScroll();
        } else if (Date.now() - startedAt > TIMEOUT_MS) {
          stopScrollEngine();           // target never showed up
        }
        return;
      }
      // Found: re-pin during the settle window as layout keeps shifting.
      performScroll();
      if (Date.now() >= settleEndsAt) stopScrollEngine();
    };

    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scrollEngine = {
      observer,
      poll: setInterval(onChange, TICK_MS),
      hardTimeout: setTimeout(() => { if (!found) stopScrollEngine(); }, TIMEOUT_MS + 500)
    };
    onChange();                         // first attempt right away
  }

  function stopScrollEngine() {
    if (!scrollEngine) return;
    if (scrollEngine.observer) scrollEngine.observer.disconnect();
    if (scrollEngine.poll) clearInterval(scrollEngine.poll);
    if (scrollEngine.hardTimeout) clearTimeout(scrollEngine.hardTimeout);
    scrollEngine = null;
  }

  // The saved selector was unique when picked, but the page may have changed
  // since: if it now matches nothing (or is somehow invalid), we return null and
  // the engine simply keeps waiting and then times out without scrolling — it
  // never throws and never scrolls to the wrong place.
  function safeQuery(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  // Height of a fixed/sticky header pinned to the top, so "scroll to top" lands
  // the target just below it instead of hidden underneath.
  function stickyOffset() {
    let offset = 0;
    const cx = Math.max(1, Math.floor(window.innerWidth / 2));
    let stack = [];
    try { stack = document.elementsFromPoint(cx, 2) || []; } catch (e) { stack = []; }
    for (const el of stack) {
      if (!el || el.nodeType !== 1) continue;
      if (el.id === 'only-refresh-overlay-host') continue;  // skip our own overlay
      let pos = '';
      try { pos = getComputedStyle(el).position; } catch (e) { continue; }
      if (pos === 'fixed' || pos === 'sticky') {
        const r = el.getBoundingClientRect();
        if (r.top <= 2 && r.height > offset && r.height < window.innerHeight * 0.5) {
          offset = r.height;
        }
      }
    }
    return offset;
  }

  // ---- lifecycle / teardown ------------------------------------------------

  function listenForStop() {
    storageListener = (changes, area) => {
      if (area !== 'local' || !(sessionKey in changes)) return;
      const nv = changes[sessionKey].newValue;
      if (!nv || !nv.running) {
        // Stopped from the popup (session removed) — tear down UI + timers.
        teardownUI();
        releaseGuard();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
  }

  // Reached max reloads: clear state + registration and remove the UI.
  async function finish() {
    teardownUI();
    try { await chrome.storage.local.remove(sessionKey); } catch (e) { /* ignore */ }
    await sendMessage({ type: 'or_finished' });
    releaseGuard();
  }

  function teardownUI() {
    stopTick();
    removeVisibilityListeners();
    stopScrollEngine();
    removeOverlay();
  }

  function releaseGuard() {
    destroyed = true;
    teardownUI();
    if (storageListener) {
      chrome.storage.onChanged.removeListener(storageListener);
      storageListener = null;
    }
    self.__onlyRefreshActive = false;
  }

  // ---- messaging -----------------------------------------------------------

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError;        // swallow "no receiver" noise
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---- styles (Shadow DOM, isolated from the page) -------------------------

  const OVERLAY_CSS = `
    :host, * { box-sizing: border-box; }
    .or-box {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px 8px 8px;
      background: rgba(17, 19, 23, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      cursor: grab;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .or-box.or-dragging { cursor: grabbing; }
    .or-ring-wrap { position: relative; width: 64px; height: 64px; }
    .or-ring { display: block; transform: rotate(-90deg); }
    .or-track { stroke: rgba(255, 255, 255, 0.12); }
    .or-prog { stroke: #2dd4bf; transition: stroke-dashoffset 1s linear; }
    .or-label {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #f4f6f6; font-size: 15px; font-weight: 600;
      letter-spacing: 0.5px; font-variant-numeric: tabular-nums;
    }
    .or-close {
      all: unset;
      cursor: pointer;
      width: 18px; height: 18px; line-height: 18px; text-align: center;
      border-radius: 50%;
      color: rgba(255, 255, 255, 0.75);
      font-size: 16px; font-family: sans-serif;
      align-self: flex-start;
    }
    .or-close:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
  `;
})();
