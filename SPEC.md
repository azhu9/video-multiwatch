# Multiwatch — Project Spec & Feasibility

## 1. What this is

A browser-based control surface that lets you watch several live video streams
(e.g. sports broadcasts or livestreams) at once:

- One **main feed** with audio.
- N **thumbnail feeds** below it, muted, updating live.
- Click a thumbnail to swap it into the main slot (and the outgoing main feed
  drops to a muted thumbnail).
- Later: **auto-switching** — when an external ad-detector says the current
  main feed has cut to commercial, automatically promote a thumbnail that is
  currently showing live action.

The ad-detector is a separate sub-project already in progress (per-stream CNN
classifier served over HTTP/WebSocket as `{state, confidence, ...}`). This
spec treats it as an external dependency with a stable interface and focuses
on the multiwatch app itself: how to get N third-party video feeds on screen
simultaneously, control their audio/visibility, and act on state changes.

## 2. Overall feasibility

**Manual multi-view + click-to-swap: high feasibility, days not weeks.**
This part is standard browser/extension engineering with no open research
questions.

**Auto-switching driven by the ad detector: moderate feasibility, the real
work is in the ad detector project, not here.** Once a stream exposes a
`/state` websocket, reacting to it in the UI is trivial. The hard parts
(per-network model generalization, false positives, latency) already live in
that sub-project.

**The one genuine risk to the whole plan is ingestion**, not the UI: many
streaming sites are not built to be embedded, scraped, or frame-captured
by a third party. That risk is discussed in detail in §4 and drives most of
the architecture below.

## 3. Why this can't be "just an iframe grid"

The naive design — a single web page with N `<iframe>`s or `<video>` tags
pointed at each stream — will not work reliably against many streaming
sites, for a few concrete reasons:

1. **Frame-busting / `X-Frame-Options` / CSP `frame-ancestors`.** Many
   streaming (especially ad-supported) sites block being embedded in an
   iframe on another origin. Even where the video player itself isn't
   blocked, the surrounding page usually is.
2. **Popunders / redirect ads.** These sites monetize via aggressive
   pop-unders, redirect ads, and fake "play" buttons layered over the real
   player. An iframe embed inherits all of that inside your app, and much of
   it is specifically designed to escape iframe sandboxing (`window.open`,
   `target=_blank` spam, etc.).
3. **DRM/CORS on the actual video element.** Even when the page loads, you
   generally cannot reach into another origin's `<video>` element to read
   its pixels (canvas becomes "tainted" cross-origin), which matters both
   for building your own thumbnail compositor and for feeding frames to the
   ad-detector CNN.
4. **No control over audio muting from outside.** You can't reliably force-
   mute a `<video>` element that lives inside a cross-origin iframe you
   don't control; the site's own player UI (and its ads) may fight you.

**Conclusion:** the individual streams need to be full, real browser tabs —
not embedded content in your app. Your app is a *coordinator/compositor*
around real tabs, not a page that embeds other pages.

## 4. Architecture

### 4.1 Chrome extension (MV3) as the coordinator

This has to be a browser extension, not a plain web app, because only an
extension has the permissions to:

- Open/track multiple tabs (one per stream site).
- Mute/unmute a specific tab's audio (`chrome.tabs.update({ muted })`) —
  this is the built-in, reliable way to get "only the main feed has sound"
  without fighting the site's own player.
- Capture frames from a background tab for the thumbnail grid and for the
  ad-detector, via `chrome.tabCapture` (or, more cheaply, periodic
  `chrome.tabs.captureVisibleTab` if the tab is visible, or an injected
  content-script `<canvas>` grab of the page's own `<video>` element when
  same-tab access is allowed).
- Survive the popunder/redirect problem by pinning tabs, blocking
  `window.open`/new-tab spawns from content scripts, and optionally layering
  in an ad-blocking ruleset (`declarativeNetRequest`) scoped to the tracked
  tabs.

The extension owns: tab lifecycle for tracked streams, audio muting, frame
capture, and relaying frames/state to the main app UI.

### 4.2 Control UI (the "main window")

