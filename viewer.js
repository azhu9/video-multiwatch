// This page is the whole point: it's an extension-owned page (not a normal
// website), which is what lets it call chrome.tabCapture directly and hold
// the resulting MediaStreams. The background service worker only tracks
// *which* tabs are being watched and which one is hot — all actual video
// lives here.

const HOT_CONSTRAINTS = { width: 1280, height: 720, frameRate: 30 };
const COLD_CONSTRAINTS = { width: 320, height: 180, frameRate: 8 };

const mainStage = document.getElementById("main-stage");
const thumbStrip = document.getElementById("thumb-strip");
const addTabBtn = document.getElementById("add-tab-btn");
const picker = document.getElementById("add-tab-picker");
const pickerList = document.getElementById("picker-list");
const pickerClose = document.getElementById("picker-close");

// tabId -> { tab, wrapper, video, stream|null }
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
  label.append(favicon, title, removeBtn);
  wrapper.appendChild(label);

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

  return { wrapper, video, startOverlay };
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

function attachStream(tabId, stream) {
  const entry = entries.get(tabId);
  if (!entry) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  entry.stream = stream;
  entry.video.srcObject = stream;
  entry.startOverlay.classList.add("hidden");
  applyHotness();
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
    entry.video.muted = !isHot;
    (isHot ? mainStage : thumbStrip).appendChild(entry.wrapper);

    if (entry.stream) {
      const track = entry.stream.getVideoTracks()[0];
      track?.applyConstraints(isHot ? HOT_CONSTRAINTS : COLD_CONSTRAINTS).catch(() => {
        // Best-effort — some tab sources ignore constraint changes mid-stream.
      });
    }
  }
  renderEmptyState();
}

function renderEmptyState() {
  const hasAny = entries.size > 0;
  let empty = mainStage.querySelector(".empty-state");
  if (!hasAny && !empty) {
    empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No tracked tabs yet — click \"Add tracked tab\" to get started.";
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
    const { wrapper, video, startOverlay } = buildTile(tab);
    entries.set(tab.id, { tab, wrapper, video, startOverlay, stream: null });
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

addTabBtn.addEventListener("click", async () => {
  const openTabs = await sendMessage({ type: "LIST_OPEN_TABS" });
  pickerList.innerHTML = "";
  for (const tab of openTabs) {
    const li = document.createElement("li");
    const favicon = document.createElement("img");
    favicon.src = tab.favIconUrl || "";
    favicon.onerror = () => (favicon.style.visibility = "hidden");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || tab.url;
    li.append(favicon, title);
    li.addEventListener("click", async () => {
      await sendMessage({ type: "ADD_TAB", tabId: tab.id });
      picker.classList.add("hidden");
    });
    pickerList.appendChild(li);
  }
  picker.classList.remove("hidden");
});

pickerClose.addEventListener("click", () => picker.classList.add("hidden"));

refreshFromBackground();
