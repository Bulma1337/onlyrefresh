// Only Refresh — MV3 service worker.
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Only Refresh contributors.
//
// Responsibilities:
//   * register / unregister a per-origin dynamic content script so the
//     countdown survives reloads on the site the user started on,
//   * inject the content script into the current page on Start,
//   * perform cache-bypassing hard reloads (content scripts cannot),
//   * tear down state when a session ends or its tab closes.
//
// All long-lived truth lives in chrome.storage.local; this worker is otherwise
// stateless and may be killed/restarted by the browser at any time.

importScripts('common.js');
const OR = self.OnlyRefresh;

// ---- toolbar badge -------------------------------------------------------

// Tabs whose badge style (teal bg + dark text) we've already set during this
// worker's lifetime. Re-applied after a worker restart on the next tick.
const badgeStyled = new Set();

function ensureBadgeStyle(tabId) {
  if (badgeStyled.has(tabId)) return;
  badgeStyled.add(tabId);
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2dd4bf' }).catch(() => {});
  // setBadgeTextColor exists in Chrome/Brave 110+; guard for older builds.
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ tabId, color: '#06231f' }).catch(() => {});
  }
}

function setBadge(tabId, text) {
  ensureBadgeStyle(tabId);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function clearBadge(tabId) {
  badgeStyled.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

// ---- background-mode reload scheduling (chrome.alarms) -------------------
//
// While a tab is hidden, content-script timers are throttled, so in "background"
// mode the worker drives the reloads via an alarm aligned to nextFireAt. Note
// chrome.alarms has a ~30s minimum, so sub-30s intervals are slowed while hidden.

function alarmName(tabId) {
  return 'or_alarm_' + tabId;
}

function reloadTab(tabId, hard) {
  return chrome.tabs.reload(tabId, { bypassCache: !!hard }).catch(() => {});
}

async function armAlarm(tabId, when) {
  try { await chrome.alarms.create(alarmName(tabId), { when }); } catch (e) { /* ignore */ }
}

async function clearAlarm(tabId) {
  try { await chrome.alarms.clear(alarmName(tabId)); } catch (e) { /* ignore */ }
}

// Deterministic, valid registration id derived from an origin match pattern.
function scriptIdFor(originPattern) {
  return 'or_cs_' + originPattern.replace(/[^a-z0-9]/gi, '_');
}

async function getReg() {
  const data = await chrome.storage.local.get(OR.REG_KEY);
  return data[OR.REG_KEY] || {};
}

async function setReg(reg) {
  await chrome.storage.local.set({ [OR.REG_KEY]: reg });
}

// Ensure a dynamic content script is registered for an origin, and record that
// `tabId` depends on it.
async function ensureRegistered(originPattern, tabId) {
  const reg = await getReg();
  let entry = reg[originPattern];
  if (!entry) {
    entry = { scriptId: scriptIdFor(originPattern), tabIds: [] };
    reg[originPattern] = entry;
  }
  if (!entry.tabIds.includes(tabId)) entry.tabIds.push(tabId);

  // (Re)register defensively: drop any stale script with this id first.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [entry.scriptId] });
  } catch (e) { /* not registered yet — fine */ }

  await chrome.scripting.registerContentScripts([{
    id: entry.scriptId,
    matches: [originPattern],
    js: ['src/common.js', 'src/content.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: false
  }]);

  await setReg(reg);
}

// Drop a tab's dependency on its origin script; unregister when the last tab
// for that origin goes away.
async function releaseRegistration(tabId) {
  const reg = await getReg();
  let changed = false;
  for (const pattern of Object.keys(reg)) {
    const entry = reg[pattern];
    const i = entry.tabIds.indexOf(tabId);
    if (i !== -1) { entry.tabIds.splice(i, 1); changed = true; }
    if (entry.tabIds.length === 0) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [entry.scriptId] });
      } catch (e) { /* already gone */ }
      delete reg[pattern];
      changed = true;
    }
  }
  if (changed) await setReg(reg);
}

