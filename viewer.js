// This page is the whole point: it's an extension-owned page (not a normal
// website), which is what lets it call chrome.tabCapture directly and hold
// the resulting MediaStreams. The background service worker only tracks
// *which* tabs are being watched and which one is hot — all actual video
// lives here.

const HOT_CONSTRAINTS = { width: 1280, height: 720, frameRate: 30 };

// Thumbnails default to "low" to keep concurrent-decode load down — running
// several background captures at once is genuinely CPU/GPU-heavy, and on
// weaker devices that's the most likely cause of A/V drift (see
// resyncMainVideo() below). Higher presets are an explicit opt-in since they
// make that contention worse, not better.
const COLD_PRESETS = {
  low: { width: 320, height: 180, frameRate: 8 },
  medium: { width: 480, height: 270, frameRate: 15 },
  high: { width: 640, height: 360, frameRate: 30 },
};
let coldConstraints = COLD_PRESETS.low;

// tabId -> { tab, wrapper, video, connectingOverlay, liveBadge, stream|null,
//            capturing: a startCapture() call is in flight, isLive: null
//            (unknown) | true (live, never paused) | false (VOD, paused
//            while demoted), appliedHot: last hot/cold state we acted on,
//            userPaused: true once the user hits pause themselves, so an
//            auto-promote doesn't silently override it }
const entries = new Map();
let hotTabId = null;

const mainStage = document.getElementById("main-stage");
const thumbStrip = document.getElementById("thumb-strip");
const stage = document.getElementById("stage");
const thumbLayoutSelect = document.getElementById("thumb-layout-select");
const thumbQualitySelect = document.getElementById("thumb-quality-select");

const THUMB_LAYOUT_KEY = "multiwatch:thumbLayout";
function applyThumbLayout(mode) {
  stage.classList.remove("layout-below", "layout-overlay-bottom", "layout-overlay-left");
  stage.classList.add(`layout-${mode}`);
  try {
    localStorage.setItem(THUMB_LAYOUT_KEY, mode);
  } catch {
    // Private window or blocked storage — fine, just won't persist.
  }
}
thumbLayoutSelect.addEventListener("change", (e) => applyThumbLayout(e.target.value));
let savedThumbLayout = "below";
try {
  savedThumbLayout = localStorage.getItem(THUMB_LAYOUT_KEY) || "below";
} catch {
  // Ignore — default to "below".
}
thumbLayoutSelect.value = savedThumbLayout;
applyThumbLayout(savedThumbLayout);

