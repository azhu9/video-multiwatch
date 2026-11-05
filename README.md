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
- **Main-view controls**: the main (hot) tile has a play/pause button, a
  volume slider, and a fullscreen button — hidden on thumbnails. Play/pause
  on a VOD tile also pauses/resumes its real source tab (same mechanism as
  the auto pause-on-demote above); on a live tile it only freezes/resumes
  your local view, since the source is never touched. A manual pause
  survives being swapped away and back — it's not silently overridden by
  the auto-resume-on-promote behavior. Fullscreen calls
  `video.requestFullscreen()` on the `<video>` element itself rather than
  the page, so it shows just the media (scaled/letterboxed to fit), not the
  rest of the viewer UI.
- **Layout**: the main video fills the full stage (no more hard-coded
  `max-width`); a **Thumbnails** dropdown in the toolbar switches the
  thumbnail strip between **Below** (its own row), **Overlay bottom**, and
  **Overlay left** — the overlay modes float thumbnails over the main
  video's own letterboxed black space instead of reserving dedicated
  layout space for them, so the video gets the full stage either way. The
  choice persists via `localStorage`. Note: with a very wide/short window
  and 16:9 content, `object-fit: contain` will still letterbox left/right
  no matter what — that's a consequence of preserving aspect ratio without
  cropping, not something layout space alone can fix. **Every tile's title
  bar** (favicon/title/LIVE-VOD badge/split/remove, plus the main view's
  play/pause/volume/fullscreen bar) is hover-revealed — hidden until you
  hover that tile — so a thumbnail's title doesn't sit permanently over
  part of the preview, and an overlaid thumbnail strip doesn't have to
  fight it for the same space. The overlay modes have no background behind
  the strip — each thumbnail tile already has its own opaque background,
  so a strip-level background was just extra dimming/a solid box nobody
  asked for. (An earlier version only removed the *gradient* override and
  left `#thumb-strip`'s own solid black background showing through
  underneath — a real bug, now actually fixed with an explicit
  `background: none`.)
- **Thumbnail quality** is a toolbar dropdown (Low/Medium/High —
  resolution+framerate presets, Low = 320×180@8fps default, High =
  640×360@30fps), persisted via `localStorage`. Defaults to Low on
  purpose: running several background captures at once is genuinely
  CPU/GPU-heavy, and that contention is the most likely cause of A/V
  drift on weaker devices (see the resync button below) — cranking this
  up is an explicit opt-in, not a free smoothness win.
- **Manual resync button** (↻, next to fullscreen on the main view) for
  audio/video drift. On a long-running live `MediaStream`, concurrent
  decode load can make the video pipeline fall behind real time with no
  automatic catch-up — browsers don't aggressively frame-drop a live
  stream to re-sync it. The button re-attaches `srcObject`, which drops
  any buffered backlog and snaps the video back to the stream's current
  live frame. This is deliberately a manual fix rather than automatic:
  there's no clean way to detect drift from JS (no way to compare audio
  vs. video presentation position across an arbitrary `tabCapture`
  stream), so if you notice lag, click it; if drift keeps recurring,
  lowering thumbnail quality (above) or the number of concurrently
  tracked tabs is the more durable fix, since the root cause is almost
  always resource contention on that specific device, not something this
  button can address at its source.
- **Number-key hotkeys**: press `1`-`9` anywhere in the viewer to jump
  straight to that tracked tab's slot, shown as a small number badge in
  each tile's top-left corner. Slots are assigned by **track order**
  (first tab tracked is always `1`, etc.) and stay stable regardless of
  which tile is currently hot — think channel numbers, not "current
  position in the thumbnail strip." Only works once a tile's stream has
  attached (same "Connecting…" gate as clicking it), and is ignored while
  a dropdown/input has focus or a modifier key (Ctrl/Alt/Cmd/Shift) is
  held, so it doesn't fight the browser's own shortcuts. Tabs beyond the
  9th don't get a hotkey. `ArrowRight`/`ArrowLeft` cycle audio focus to the
  next/previous tab in that same order, wrapping around and skipping
  anything not attached yet. Hotkey slots are fixed at track order and
  aren't currently reorderable — an earlier drag-to-reorder feature was
  removed because making every tile `draggable` interfered with dragging
  the volume slider's `<input type="range">` thumb inside it.
- **Split view**: click the ⧉ button on a thumbnail (next to the LIVE/VOD
  badge — appears on hover, same as the rest of the title bar) to also
  show it large alongside the audio-focused tile, side by side, instead of
  only ever showing one tile at a time. Shift+click a thumbnail does the
  same thing, as a shortcut. The split tile stays muted (there's still
  only one audio source) but gets full `HOT_CONSTRAINTS` quality like the
  main tile, and a VOD split tile won't auto-pause just for not being the
  audio-focused one — being visibly shown is what matters for that, not
  which one has sound. **Plain-clicking either of the two tiles shown in
  split mode swaps audio focus between them** — both stay visible side by
  side, only who has sound changes. Only the dedicated ⧉ button (now
  highlighted blue on the split tile) or shift+clicking a different
  thumbnail actually exits split. The split tile itself is marked with a
  blue outline. (An earlier version routed every plain click through
  `promoteToHot()` unconditionally, which left `splitTabId` stuck pointing
  at a tile that had just also become hot — `#main-stage` kept its 2-up
  split layout with only one tile left in it, rendering centered and
  half-width instead of back to normal. `promoteToHot()` now detects
  clicking the current split partner and swaps roles instead.)
