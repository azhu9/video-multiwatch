// This page is the whole point: it's an extension-owned page (not a normal
// website), which is what lets it call chrome.tabCapture directly and hold
// the resulting MediaStreams. The background service worker only tracks
// *which* tabs are being watched and which one is hot — all actual video
// lives here.

const HOT_CONSTRAINTS = { width: 1280, height: 720, frameRate: 30 };
const COLD_CONSTRAINTS = { width: 320, height: 180, frameRate: 8 };

const mainStage = document.getElementById("main-stage");
const thumbStrip = document.getElementById("thumb-strip");

// tabId -> { tab, wrapper, video, startOverlay, liveBadge, stream|null,
//            isLive: null (unknown) | true (live, never paused) | false (VOD,
//            paused while demoted), appliedHot: last hot/cold state we acted
//            on, userPaused: true once the user hits pause themselves, so an
//            auto-promote doesn't silently override it }
const entries = new Map();
let hotTabId = null;

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
  wrapper.appendChild(video);

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

  mainControls.append(playPauseBtn, volumeSlider, fullscreenBtn);

  const overlayBottom = document.createElement("div");
  overlayBottom.className = "overlay-bottom";
  overlayBottom.append(mainControls, label);
  wrapper.appendChild(overlayBottom);

  const startOverlay = document.createElement("div");
  startOverlay.className = "start-overlay";
  const startBtn = document.createElement("button");
  startBtn.textContent = "Start capture";
  startBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startCapture(tab.id); // called synchronously from the click handler —
    // tabCapture.getMediaStreamId requires an active user gesture.
  });
  startOverlay.appendChild(startBtn);
  wrapper.appendChild(startOverlay);

  wrapper.addEventListener("click", () => {
    const entry = entries.get(tab.id);
    if (entry?.stream) promoteToHot(tab.id);
  });

  return { wrapper, video, startOverlay, liveBadge };
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

function startCapture(tabId) {
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      console.error("tabCapture failed", chrome.runtime.lastError);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      })
      .then((stream) => attachStream(tabId, stream))
      .catch((err) => console.error("getUserMedia failed", err));
  });
}

async function attachStream(tabId, stream) {
  const entry = entries.get(tabId);
  if (!entry) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  entry.stream = stream;
  entry.video.srcObject = stream;
  entry.startOverlay.classList.add("hidden");
  applyHotness();

  entry.isLive = await detectLive(tabId);
  updateLiveBadge(entry);
  syncPlayback(tabId);
}

function untrackTab(tabId) {
  const entry = entries.get(tabId);
  if (entry?.stream) entry.stream.getTracks().forEach((t) => t.stop());
  entries.delete(tabId);
  entry?.wrapper.remove();
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
      track?.applyConstraints(isHot ? HOT_CONSTRAINTS : COLD_CONSTRAINTS).catch(() => {
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

  // Add tiles for newly tracked tabs.
  for (const tab of state.trackedTabs) {
    if (entries.has(tab.id)) continue;
    const { wrapper, video, startOverlay, liveBadge } = buildTile(tab);
    const entry = {
      tab,
      wrapper,
      video,
      startOverlay,
      liveBadge,
      stream: null,
      isLive: null,
      appliedHot: undefined,
      userPaused: false,
    };
    entries.set(tab.id, entry);
    updateLiveBadge(entry);
    (tab.id === hotTabId ? mainStage : thumbStrip).appendChild(wrapper);
  }

  applyHotness();
}

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