// End a session: remove its state, release its registration, clear badge + alarm.
// NOTE: per-tab pos/target keys are intentionally NOT cleared here so they
// survive Stop/restart on the same tab; they are wiped only on tab close.
async function teardownTab(tabId) {
  await chrome.storage.local.remove(OR.sessionKey(tabId));
  await releaseRegistration(tabId);
  clearBadge(tabId);
  await clearAlarm(tabId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const senderTabId = sender.tab ? sender.tab.id : null;
      switch (msg && msg.type) {
        case 'or_whoami':
          sendResponse({ tabId: senderTabId });
          return;

        case 'or_hardReload':
          if (senderTabId != null) {
            await chrome.tabs.reload(senderTabId, { bypassCache: true });
          }
          sendResponse({ ok: true });
          return;

        case 'or_tick':
          // Once-per-second badge update for a running session's tab.
          if (senderTabId != null) setBadge(senderTabId, OR.formatBadge(msg.seconds));
          sendResponse({ ok: true });
          return;

        case 'or_clearBadge':
          if (senderTabId != null) clearBadge(senderTabId);
          sendResponse({ ok: true });
          return;

        case 'or_bgArm': {
          // Tab went hidden in background mode — the worker takes the schedule.
          if (senderTabId != null) {
            const key = OR.sessionKey(senderTabId);
            const data = await chrome.storage.local.get(key);
            const s = data[key];
            if (s && s.running && s.background) await armAlarm(senderTabId, s.nextFireAt);
          }
          sendResponse({ ok: true });
          return;
        }

        case 'or_bgCancel':
          // Tab became visible — the content script takes the schedule back.
          if (senderTabId != null) await clearAlarm(senderTabId);
          sendResponse({ ok: true });
          return;

        case 'or_finished': {
          const tabId = senderTabId != null ? senderTabId : msg.tabId;
          if (tabId != null) await teardownTab(tabId);
          sendResponse({ ok: true });
          return;
        }

        case 'or_start':
          await ensureRegistered(msg.originPattern, msg.tabId);
          // Inject into the already-open page so the countdown starts now.
          await chrome.scripting.executeScript({
            target: { tabId: msg.tabId },
            files: ['src/common.js', 'src/content.js']
          });
          sendResponse({ ok: true });
          return;

        case 'or_stop':
          await teardownTab(msg.tabId);
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});

// Background-mode reload: performed by the worker while the tab is hidden.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('or_alarm_')) return;
  const tabId = parseInt(alarm.name.slice('or_alarm_'.length), 10);
  if (!Number.isInteger(tabId)) return;

  const key = OR.sessionKey(tabId);
  const data = await chrome.storage.local.get(key);
  const session = data[key];
  // No session, stopped, or no longer in background mode -> drop the alarm.
  if (!session || !session.running || !session.background) { await clearAlarm(tabId); return; }

  const newCount = (session.count || 0) + 1;
  session.count = newCount;
  const maxed = session.max > 0 && newCount >= session.max;

  if (maxed) {
    // Final reload, then end the session (clears badge, registration, alarm).
    await chrome.storage.local.set({ [key]: session });
    await reloadTab(tabId, session.hardRefresh);
    await teardownTab(tabId);
    return;
  }

  // Arm the next cycle (random mode picks a fresh interval each time) and reload.
  const cycleMs = OR.pickCycleMs(session);
  session.cycleMs = cycleMs;
  session.nextFireAt = Date.now() + cycleMs;
  await chrome.storage.local.set({ [key]: session });
  await reloadTab(tabId, session.hardRefresh);
  setBadge(tabId, OR.formatBadge(Math.round(cycleMs / 1000)));
  await armAlarm(tabId, session.nextFireAt);
});

// A closed tab can never resume — wipe ALL of its per-tab data (session,
// registration, badge, alarm, plus the per-tab scroll target + overlay position).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await teardownTab(tabId);
  await chrome.storage.local.remove([OR.posKey(tabId), OR.targetKey(tabId)]);
});

// Tab ids are not stable across browser restarts and our registrations don't
// persist across sessions, so clear stale per-tab state on launch.
chrome.runtime.onStartup.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const remove = Object.keys(all).filter((k) =>
    k.startsWith('or_session_') || k.startsWith('or_pos_') || k.startsWith('or_target_'));
  remove.push(OR.REG_KEY);
  if (remove.length) await chrome.storage.local.remove(remove);
});
