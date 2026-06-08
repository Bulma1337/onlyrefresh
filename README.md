# Only Refresh

A **source-available** Manifest V3 browser extension for Chromium and Brave, free
for noncommercial use, that auto-reloads the current tab at a configurable
interval, with a clean on-page countdown ring, a live countdown on the toolbar
icon, and optional auto-scroll (including an element picker). Everything runs
locally — no accounts, no network calls, no tracking.

---

<img width="436" height="600" alt="image" src="https://github.com/user-attachments/assets/cb3deecf-4887-4b2a-8b8e-aac4d230fad6" />

<img width="437" height="602" alt="image" src="https://github.com/user-attachments/assets/64150516-bd05-493c-93de-f4e2f09ad187" />

---

## Features

- **Preset intervals** — 10s, 30s, 1m, 5m, 30m (single-select).
- **Custom interval** — any value in seconds, minutes, or hours.
- **Random interval mode** — each reload waits a random duration between a
  *from* and *to* value (e.g. 32s–2m), so refreshes look less robotic.
- **Hard refresh** — optionally bypass the cache (like <kbd>Ctrl</kbd>+<kbd>F5</kbd>),
  routed through the service worker via `chrome.tabs.reload(..., { bypassCache: true })`.
- **Immediate first reload** — pressing **Start** reloads the tab once right away,
  then begins the interval countdown for the next one. That first reload counts
  toward **Max reloads** (e.g. max = 3 → reload on Start, then 2 more, then stop).
- **Max reloads** — stop automatically after N reloads (0 or empty = unlimited).
- **Live toolbar badge** — while running, the remaining time is shown on the
  extension's toolbar icon for that tab, updated every second, as a zero-padded
  `MM:SS` (`00:59`, `04:58`, `30:00`) on a teal badge. For very long intervals
  (≥ 100 minutes, which no longer fit) it falls back to compact hours like `2h`.
- **Smart tab handling** — the countdown stays correct across tab switches: it
  tracks an absolute fire time (not a decrementing counter, which browsers freeze
  in background tabs) and re-snaps the ring + badge the instant the tab is shown
  again. A **Background refresh** toggle (default **off**) decides what happens
  when you switch away: *off* **pauses** and resumes exactly where it left off;
  *on* keeps reloading in the **background**, handed to the service worker.
- **Auto-Scroll** — a simple on/off toggle. When on, after each load the page
  scrolls to an element you pick with an eyedropper so it sits at the top of the
  viewport. Robust against slow/dynamic pages: it waits for the element to render
  and keeps re-pinning it through a short settle window as content streams in.
  (On with no target picked is a harmless no-op; the popup nudges you to pick one.)
- **On-page countdown overlay** — a small, **draggable**, dark, rounded widget
  with a circular progress ring that depletes as time runs out and the remaining
  time shown as `mm:ss` in the center. Drag it anywhere with the mouse (its
  position is remembered for that tab and restored on every reload); hit **×** to
  hide it.
- **Survives reloads, resets on close** — everything (session, picked scroll
  target, overlay position) belongs to the **tab**: it survives reloads of that![Uploading image.png…]()

  tab, but closing the tab and reopening the site gives you a clean slate. The
  session keeps running on the tab you started on even while you work in others.
- **Multi-language UI** — the popup and the picker are localized into **English,
  German, French, Spanish, Chinese, Japanese, Korean, and Russian**. The language
  follows your browser by default and can be changed any time via the **gear icon**
  (⚙) in the popup. All translations are bundled locally (no network).
- **Least privilege** — no broad host permissions; access to a site is requested
  only when you press **Start** on that site.

---

## Install (load unpacked)

This extension is not packaged for a store; load it directly from source.

1. Download / clone this repository to a local folder.
2. Open your browser's extensions page:
   - Chrome / Chromium: `chrome://extensions`
   - Brave: `brave://extensions`
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked**.
5. Select the **project folder** (the folder containing `manifest.json`).
6. Pin **Only Refresh** from the puzzle-piece toolbar menu for quick access.

No build step is required — it is plain HTML/CSS/JS.

---

## Usage