A small local web app (could be an extension side panel / new-tab-override,
or a regular page the extension has elevated messaging access to) that
renders:

- Main video slot (large, unmuted) — showing the live-captured feed for
  whichever stream is currently "hot."
- Thumbnail strip (small, muted, low frame rate) for every other tracked
  stream.
- Click-to-swap interaction, which is just a state change (`hot_stream_id`)
  broadcast to the extension, which then flips muting and which capture
  feed is rendered large vs. small.

Two ways to actually render "the video" in this UI, in increasing order of
fidelity vs. cost:

- **A. Captured-frame compositor (recommended MVP):** the extension pushes
  periodic frames (canvas ImageBitmap → JPEG, e.g. 5–10 fps for the main
  slot, 0.5–1 fps for thumbnails) over `chrome.runtime` messaging or a local
  WebSocket into the control UI, which just draws them to canvases. This is
  exactly the same frame pipeline the ad-detector already needs, so it can
  be shared — one capture, two consumers (display + classifier).
- **B. Real tab switching (better fidelity, more fragile):** instead of a
  compositor, the "main slot" is literally the real browser tab brought to
  the foreground/resized into a window position (via `chrome.windows`
  arrange, e.g. a 2x2 tiled window layout), and thumbnails are periodic
  screenshots. This gives full native video quality/perf for the main feed
  at the cost of a clunkier window-management UX and no true simultaneous
  live thumbnails (they're snapshots, refreshed on an interval).

Recommendation: start with A. It unifies with the ad-detector's existing
frame-capture design, gives you real live (if lower-fps) thumbnails, and
keeps everything inside one page instead of juggling OS window geometry.

### 4.3 Ad-detector integration

Per the other sub-project: each tracked stream gets its own detector
instance (either its own process/port, or — better, once you have more than
2–3 concurrent streams — a single multiplexed API with `/state/{stream_id}`
and `/ws/{stream_id}`, sharing one thread pool and avoiding N loaded-model
processes).

The multiwatch control UI subscribes to every tracked stream's websocket and
maintains a small state machine:

```
per stream: { live | ad_break, confidence, last_change_at }
global: hot_stream_id, auto_switch_enabled
```

Auto-switch policy (the "new territory" the other project's summary flags)
is genuinely this project's design problem, not the detector's:

- Trigger: hot stream flips to `ad_break` (with hysteresis/confidence
  threshold to avoid flapping on a noisy prediction).
- Candidate selection: among other tracked streams currently `live`, pick
  one — simplest policy is "most recently live" or round-robin; smarter
  policies could weight by confidence or by a user-set priority order of
  games.
- Tie-break: if *all* streams are on break simultaneously (common — same ad
  slot across networks), stay put or fall back to a fixed default rather
  than thrashing.
- Always allow manual override to immediately win over auto-switch, with a
  short cooldown before auto-switch can act again (so it doesn't immediately
  switch you back).

This is a small, testable piece of client-side logic once the state feed
exists — the spec doesn't need to over-design it now.

### 4.4 Frame capture → ad detector transport

Since the extension is already capturing frames for the thumbnail
compositor (§4.2A), the same frames get POSTed (or pushed over a persistent
WebSocket) to the local ad-detector backend per stream, exactly as
described in the other project's write-up ("extension grabs a frame from a
tab's canvas/video element periodically, POSTs it to the backend"). No
separate capture pipeline needed — one capture, two consumers.

## 5. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Stream coordination | Chrome extension, Manifest V3 | Only way to get tab audio control, tab capture, popunder suppression |
| Extension background | Service worker (MV3) + `chrome.tabs`, `chrome.tabCapture`, `chrome.declarativeNetRequest` | Standard MV3 APIs for exactly these jobs |
| Control UI | Extension side panel or dedicated tab, plain web app (React or Svelte, or no framework at all given how small the UI is) | Grid of canvases + click handlers; doesn't need much framework weight |
| Frame transport (extension → UI, extension → detector) | `chrome.runtime` messaging within the extension; WebSocket to local backend for the detector | Matches what the detector project already expects |
| Ad-detector backend | Existing FastAPI-style service (`05_api.py`), refactored to multi-stream (`/state/{id}`, `/ws/{id}`) | Already built in the sibling project |
| State sync in UI | Simple client-side store (a few `useState`/small store, no need for Redux-scale tooling) subscribing to N websockets | Small state surface: per-stream status + hot_stream_id |
| Packaging | Unpacked extension for personal use; Chrome Web Store only if ever distributed (not needed for personal use) | Avoids store review entirely for a personal tool |

Nothing here requires exotic technology — it's a standard MV3 extension plus
a small SPA, talking to a Python detector backend you're already building.

## 6. Key risks / unknowns (ranked)

1. **Site hostility (popunders, anti-embedding, layout changes).** This is
   the dominant risk to reliability, not the video/audio plumbing. Buff-
   streams-style sites change domains and layouts often; expect ongoing
   maintenance of selectors/blocking rules, not a "build once" component.
2. **Performance at N streams.** Capturing frames from several background
   tabs continuously (even at low fps) is CPU/GPU and memory-non-trivial in
   Chrome, on top of N real video decoders running. Practical N is probably
   single digits (4–8) on a normal desktop before things degrade; worth
   load-testing early rather than assuming it scales.
3. **Autoplay/audio policy edge cases.** Muted playback is exempt from
   Chrome's autoplay restrictions, so background tabs should autoplay fine
   muted; unmuting on swap-to-main generally requires it to already be
   playing (which it will be) — low risk, but verify per-site since some
   players re-check `document.hasFocus()`-style heuristics.
4. **Ad-detector accuracy/latency at the boundary.** A false "ad_break" on
   the hot stream causes a jarring unwanted switch; this is inherited risk
   from the sibling project, mitigated in this project via confidence
   thresholds + hysteresis before acting on a state change.
5. **Legal/ToS exposure of the source sites.** Out of scope for this spec
   technically, but worth flagging: this is a personal-use tool built
   against sites whose own legality/ToS you don't control, and their
   instability (domain changes, aggressive ad networks) is a maintenance
   cost, not a one-time integration cost.

## 7. Phased build plan

**Phase 0 — Manual multi-view (no detector yet)**
- MV3 extension: open/track N tabs, mute all but one, arrange as tiled
  windows or capture-to-thumbnail.
- Control UI: main slot + thumbnail strip, click-to-swap.
- Success criterion: watch 3–4 real games in one browser session, swap by
  click, only one has audio at a time.

**Phase 1 — Shared frame pipeline**
- Extension captures frames on an interval for both the thumbnail
  compositor and (stubbed) detector POSTs.
- Success criterion: thumbnails update live at ~1fps without killing CPU;
  frame POSTs land at the detector's existing `/predict`-equivalent path.

**Phase 2 — Detector integration (state, no auto-switch yet)**
- Multi-stream detector API (`/state/{id}`, `/ws/{id}`) per sibling
  project's plan.
- Control UI subscribes to all stream websockets, shows live/ad badges on
  each thumbnail (still manual switching).
- Success criterion: badges correctly track real ad breaks during a live
  test game, with acceptable latency.

**Phase 3 — Auto-switch**
- Implement the trigger/candidate/tie-break/cooldown policy from §4.3.
- Manual override always wins; auto-switch resumes after cooldown.
- Success criterion: during a live multi-game watch session, the tool
  correctly surfaces a live game when the current one cuts to ads, without
  visible flapping.

**Phase 4 — Hardening**
- Popunder/ad-network suppression rules, tab-crash/reload recovery,
  per-site adapters if a given streaming site's DOM/player structure
  needs tweaks for frame capture or mute control.

## 8. Bottom line

- The multi-view + manual-swap product (what's asked for first) is
  straightforward: a Chrome extension for tab/audio control plus a small
  control-UI page. No blocking unknowns.
- The auto-switch feature is straightforward *given* the ad detector's
  `/state` interface — the interesting problems there already live in the
  sibling project, not here.
- The one piece genuinely worth prototyping early, before investing in UI
  polish, is **frame capture from N background tabs at acceptable
  performance** — that's the shared bottleneck for thumbnails, the
  detector feed, and how far N can scale.