const THUMB_QUALITY_KEY = "multiwatch:thumbQuality";
function applyThumbQuality(preset) {
  coldConstraints = COLD_PRESETS[preset] || COLD_PRESETS.low;
  try {
    localStorage.setItem(THUMB_QUALITY_KEY, preset);
  } catch {
    // Ignore — just won't persist.
  }
  // applyHotness() only re-applies constraints when a tile's hot/cold state
  // *changes* — a quality-setting change needs to push to every cold tile
  // immediately regardless of whether its hot state changed.
  for (const [tabId, entry] of entries) {
    if (tabId === hotTabId || !entry.stream) continue;
    entry.stream
      .getVideoTracks()[0]
      ?.applyConstraints(coldConstraints)
      .catch(() => {});
  }
}
thumbQualitySelect.addEventListener("change", (e) => applyThumbQuality(e.target.value));
let savedThumbQuality = "low";
try {
  savedThumbQuality = localStorage.getItem(THUMB_QUALITY_KEY) || "low";
} catch {
  // Ignore — default to "low".
}
thumbQualitySelect.value = savedThumbQuality;
applyThumbQuality(savedThumbQuality);

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function buildTile(tab) {
  const wrapper = document.createElement("div");
  wrapper.className = "tile";
  wrapper.dataset.tabId = String(tab.id);

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.disablePictureInPicture = true; // no PiP, including Chrome's automatic on-hide PiP
  wrapper.appendChild(video);

  // Set by renumberHotkeys() — shows which number key (1-9) jumps here.
  const hotkeyBadge = document.createElement("div");
  hotkeyBadge.className = "hotkey-badge hidden";
  wrapper.appendChild(hotkeyBadge);

  const label = document.createElement("div");
  label.className = "label";
  const favicon = document.createElement("img");
  favicon.src = tab.favIconUrl || "";
  favicon.onerror = () => (favicon.style.visibility = "hidden");
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = tab.title;
  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "✕";
  removeBtn.title = "Stop tracking this tab";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    untrackTab(tab.id);
  });
  const liveBadge = document.createElement("button");
  liveBadge.className = "live-badge";
  liveBadge.title = "Click to mark as Live (never paused) or VOD (paused while not in the main slot)";
  liveBadge.addEventListener("click", (e) => {
    e.stopPropagation();
    const entry = entries.get(tab.id);
    entry.isLive = entry.isLive === false ? true : false;
    updateLiveBadge(entry);
    syncPlayback(tab.id);
  });
  label.append(favicon, title, liveBadge, removeBtn);

  // Only shown/usable on the main (hot) tile — CSS hides this on thumbnails.
  const mainControls = document.createElement("div");
  mainControls.className = "main-controls";

  const playPauseBtn = document.createElement("button");
  playPauseBtn.className = "play-pause-btn";
  playPauseBtn.textContent = "⏸";
  playPauseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlayPause(tab.id);
  });
  video.addEventListener("play", () => (playPauseBtn.textContent = "⏸"));
  video.addEventListener("pause", () => (playPauseBtn.textContent = "▶"));

  const volumeSlider = document.createElement("input");
  volumeSlider.type = "range";
  volumeSlider.className = "volume-slider";
  volumeSlider.min = "0";
  volumeSlider.max = "1";
  volumeSlider.step = "0.01";
  volumeSlider.value = "1";
  volumeSlider.addEventListener("click", (e) => e.stopPropagation());
  volumeSlider.addEventListener("input", (e) => {
    video.volume = Number(e.target.value);
  });

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "fullscreen-btn";
  fullscreenBtn.textContent = "⛶";
  fullscreenBtn.title = "Fullscreen just this video";
  fullscreenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    video.requestFullscreen().catch((err) => console.error("requestFullscreen failed", err));
  });

  const resyncBtn = document.createElement("button");
  resyncBtn.className = "resync-btn";
  resyncBtn.textContent = "↻";
  resyncBtn.title = "Resync video if it's drifted behind the audio";
  resyncBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    resyncVideo(tab.id);
  });

  mainControls.append(playPauseBtn, volumeSlider, fullscreenBtn, resyncBtn);

  const overlayBottom = document.createElement("div");
  overlayBottom.className = "overlay-bottom";
  overlayBottom.append(mainControls, label);
  wrapper.appendChild(overlayBottom);

  // Capture starts automatically (see reconcile()) — this is just a status
  // overlay while that's in flight, and doubles as a manual retry if it
  // failed (e.g. hit the same gesture/permission requirement tabCapture
  // enforces — see startCapture()).
  const connectingOverlay = document.createElement("div");
  connectingOverlay.className = "connecting-overlay";
  connectingOverlay.textContent = "Connecting…";
  connectingOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
    startCapture(tab.id);
  });
  wrapper.appendChild(connectingOverlay);

  wrapper.addEventListener("click", () => {
    const entry = entries.get(tab.id);
    if (entry?.stream) promoteToHot(tab.id);
  });

  return { wrapper, video, connectingOverlay, liveBadge, hotkeyBadge };
}

// Pausing a VOD tile also pauses its real source tab (so playback position
// doesn't keep advancing); pausing a live tile only freezes the local view —
// the source is never touched, matching the never-pause-live policy.
function togglePlayPause(tabId) {
  const entry = entries.get(tabId);
  if (!entry) return;
  if (entry.video.paused) {
    entry.userPaused = false;
    entry.video.play().catch(() => {});
    if (entry.isLive === false) setTabPlayback(tabId, true);
  } else {
    entry.userPaused = true;
    entry.video.pause();
    if (entry.isLive === false) setTabPlayback(tabId, false);
  }
}

// Manual fix for audio/video drift: on a long-running live MediaStream,
// concurrent-decode load (several background captures at once) can cause
// the video pipeline to fall behind real time, with no automatic catch-up —
// browsers don't aggressively frame-drop a live MediaStream to re-sync it.
// Re-attaching srcObject drops any backlog and snaps the video back to the
// stream's current live frame. We can't reliably *detect* drift from JS
// (no clean way to compare audio vs. video presentation position across an
// arbitrary tabCapture stream), so this is a manual "fix it now" button
// rather than something automatic.
function resyncVideo(tabId) {
  const entry = entries.get(tabId);
  if (!entry || !entry.stream) return;
  const wasMuted = entry.video.muted;
  entry.video.srcObject = null;
  entry.video.srcObject = entry.stream;
  entry.video.muted = wasMuted;
  entry.video.play().catch(() => {});
}