1. Navigate to the page you want to auto-reload (any `http://` / `https://` site).
2. Click the **Only Refresh** toolbar icon.
3. Pick a preset, set a custom interval, or enable **Random interval**.
4. (Optional) Toggle **Hard refresh**, set **Max reloads**, turn **Auto-Scroll**
   on (then pick a target), or turn the **Countdown overlay** off.
5. Press **Start**.
   - The first time you start on a given site, the browser asks you to grant
     access to **that one site**. This is required so the countdown can survive
     reloads there. Approve it to continue.
6. The tab reloads once immediately, the countdown ring appears on the page, the
   toolbar icon shows the remaining time, and the tab reloads again each time the
   countdown reaches zero.
7. Press **Stop** in the popup (or click **×** to just hide the overlay while it
   keeps running). Refreshing also stops automatically when **Max reloads** is hit;
   the badge clears whenever a session ends.

The popup's status line shows whether it's running and `reloads done / max`.

### Using the element picker (Auto-Scroll → pick a target)

1. In the popup, turn **Auto-Scroll** on.
2. Click **Pick a spot on the page** (the button text appears in your chosen
   language). The popup closes and the page enters picker mode — a banner appears
   (e.g. *"Click the spot that should be at the top after reloading · Esc =
   Cancel"*). Move the mouse to highlight elements, **click** to choose one, or
   press **Esc** to cancel. The click is intercepted, so it won't activate the
   page. This runs under `activeTab`, so you can pick a target **before** pressing
   Start — no per-site permission is required.
3. The chosen element flashes and the target is saved **for that tab** (together
   with the origin it was picked on). Reopen the popup to see it as **Saved: …**
   with **Re-pick** / **Clear** controls.
4. From then on, after every reload on that site the page scrolls so the target
   sits at the top (just below a sticky header, if any).
5. Picker activity is logged to the page's DevTools console with the prefix
   `[OnlyRefresh picker]` (and the popup logs injection there too) for tracing.

The target is matched by a robust CSS selector (a stable id, a unique combination
of stable attributes, or a structural `:nth-of-type` path) — **never** by the
element's text, since text changes between reloads.

### Language

The popup and the picker speak **English, German, French, Spanish, Chinese,
Japanese, Korean, and Russian**. By default the UI follows your browser's language;
to change it, click the **gear icon (⚙)** in the popup header and choose a language
(or **Auto** to follow the browser again). The choice is saved with your settings,
and every translation is bundled locally — nothing is fetched.

### Switching tabs — pause vs. background

The countdown always tracks an absolute fire time, so it can't drift when a tab is
backgrounded; it re-snaps the moment the tab is shown again. What happens *while*
the tab is hidden depends on the **Background refresh** toggle:

- **Off (default — pause):** the session freezes when you switch away (no reload
  happens while hidden) and resumes exactly where it left off when you come back.
- **On (background):** the tab keeps reloading while hidden. The service worker
  takes over scheduling via `chrome.alarms`, and the content script takes back
  over (smooth per-second countdown) when the tab is visible again.

> **Note:** A refresh session belongs to one tab for the current browser session.
> Same-site reloads and in-page navigation are fine. If you navigate that tab to a
> **different site**, the session pauses (and its toolbar badge may keep showing
> the last value) until you return to the original site — or just press **Stop**.
> Closing the tab wipes everything for it (session, scroll target, overlay
> position); fully quitting and reopening the browser clears active sessions too
> (saved settings are kept).

---

## Permissions — and why each is needed

The extension asks for the **minimum** required to work and explains each below.

| Permission | Type | Why it's needed |
|---|---|---|
| `storage` | required | Save your settings and the active refresh state (interval, count, next-fire time) so the countdown survives reloads. Stored locally via `chrome.storage.local`. |
| `scripting` | required | Inject the countdown content script into the page you start on, and **register** it for that site so it re-runs after each reload. |
| `activeTab` | required | Read the active tab's URL when the popup is open so Start knows which site to act on, and inject the element picker on the current tab. Grants temporary access to the current tab only. |
| `alarms` | required | **Only used for background-refresh mode.** While a tab is hidden, page timers are throttled, so the service worker schedules the reload via an alarm aligned to the next-fire time. Unused when background mode is off. No user-facing warning. |
| `*://*/*` | **optional** host permission | **Not granted by default.** When you press **Start**, the extension requests access to **only the current site** (e.g. `https://example.com/*`). This is what lets the registered content script keep refreshing across reloads. Access is released when you Stop or close the tab. |

What the extension deliberately does **not** request:

- No static broad host permission (no `<all_urls>` content script).
- No `tabs` permission (cache-bypass + background reloads use the per-site host grant).
- No `webNavigation`, `cookies`, `history`, or any data-access permission.

> **Honest limitation:** `chrome.alarms` has a ~30-second minimum and hidden tabs
> are throttled, so in **background** mode an interval below ~30s may be slowed to
> ~30s *while the tab is hidden*. It returns to the exact interval as soon as the
> tab is visible again (the content script takes the schedule back). Pause mode is
> unaffected.

---

## Privacy

- **No data collection.** Nothing about you or your browsing is gathered.
- **No network requests.** The extension never contacts any server. It has no
  analytics, telemetry, or "phone home" of any kind.
- **No remote code, no CDNs.** All code and assets are bundled locally; nothing
  is fetched or evaluated at runtime.
- **Local-only storage.** Settings and refresh state live in `chrome.storage.local`
  on your machine and are used solely to make the feature work.
- **Untrusted input is handled safely.** Any picked CSS selector or page text is
  treated strictly as data — selectors go only to `querySelector`, text only to
  matching/labels — and is never inserted into the page as HTML (no `eval`,
  no `innerHTML` with dynamic data). The element picker reads the page only while
  you are actively picking.

---

## How it works (architecture)

- **The per-second countdown is driven inside the page**, not by `chrome.alarms`:
  the alarms API has a 30-second minimum, too coarse for a per-second display or a
  10-second interval. A 1-second timer in the content script handles it. (`alarms`
  is used *only* for background-mode reloads while a tab is hidden — see below.)
- **Reload-survival without broad permissions:** on Start, the service worker
  registers a dynamic content script scoped to the one site you chose
  (`chrome.scripting.registerContentScripts`). After every reload the browser
  re-injects it; it reads the saved state from `chrome.storage` and resumes.
- **Seamless resume:** the next-fire moment is stored as an absolute timestamp,
  so `remaining = nextFireAt − now` is correct on every fresh load — the ring
  picks up exactly where it left off.
- **Soft vs. hard reload:** soft uses `location.reload()`; hard messages the
  service worker, which calls `chrome.tabs.reload(tabId, { bypassCache: true })`
  (content scripts can't bypass the cache themselves).
- **Immediate first reload:** the session is created with a one-shot
  "pending immediate" flag; the freshly injected content script consumes it,
  performs reload #1, then resumes the normal countdown after that reload.
- **Toolbar badge:** while running, the content script's existing 1-second tick
  sends the remaining seconds to the service worker, which formats them (≤4 chars)
  and sets a per-tab badge via `chrome.action.setBadgeText` (teal background, dark
  text). The badge is cleared on Stop / max-reached / tab-close / teardown. This
  needs **no extra permission** — the `action` key already grants the badge APIs.
- **Robust auto-scroll:** when Auto-Scroll is on, on each load the content script
  does **not** scroll immediately. It waits (via a `MutationObserver` plus a
  polling fallback, up to a ~15s timeout) until the picked target exists *and* has
  a layout box, scrolls it to the top, then keeps re-pinning it through a short
  (~3s) settle window as the page keeps shifting, and finally disconnects the
  observer. Saved raw pixel scroll positions are **deliberately not used** — page
  height/content changes between loads make an absolute Y unreliable, so the live
  target element is re-resolved each time instead.
- **Element picker:** a separate, on-demand script (`picker.js`) injected via
  `activeTab`. It uses its own **Shadow DOM** and capture-phase listeners that
  `preventDefault`/`stopPropagation` the click so it never activates the page, and
  computes a text-independent selector. The picked target is saved per tab.
- **Draggable overlay:** the on-page ring can be dragged anywhere with the mouse.
  It uses pointer capture so the drag can't be lost if the pointer outruns the
  widget, clamps into the viewport, and saves its position to `or_pos_<tabId>`
  (with the origin) — restored on every reload, wiped when the tab closes. Drag
  activity is logged under `[OnlyRefresh overlay]` for tracing.
- **Tab visibility (the source of truth is time, not a counter):** the content
  script computes `remaining = nextFireAt − now` every tick, and re-snaps it on
  `visibilitychange` and window `focus`, so a background-throttled timer can never
  make it freeze or jump. On `visibilitychange`:
  - *Pause mode (default):* on hidden, the per-second tick stops and the remaining
    time is frozen (`pausedRemaining`); no reload can occur. On visible,
    `nextFireAt = now + pausedRemaining` and the countdown continues.
  - *Background mode:* on hidden, the content script hands the schedule to the
    worker (`or_bgArm`); the worker fires the reload via an alarm aligned to
    `nextFireAt`, updates the count (stopping at max → end session + clear
    badge/alarm), and arms the next cycle (a fresh random interval in random mode).
    On visible, the content script cancels the alarm (`or_bgCancel`) and resumes
    its own smooth per-second countdown + badge.
- **Everything belongs to the tab:** session, scroll target (`or_target_<tabId>`),
  and overlay position (`or_pos_<tabId>`) are keyed by **tab id** and tagged with
  the origin they were set on (and only applied on that origin). They survive
  reloads of the same tab; on `tabs.onRemoved` the worker wipes all of them (plus
  the badge and any alarm) and unregisters the per-origin content script if no
  other tab on that origin is still running.
- **Clean teardown:** on Stop / max-reached / tab-close, all timers, the scroll
  `MutationObserver`/poll/timeout, the visibility + focus + drag + storage
  listeners, and the overlay DOM are removed; the badge and any background alarm
  are cleared; and stored state + the per-site registration are released. The
  picker removes all of its capture-phase listeners and its DOM on select / Esc /
  completion.
- **Isolated UI:** both the overlay and the picker are built in a **Shadow DOM**,
  so page styles can't affect them and their styles can't leak into the page.

---

## Project structure

```
only_refresh/
├── manifest.json            # MV3 manifest (permissions, action, background)
├── src/
│   ├── common.js            # Shared pure helpers (units, formatting, keys, defaults)
│   ├── i18n.js              # Translation bundle (GENERATED — see tools/build_i18n.js)
│   ├── background.js        # Service worker: registration, hard/background reloads, alarms, badge, teardown
│   ├── content.js           # Countdown, overlay (Shadow DOM), visibility/pause handoff, badge, auto-scroll
│   ├── picker.js            # On-demand element picker (Shadow DOM eyedropper + selector), localized
│   ├── popup.html           # Popup markup (data-i18n attributes)
│   ├── popup.css            # Popup styling (dark theme)
│   └── popup.js             # Popup logic: settings, language, start/stop, status, picker control
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── tools/
│   ├── generate_icons.py    # Regenerates the icons (stdlib only; optional)
│   ├── build_i18n.js        # Builds src/i18n.js from tools/i18n/*.json
│   └── i18n/                # Per-language source strings (en, de, fr, es, zh, ja, ko, ru)
├── README.md
├── LICENSE                  # PolyForm Noncommercial 1.0.0
└── .gitignore
```

To add or edit translations, change `tools/i18n/<lang>.json` and regenerate:

```sh
node tools/build_i18n.js
```

To regenerate the icons after tweaking the design:

```sh
python tools/generate_icons.py
```

---

## License

**Only Refresh** is **source-available** software licensed under the
**PolyForm Noncommercial License 1.0.0** — free for noncommercial use only. The
source is public to read, modify, and share for any noncommercial purpose, but
commercial use is not permitted. The full text is in [LICENSE](LICENSE); the
canonical version is at
<https://polyformproject.org/licenses/noncommercial/1.0.0>.

Required Notice: Copyright 2026 Bulma1337

In short:

- **Free for noncommercial use** — personal, hobby, educational, research, and
  nonprofit use are all permitted. You may read, run, modify, and share the source
  for any noncommercial purpose.
- **Commercial use is not permitted** under this license.
- The software is provided **without warranty and without liability**, to the
  extent allowed by law.

Every source file carries an
`SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0` header (`manifest.json` has
none, since JSON has no comment syntax).
