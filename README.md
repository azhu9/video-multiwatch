# Multiwatch

A Chrome extension (Manifest V3) for watching several live video tabs at
once: one "hot" feed with audio, others as muted live thumbnails, click any
thumbnail to swap it into the main slot.

See `SPEC.md` for the full feasibility writeup and architecture rationale.

## How it works

- **`background.js`** (service worker): tracks which tabs are being watched
  and which one is "hot." Persists to `chrome.storage.session` so it
  survives service-worker restarts. Never touches video itself.
- **`viewer.html` / `viewer.js`**: an extension-owned page you open as a
  regular tab. This is where the actual video lives — it calls
  `chrome.tabCapture` directly to pull a continuous `MediaStream` from each
  tracked tab (this only works from an extension-origin page, which is why
  the UI can't be a normal website). The hot tab's stream plays at full
  quality with audio; all others are muted and constrained down to a low
  resolution/framerate to save CPU, via `MediaStreamTrack.applyConstraints`.
  Swapping which tab is hot just flips those constraints/mute flags and
  moves the existing `<video>` element in the DOM — no stream is torn down
  or restarted, so swaps are instant.

## Loading it (unpacked, for personal use)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this repo's folder.
3. Open a tab you want to track (e.g. a live stream), then click the
   Multiwatch toolbar icon — this tracks that tab and opens/focuses the
   viewer tab.
4. In the viewer tab, click **"+ Add tracked tab"** to track additional
   already-open tabs from a picker.
5. Each newly tracked tab shows a **"Start capture"** overlay — click it
   once per tab. This is required: `chrome.tabCapture` only allows starting
   capture on a tab as the direct result of a user gesture, so it can't be
   done automatically on load.
6. Click any thumbnail to swap it into the main slot.

## Known limitations / not yet built

These are called out in `SPEC.md`'s phased plan and intentionally left for
later:

- **No ad-break auto-switching yet** — that depends on the separate
  ad-detector project's `/state` API, which isn't wired in.
- **No in-page ad-overlay blocking** — `tabCapture` captures the whole
  rendered tab, so any banner/overlay ads baked into a tracked site's page
  will show up in its feed. A `declarativeNetRequest` ruleset scoped to
  tracked tabs is the planned fix.
- **No autoplay-nudge script** — some sites require clicking their own
  custom play button before video starts; for now that's a manual step per
  tracked tab.
- **Multi-window/tab-group scoping** isn't handled — tracking assumes tabs
  across the current browser session generally, not scoped to one window.

## Status

This is freshly scaffolded and has **not yet been run against a live
Chrome browser** in this environment — there was no way to load an unpacked
extension and exercise real `chrome.tabCapture` against a live video tab
here. Load it per the steps above and check the extension's service worker
console and the viewer tab's DevTools console for errors; the most likely
rough edges are the exact `getUserMedia` constraint shape for
`chromeMediaSource: "tab"` and whether `applyConstraints` is honored
mid-stream by tab-capture tracks (both are called out in `SPEC.md` as
worth prototyping early).