function updateLiveBadge(entry) {
  if (entry.isLive === false) {
    entry.liveBadge.textContent = "VOD";
    entry.liveBadge.classList.add("vod");
  } else {
    entry.liveBadge.textContent = "LIVE";
    entry.liveBadge.classList.remove("vod");
  }
}

// VOD tabs get paused while demoted and resumed when promoted, since you can
// pick up a recording where you left off. Live tabs are left alone — they
// keep running in the background regardless of hot/cold state, since the
// whole point is to not miss anything live.
function setTabPlayback(tabId, shouldPlay) {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: (play) => {
        document.querySelectorAll("video").forEach((v) => (play ? v.play().catch(() => {}) : v.pause()));
      },
      args: [shouldPlay],
    })
    .catch((err) => console.error("setTabPlayback failed", err));
}

function syncPlayback(tabId) {
  const entry = entries.get(tabId);
  if (!entry || entry.isLive !== false) return;
  // Demoting always pauses; promoting only resumes if the user didn't
  // explicitly pause it themselves (a manual pause survives a swap away
  // and back, rather than being silently overridden).
  const shouldPlay = entry.appliedHot === true && !entry.userPaused;
  setTabPlayback(tabId, shouldPlay);
}

// Twitch (and likely other players) can auto-engage Picture-in-Picture on
// its own when it detects its tab isn't focused — which is always true here,
// since we deliberately never focus a tracked tab. This neutralizes it on
// the tracked tab itself: disables PiP on every <video> (including ones
// created later, e.g. on an ad/quality transition, via the observer) and
// force-exits anything that still manages to enter it. Run once per tab
// right after capture starts; the injected guard persists for that tab's
// page lifetime since it sets up its own observer/listener.
function disablePiPOnTab(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (window.__multiwatchPiPGuardInstalled) return;
        window.__multiwatchPiPGuardInstalled = true;

        const guard = (v) => {
          try {
            v.disablePictureInPicture = true;
          } catch {}
        };
        document.querySelectorAll("video").forEach(guard);

        new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeName === "VIDEO") guard(node);
              else if (node.querySelectorAll) node.querySelectorAll("video").forEach(guard);
            }
          }
        }).observe(document.documentElement, { childList: true, subtree: true });

        document.addEventListener(
          "enterpictureinpicture",
          () => {
            document.exitPictureInPicture().catch(() => {});
          },
          true
        );
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        }
      },
    })
    .catch((err) => console.error("disablePiPOnTab failed", err));
}

// Heuristic: an on-demand video reports a finite duration; a live stream
// typically reports Infinity/NaN. Defaults to "live" (never auto-paused)
// when undetectable, since that's the safer failure mode for this app's
// primary use case. The live-badge toggle lets the user correct it either way.
async function detectLive(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const v = document.querySelector("video");
        if (!v) return null;
        return !Number.isFinite(v.duration) || v.duration <= 0;
      },
    });
    const hit = results.find((r) => r.result !== null && r.result !== undefined);
    return hit ? hit.result : true;
  } catch (err) {
    console.error("live detection failed", err);
    return true;
  }
}

// Starts automatically as soon as a tab is tracked (see reconcile()) rather
// than waiting for a per-tile click — the earlier toolbar/context-menu click
// that tracked the tab already granted tabCapture's per-tab authorization,
// and that grant persists until the tab navigates, so no fresh gesture is
// needed here. If that assumption turns out wrong for some tab, the
// connecting-overlay click handler above provides a manual, gesture-backed
// retry as a fallback.
function startCapture(tabId) {
  const entry = entries.get(tabId);
  if (!entry || entry.stream || entry.capturing) return;
  entry.capturing = true;

  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      console.error("tabCapture failed", chrome.runtime.lastError);
      entry.capturing = false;
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      })
      .then((stream) => attachStream(tabId, stream))
      .catch((err) => {
        console.error("getUserMedia failed", err);
        entry.capturing = false;
      });
  });
}

async function attachStream(tabId, stream) {
  const entry = entries.get(tabId);
  if (!entry) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  entry.stream = stream;
  entry.capturing = false;
  entry.video.srcObject = stream;
  entry.connectingOverlay.classList.add("hidden");
  applyHotness();

  disablePiPOnTab(tabId);
  entry.isLive = await detectLive(tabId);
  updateLiveBadge(entry);
  syncPlayback(tabId);
}

