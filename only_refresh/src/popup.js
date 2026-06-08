// Only Refresh — popup logic.
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Only Refresh contributors.
//
// Reads/writes the user's settings (global defaults) and starts/stops a refresh
// session for the active tab. On Start it requests host permission for that one
// site (least privilege) and asks the service worker to register + inject the
// content script. Status reflects the active tab's live session.

(function () {
  'use strict';
  const OR = self.OnlyRefresh;
  const I18N = self.OnlyRefreshI18n;
  const $ = (id) => document.getElementById(id);

  const els = {
    gearBtn: $('gearBtn'),
    langPanel: $('langPanel'),
    langSelect: $('langSelect'),
    presets: $('presets'),
    customRow: $('customRow'),
    customValue: $('customValue'),
    customUnit: $('customUnit'),
    randomMode: $('randomMode'),
    randomFields: $('randomFields'),
    fromValue: $('fromValue'), fromUnit: $('fromUnit'),
    toValue: $('toValue'), toUnit: $('toUnit'),
    hardRefresh: $('hardRefresh'),
    maxReloads: $('maxReloads'),
    background: $('background'),
    autoScroll: $('autoScroll'),
    pickArea: $('pickArea'),
    pickBtn: $('pickBtn'),
    clearTargetBtn: $('clearTargetBtn'),
    targetHint: $('targetHint'),
    overlay: $('overlay'),
    startBtn: $('startBtn'),
    stopBtn: $('stopBtn'),
    status: $('status')
  };

  let activePreset = null;
  let currentTab = null;
  let currentOrigin = null;
  let currentLang = 'en';
  let statusTimer = null;

  // i18n shorthand: translate `key` into the active language.
  const tt = (k, p) => I18N.t(currentLang, k, p);

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    const data = await chrome.storage.local.get(OR.SETTINGS_KEY);
    const s = Object.assign(OR.defaultSettings(), data[OR.SETTINGS_KEY] || {});
    currentLang = I18N.resolve(s.lang);          // explicit choice, else browser default
    buildLangOptions();
    applySettings(s);
    applyStaticI18n();
    wire();
    currentTab = await getActiveTab();
    currentOrigin = (currentTab && supportedUrl(currentTab.url)) ? new URL(currentTab.url).origin : null;
    await displayTarget();
    await refreshStatus();
    statusTimer = setInterval(refreshStatus, 1000);
    window.addEventListener('unload', () => clearInterval(statusTimer));
  }

  // ---- i18n ----------------------------------------------------------------

  function buildLangOptions() {
    els.langSelect.textContent = '';                 // clear (built from a trusted list)
    for (const L of I18N.LANGS) {
      const opt = document.createElement('option');
      opt.value = L.code;                            // '' = follow the browser
      opt.textContent = L.code === '' ? tt('langAuto') : L.name;
      els.langSelect.appendChild(opt);
    }
  }

  // Apply translations to all static [data-i18n] nodes + a few attributes.
  function applyStaticI18n() {
    document.documentElement.lang = currentLang;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = tt(el.dataset.i18n);
    }
    els.gearBtn.setAttribute('aria-label', tt('settings'));
    if (els.langSelect.options.length) els.langSelect.options[0].textContent = tt('langAuto');
  }

  async function onLangChange() {
    currentLang = I18N.resolve(els.langSelect.value);
    applyStaticI18n();
    await saveSettings();
    await displayTarget();      // re-render the dynamic, state-dependent strings
    await refreshStatus();
  }

  // ---- form <-> settings ---------------------------------------------------

  function numOr(v, dflt) {
    const n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  function applySettings(s) {
    els.langSelect.value = s.lang || '';     // '' = Auto (browser default)
    setActivePreset(s.activePreset);
    els.customValue.value = s.customValue;
    els.customUnit.value = s.customUnit;
    els.randomMode.checked = !!s.randomMode;
    els.fromValue.value = s.fromValue;
    els.fromUnit.value = s.fromUnit;
    els.toValue.value = s.toValue;
    els.toUnit.value = s.toUnit;
    els.hardRefresh.checked = !!s.hardRefresh;
    els.maxReloads.value = s.maxReloads;
    els.background.checked = !!s.background;
    els.autoScroll.checked = s.scrollMode === 'pick';   // legacy 'bottom'/'off' -> off
    els.overlay.checked = s.overlay !== false;
    updateConditional();
  }

  function readForm() {
    return {
      lang: els.langSelect.value,
      activePreset: activePreset,
      customValue: numOr(els.customValue.value, 1),
      customUnit: els.customUnit.value,
      randomMode: els.randomMode.checked,
      fromValue: numOr(els.fromValue.value, 1),
      fromUnit: els.fromUnit.value,
      toValue: numOr(els.toValue.value, 1),
      toUnit: els.toUnit.value,
      hardRefresh: els.hardRefresh.checked,
      maxReloads: Math.max(0, Math.floor(numOr(els.maxReloads.value, 0))),
      background: els.background.checked,
      scrollMode: els.autoScroll.checked ? 'pick' : 'off',
      overlay: els.overlay.checked
    };
  }

  function setActivePreset(ms) {
    activePreset = ms != null ? Number(ms) : null;
    for (const btn of els.presets.querySelectorAll('button')) {
      btn.classList.toggle('active', activePreset != null && Number(btn.dataset.ms) === activePreset);
    }
  }

  function clearPreset() { setActivePreset(null); }

  function updateConditional() {
    const rnd = els.randomMode.checked;
    els.randomFields.classList.toggle('hidden', !rnd);
    els.presets.classList.toggle('disabled', rnd);
    els.customRow.classList.toggle('disabled', rnd);
    els.pickArea.classList.toggle('hidden', !els.autoScroll.checked);
  }

  async function saveSettings() {
    try { await chrome.storage.local.set({ [OR.SETTINGS_KEY]: readForm() }); } catch (e) { /* ignore */ }
  }

  function wire() {
    for (const btn of els.presets.querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        setActivePreset(Number(btn.dataset.ms));
        saveSettings();
      });
    }
    els.customValue.addEventListener('input', () => { clearPreset(); saveSettings(); });
    els.customUnit.addEventListener('change', () => { clearPreset(); saveSettings(); });

    els.randomMode.addEventListener('change', () => { updateConditional(); saveSettings(); });
    els.autoScroll.addEventListener('change', () => { updateConditional(); saveSettings(); });

    for (const el of [els.fromValue, els.fromUnit, els.toValue, els.toUnit,
                      els.hardRefresh, els.maxReloads, els.background, els.overlay]) {
      el.addEventListener('change', saveSettings);
    }

    els.gearBtn.addEventListener('click', () => {
      const hidden = els.langPanel.classList.toggle('hidden');
      els.gearBtn.classList.toggle('open', !hidden);
    });
    els.langSelect.addEventListener('change', onLangChange);

    els.pickBtn.addEventListener('click', onPick);
    els.clearTargetBtn.addEventListener('click', onClearTarget);
    els.startBtn.addEventListener('click', onStart);
    els.stopBtn.addEventListener('click', onStop);
  }

  // ---- start / stop --------------------------------------------------------

  function buildSession(s) {
    const session = {
      running: true,
      pendingImmediate: true,    // Change 1: reload once on Start (counts as #1)
      count: 0,
      max: Math.max(0, Math.floor(Number(s.maxReloads) || 0)),
      hardRefresh: !!s.hardRefresh,
      randomMode: !!s.randomMode,
      background: !!s.background,
      intervalMs: OR.fixedIntervalMs(s),
      randomFromMs: OR.clampInterval(OR.toMs(s.fromValue, s.fromUnit)),
      randomToMs: OR.clampInterval(OR.toMs(s.toValue, s.toUnit)),
      scrollMode: s.scrollMode === 'pick' ? 'pick' : 'off',
      overlay: !!s.overlay,
      overlayHidden: false,
      origin: null,
      originPattern: null,
      cycleMs: 0,
      nextFireAt: 0
    };
    session.cycleMs = OR.pickCycleMs(session);
    session.nextFireAt = Date.now() + session.cycleMs;
    return session;
  }

  // Validate the RAW entered durations (before clampInterval rounds them up to
  // the minimum), so a blank or zero field is actually rejected with a message.
  function validate(s) {
    if (s.randomMode) {
      const from = OR.toMs(s.fromValue, s.fromUnit);
      const to = OR.toMs(s.toValue, s.toUnit);
      if (from < OR.MIN_INTERVAL_MS || to < OR.MIN_INTERVAL_MS) {
        return { ok: false, error: tt('errRandom') };
      }
    } else if (s.activePreset == null && OR.toMs(s.customValue, s.customUnit) < OR.MIN_INTERVAL_MS) {
      // A preset is always valid; only a custom interval needs checking.
      return { ok: false, error: tt('errInterval') };
    }
    return { ok: true };
  }

  function supportedUrl(u) {
    if (!u) return false;
    let url;
    try { url = new URL(u); } catch (e) { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Chrome blocks content scripts on the Web Store.
    if (url.hostname === 'chromewebstore.google.com') return false;
    if (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) return false;
    return true;
  }

  // NOTE: must reach chrome.permissions.request with the user gesture intact, so
  // everything before it is synchronous (no awaits).
  async function onStart() {
    const s = readForm();
    const v = validate(s);
    if (!v.ok) { setStatus(v.error, 'error'); return; }
    const session = buildSession(s);

    if (!currentTab || !supportedUrl(currentTab.url)) {
      setStatus(tt('errUnsupportedStart'), 'error');
      return;
    }

    const url = new URL(currentTab.url);
    const originPattern = url.protocol + '//' + url.hostname + '/*';

    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [originPattern] });
    } catch (e) { granted = false; }
    if (!granted) { setStatus(tt('errPermDenied'), 'error'); return; }

    session.origin = url.origin;
    session.originPattern = originPattern;

    await chrome.storage.local.set({ [OR.SETTINGS_KEY]: s });
    await chrome.storage.local.set({ [OR.sessionKey(currentTab.id)]: session });

    const resp = await sendSW({ type: 'or_start', tabId: currentTab.id, originPattern });
    if (!resp || !resp.ok) {
      await chrome.storage.local.remove(OR.sessionKey(currentTab.id)); // roll back
      setStatus(tt('errStartFail', { err: (resp && resp.error) || '?' }), 'error');
      return;
    }
    await refreshStatus();
  }

  async function onStop() {
    if (!currentTab) return;
    await sendSW({ type: 'or_stop', tabId: currentTab.id });
    await refreshStatus();
  }

  // ---- element picker (auto-scroll target) --------------------------------

  async function displayTarget() {
    let rec = null;
    if (currentTab && currentOrigin) {
      const tk = OR.targetKey(currentTab.id);
      const d = await chrome.storage.local.get(tk);
      const r = d[tk];
      // Per tab, and only shown if it was picked for the tab's current origin.
      if (r && r.origin === currentOrigin) rec = r;
    }
    if (rec && rec.hint) {
      els.targetHint.textContent = tt('savedFmt', { hint: rec.hint });   // plain text
      els.targetHint.classList.remove('nudge');
      els.clearTargetBtn.classList.remove('hidden');
      els.pickBtn.textContent = tt('rePick');
    } else {
      // No target yet — nudge the user to pick one (only visible while Auto-Scroll
      // is on, since the whole pick area is hidden otherwise).
      els.targetHint.textContent = currentOrigin ? tt('noTargetYet') : tt('unavailableHere');
      els.targetHint.classList.add('nudge');
      els.clearTargetBtn.classList.add('hidden');
      els.pickBtn.textContent = tt('pickButton');
    }
  }

  // Activate the in-page element picker. Runs under activeTab (granted while the
  // popup is open), so it works BEFORE Start and needs no per-site host grant.
  async function onPick() {
    const LP = '[OnlyRefresh picker]';
    console.log(LP, 'button clicked');

    // Re-resolve the active tab fresh, in case it changed since the popup opened.
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      console.warn(LP, 'no active tab');
      setStatus(tt('errNoTabFound'), 'error');
      return;
    }
    if (!supportedUrl(tab.url)) {
      console.warn(LP, 'unsupported page', tab.url);
      setStatus(tt('errPickerPage'), 'error');
      return;
    }

    console.log(LP, 'inject start', tab.id, tab.url);
    let result;
    try {
      result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/common.js', 'src/i18n.js', 'src/picker.js']
      });
    } catch (e) {
      console.error(LP, 'inject error', e);
      setStatus(tt('errPickerStart', { err: (e && e.message) || e }), 'error');
      return;
    }
    if (chrome.runtime.lastError) {
      console.error(LP, 'inject lastError', chrome.runtime.lastError);
      setStatus(tt('errPickerStart', { err: chrome.runtime.lastError.message }), 'error');
      return;
    }
    if (!Array.isArray(result) || !result.length) {
      console.error(LP, 'inject returned no result', result);
      setStatus(tt('errPickerStart', { err: '?' }), 'error');
      return;
    }
    console.log(LP, 'inject ok', result);
    window.close();   // step aside so the user can click the page to pick
  }

  async function onClearTarget() {
    if (!currentTab) return;
    await chrome.storage.local.remove(OR.targetKey(currentTab.id));
    await displayTarget();
  }

  // ---- status --------------------------------------------------------------

  async function refreshStatus() {
    if (!currentTab) { setStatus(tt('errNoTab'), 'error'); setRunningUI(false, true); return; }
    if (!supportedUrl(currentTab.url)) {
      setStatus(tt('errUnsupported'), 'error');
      setRunningUI(false, true);
      return;
    }
    const key = OR.sessionKey(currentTab.id);
    const data = await chrome.storage.local.get(key);
    const session = data[key];
    if (session && session.running) {
      setRunningUI(true, false);
      const max = session.max > 0 ? session.max : '∞';
      setStatus(tt('runningFmt', { count: session.count, max: max }), 'running');
    } else {
      setRunningUI(false, false);
      // Don't clobber a transient error message with "Stopped".
      if (!els.status.classList.contains('error')) setStatus(tt('stopped'), '');
    }
  }

  function setRunningUI(running, blocked) {
    els.startBtn.disabled = running || blocked;
    els.stopBtn.disabled = !running;
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.classList.remove('error', 'running');
    if (kind) els.status.classList.add(kind);
  }

  // ---- helpers -------------------------------------------------------------

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (e) { return null; }
  }

  function sendSW(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }
})();
