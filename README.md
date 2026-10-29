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
- **Live vs. VOD playback**: each tile has a **LIVE/VOD** badge (click to
  toggle). VOD tabs get their actual source-tab `<video>` paused when
  demoted to a thumbnail and resumed when promoted back — so an on-demand
  video doesn't keep playing (and getting ahead of where you left off)
  while you're not watching it. LIVE tabs are left alone and keep running
  in the background regardless of hot/cold state, since the point is to
  not miss anything live. This is auto-detected on first capture (a
  finite `video.duration` implies VOD, `Infinity`/`NaN` implies live) but
  defaults to LIVE when undetectable, and can always be corrected with the
  badge. Implemented via `chrome.scripting.executeScript` calling
  `.play()`/`.pause()` on the tracked tab's own `<video>` element(s) —
  distinct from the muting used for audio control, since muting doesn't
  stop playback progress.

## Loading it (unpacked, for personal use)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this repo's folder.
3. For each stream you want to track: switch to that tab, then either click
   the Multiwatch toolbar icon or right-click the page and choose
   **"Track this tab in Multiwatch."** This opens/focuses the viewer tab and
   adds the tab to it.
   - This step matters more than it looks: `chrome.tabCapture` will only
     capture a tab the extension has been "invoked" on via one of these two
     gestures (this is `activeTab`-style, Chrome-enforced, and not
     something the extension can work around — there's no way to
     batch-track a list of already-open tabs you never explicitly invoked
     the extension on).
4. Each newly tracked tab shows a **"Start capture"** overlay in the viewer
   — click it once per tab to begin the actual `tabCapture` stream.
5. Click any thumbnail to swap it into the main slot.

## Testing

`test/smoke.mjs` is a Playwright-driven regression test for the tab-tracking
and click-to-swap DOM mechanics (tile rendering, mute-flag flipping,
promotion/demotion). Run it with:

```sh
npm install
npm test
```

It intentionally can't verify a real `chrome.tabCapture` success end-to-end
— that requires an actual user gesture on real browser UI (the toolbar icon
or the context-menu item), which no automated test can produce. It confirms
that path fails with the expected permission error rather than crashing, and
separately verifies the swap mechanics by attaching a fake local
`canvas.captureStream()` stream through the same code path real captures
use. Loading the extension in a real browser and clicking through the flow
above is still required to confirm real capture actually works end to end.

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

This has been run and smoke-tested against a real Chromium instance
(headed, via Playwright) in this environment, which caught and fixed a real
bug: an earlier version let you add any already-open tab to track from a
picker inside the viewer, but `chrome.tabCapture` silently refuses to
capture a tab the extension was never "invoked" on — so that picker could
never have worked. It's been replaced with the toolbar-icon/context-menu
flow described above, which is what actually satisfies Chrome's per-tab
capture grant.

What's confirmed working: the extension loads cleanly under Manifest V3,
tab tracking/removal, the click-to-swap DOM/mute mechanics, and the
LIVE/VOD pause-on-demote logic all behave correctly (see `test/smoke.mjs`).
The latter is verified by stubbing `chrome.scripting.executeScript` to
record calls, since it hits the same real-gesture permission wall as
`tabCapture` in an automated harness — so it confirms *our* decision logic
(when we choose to pause/resume), not that Chrome will actually grant the
script injection end-to-end.

What's still unverified, because it requires a real user click on real
browser UI that no automated test here can produce: that the
toolbar-icon/context-menu invocation actually grants `tabCapture` access
end-to-end, and the actual video quality/smoothness of the resulting
stream. Load it per the steps above and check both the extension's service
worker console (`chrome://extensions` → Multiwatch → "service worker") and
the viewer tab's DevTools console for errors. The most likely remaining
rough edges are the exact `getUserMedia` constraint shape for
`chromeMediaSource: "tab"` and whether `applyConstraints` is honored
mid-stream by tab-capture tracks.