function untrackTab(tabId) {
  const entry = entries.get(tabId);
  if (entry?.stream) entry.stream.getTracks().forEach((t) => t.stop());
  entries.delete(tabId);
  entry?.wrapper.remove();
  renumberHotkeys();
  sendMessage({ type: "REMOVE_TAB", tabId });
}

function promoteToHot(tabId) {
  sendMessage({ type: "SET_HOT", tabId });
  // Optimistic local update; STATE_CHANGED will confirm/correct it.
  hotTabId = tabId;
  applyHotness();
}

function applyHotness() {
  for (const [tabId, entry] of entries) {
    const isHot = tabId === hotTabId;
    const changed = entry.appliedHot !== isHot;
    entry.appliedHot = isHot;

    entry.video.muted = !isHot;
    (isHot ? mainStage : thumbStrip).appendChild(entry.wrapper);

    // Flipping .muted doesn't reliably resume playback under Chrome's
    // autoplay policy — an explicit .play() made synchronously within the
    // user's click is what actually works. Skip it if the user explicitly
    // paused this tile themselves (see syncPlayback for the source-tab side
    // of that same rule).
    if (isHot && changed && !entry.userPaused) {
      entry.video.play().catch(() => {});
    }

    if (entry.stream) {
      const track = entry.stream.getVideoTracks()[0];
      track?.applyConstraints(isHot ? HOT_CONSTRAINTS : coldConstraints).catch(() => {
        // Best-effort — some tab sources ignore constraint changes mid-stream.
      });
    }

    if (changed) syncPlayback(tabId);
  }
  renderEmptyState();
}

function renderEmptyState() {
  const hasAny = entries.size > 0;
  let empty = mainStage.querySelector(".empty-state");
  if (!hasAny && !empty) {
    empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      'No tracked tabs yet — switch to a tab and click the toolbar icon, or right-click it and choose "Track this tab in Multiwatch."';
    mainStage.appendChild(empty);
  } else if (hasAny && empty) {
    empty.remove();
  }
}

async function reconcile(state) {
  hotTabId = state.hotTabId;

  // Remove tiles for tabs no longer tracked.
  for (const tabId of [...entries.keys()]) {
    if (!state.trackedTabs.some((t) => t.id === tabId)) {
      const entry = entries.get(tabId);
      entry?.stream?.getTracks().forEach((t) => t.stop());
      entry?.wrapper.remove();
      entries.delete(tabId);
    }
  }

  // Add tiles for newly tracked tabs, and start capturing immediately so
  // media is already live by the time you click a thumbnail to swap to it.
  for (const tab of state.trackedTabs) {
    if (entries.has(tab.id)) continue;
    const { wrapper, video, connectingOverlay, liveBadge, hotkeyBadge } = buildTile(tab);
    const entry = {
      tab,
      wrapper,
      video,
      connectingOverlay,
      liveBadge,
      hotkeyBadge,
      stream: null,
      capturing: false,
      isLive: null,
      appliedHot: undefined,
      userPaused: false,
    };
    entries.set(tab.id, entry);
    updateLiveBadge(entry);
    (tab.id === hotTabId ? mainStage : thumbStrip).appendChild(wrapper);
    startCapture(tab.id);
  }

  renumberHotkeys();
  applyHotness();
}

// Assigns 1-9 to tracked tabs in track order (stable per-tab "channel
// numbers", not tied to which one is currently hot) and labels each tile.
// Tabs beyond the 9th simply get no hotkey — there's no 10th digit key by
// convention here.
const hotkeyOrder = [];
function renumberHotkeys() {
  hotkeyOrder.length = 0;
  hotkeyOrder.push(...entries.keys());
  for (const [tabId, entry] of entries) {
    const slot = hotkeyOrder.indexOf(tabId);
    if (slot >= 0 && slot < 9) {
      entry.hotkeyBadge.textContent = String(slot + 1);
      entry.hotkeyBadge.classList.remove("hidden");
    } else {
      entry.hotkeyBadge.classList.add("hidden");
    }
  }
}

function isTypingTarget(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return; // don't fight browser/OS shortcuts
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  if (!/^[1-9]$/.test(e.key)) return;

  const tabId = hotkeyOrder[Number(e.key) - 1];
  const entry = tabId !== undefined ? entries.get(tabId) : undefined;
  if (entry?.stream) {
    e.preventDefault();
    promoteToHot(tabId);
  }
});

async function refreshFromBackground() {
  const state = await sendMessage({ type: "GET_STATE" });
  await reconcile(state);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_CHANGED") {
    reconcile(message.state);
  }
});

refreshFromBackground();
