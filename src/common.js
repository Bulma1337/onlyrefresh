// Only Refresh — shared helpers used by the popup and the content script.
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (C) 2026 Only Refresh contributors.
//
// Loaded both as a popup <script> and as the first content-script file, so it
// must not assume a DOM. Everything hangs off a single global namespace
// (self.OnlyRefresh) and contains only pure, side-effect-free helpers.

(function () {
  'use strict';

  const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000 };

  // Smallest interval we allow, to avoid hammering a site into the ground.
  const MIN_INTERVAL_MS = 1000;

  const SETTINGS_KEY = 'or_settings';
  const REG_KEY = 'or_reg';

  function sessionKey(tabId) {
    return 'or_session_' + tabId;
  }

  // The overlay position and the auto-scroll target are remembered PER TAB
  // (keyed by tab id), each storing the origin they were set on. They survive
  // reloads (same tab id) but are wiped when the tab closes (background.js
  // onRemoved), and are only applied while the tab is on their stored origin.
  function posKey(tabId) {
    return 'or_pos_' + tabId;
  }

  function targetKey(tabId) {
    return 'or_target_' + tabId;
  }

  function toMs(value, unit) {
    const v = Number(value);
    if (!isFinite(v) || v <= 0) return 0;
    return Math.round(v * (UNIT_MS[unit] || 1000));
  }

  // Clamp any interval to the allowed minimum (and to an integer).
  function clampInterval(ms) {
    const n = Math.round(Number(ms) || 0);
    return Math.max(MIN_INTERVAL_MS, n);
  }

  // Duration of the next countdown cycle, in ms. Random mode picks a uniform
  // value in [from, to]; fixed mode returns the configured interval.
  function pickCycleMs(session) {
    if (session.randomMode) {
      let a = clampInterval(session.randomFromMs);
      let b = clampInterval(session.randomToMs);
      if (a > b) { const t = a; a = b; b = t; }
      return Math.floor(a + Math.random() * (b - a + 1));
    }
    return clampInterval(session.intervalMs);
  }

  // ms -> "MM:SS" (or "H:MM:SS" for >= 1h). Always non-negative.
  function formatClock(ms) {
    let total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    total -= h * 3600;
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  // Toolbar badge text from remaining seconds: always zero-padded MM:SS
  //   59  -> "00:59"
  //   298 -> "04:58"
  //   1800-> "30:00"
  // Overflow only: when the minutes no longer fit the badge (>= 100), fall back
  // to compact hours like "2h". Otherwise it is ALWAYS MM:SS.
  function formatBadge(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(s / 60);
    if (minutes >= 100) return Math.floor(minutes / 60) + 'h';
    return String(minutes).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function defaultSettings() {
    return {
      lang: '',                   // '' = follow the browser; or 'en','de','fr','es','zh','ja','ko','ru'
      activePreset: 30000,        // 30s preset selected by default
      customValue: 1,
      customUnit: 'minutes',
      randomMode: false,
      fromValue: 30, fromUnit: 'seconds',
      toValue: 2, toUnit: 'minutes',
      hardRefresh: false,
      maxReloads: 0,
      background: false,          // keep reloading while the tab is hidden (default: pause)
      scrollMode: 'off',          // 'off' | 'pick'  (legacy 'bottom' migrates to 'off')
      overlay: true
    };
  }

  // Resolve the effective fixed interval (ms) from a settings object: an active
  // preset wins, otherwise the custom value+unit.
  function fixedIntervalMs(s) {
    if (s.activePreset != null) return clampInterval(s.activePreset);
    return clampInterval(toMs(s.customValue, s.customUnit));
  }

  self.OnlyRefresh = {
    UNIT_MS, MIN_INTERVAL_MS, SETTINGS_KEY, REG_KEY,
    sessionKey, posKey, targetKey, toMs, clampInterval, pickCycleMs,
    formatClock, formatBadge, defaultSettings, fixedIntervalMs
  };
})();