- **Stale-capture detection**: a navigation on a tracked tab invalidates
  `tabCapture`'s per-tab grant for it — the capture just dies. Previously
  this left a frozen/stale frame with no indication anything was wrong.
  Now `background.js` watches `chrome.tabs.onUpdated` for a real
  navigation (`changeInfo.url` is only set on one) on a tracked tab and
  tells the viewer immediately; separately, every stream's tracks also get
  an `ended` listener as a catch-all for any other way a capture can die
  (crash, an unexpected grant lapse). Either path shows a "Capture lost —
  click to retry" overlay. Retrying works again automatically if the
  underlying grant is actually still intact; for a real navigation it
  isn't, and you'll need to switch to that tab and re-invoke the toolbar
  icon/context menu, same as tracking it the first time.
- **Tracked tabs are marked non-discardable**
  (`chrome.tabs.update({autoDiscardable: false})`). Chrome can discard a
  backgrounded tab under memory pressure to free RAM — exactly the state
  every tracked tab sits in — which would silently kill its capture. This
  trades a bit more memory pressure for not losing a stream you're
  actively watching. Reverted back to discardable when a tab is untracked.
- **No Picture-in-Picture, on either side.** Our own viewer `<video>`
  elements set `disablePictureInPicture`. Separately, a tracked site's
  *own* player can auto-engage PiP on its source tab once it detects it
  isn't focused (which it never is here, by design) — some players treat a
  backgrounded tab as "user stepped away, offer PiP as a courtesy."
  `disablePiPOnTab()` neutralizes that directly on the tracked tab: it
  disables PiP on every `<video>` there (including ones created later, via
  a `MutationObserver`, since some players swap/recreate their video
  element) and force-exits anything that still manages to enter PiP. Runs
  once per tab right after capture starts.
- **Capture starts automatically**: as soon as a tab is tracked, it starts
  capturing immediately — there's no more per-tile "Start capture" click.
  This relies on the toolbar/context-menu click that tracked the tab having
  already granted `tabCapture`'s per-tab authorization (which persists
  until that tab navigates), so no fresh gesture should be needed for the
  capture call itself. Each tile shows a "Connecting…" overlay until its
  stream attaches; clicking it manually retries, which doubles as a
  fallback gesture-backed trigger if the automatic attempt ever hits a
  permission wall the toolbar click didn't already clear.
- **Untracking pauses the source tab.** Stopping our capture of a tab
  restores its native audio output (tab-audio capture mutes the source
  while active), so without an explicit pause, removing a tracked tab used
  to leave it quietly playing — then audibly playing — in the background.
  `untrackTab()` now pauses the real source video first, regardless of
  live/VOD: the point here isn't preserving a resume position, it's "I'm
  done watching this." This didn't actually take effect in practice at
  first: the pause call (`chrome.scripting.executeScript`, async) was
  fired without waiting for it, immediately followed by synchronously
  stopping the capture session on the very next line — a real race that
  could invalidate whatever grant the scripting call needs before it
  finishes, silently dropping the pause. `untrackTab()` now `await`s it
  before tearing down the capture.

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
4. Each newly tracked tab starts capturing automatically — you'll see a
   brief "Connecting…" overlay until its stream attaches.
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

- **DRM-protected content (Netflix, Disney+, Hulu, Max, Prime Video, etc.)
  cannot be captured — this is a hard limit, not a bug.** Chrome applies an
  output-protection flag to EME/Widevine-protected video at the
  browser/compositor level; `tabCapture` of such a tab returns black frames
  by design, before any extension code runs. There is no workaround at this
  layer, and circumventing it would cross into DMCA anti-circumvention
  territory, so this isn't something to try to route around. Twitch and
  regular (non-Premium-exclusive) YouTube aren't DRM-protected and work
  fine.
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
the viewer tab's DevTools console for errors.

One specific thing worth watching for after this change: capture now starts
automatically rather than from a button click, on the assumption that
`tabCapture`'s per-tab grant (established by the earlier toolbar/
context-menu click) persists without needing a *fresh* gesture for the
`getMediaStreamId` call itself. If that assumption is wrong for some reason,
tiles will sit on "Connecting…" and the service worker/viewer console will
show the same `tabCapture failed` error as before — in that case, clicking
the "Connecting…" overlay manually retries with a real click, which should
still work as a fallback.
