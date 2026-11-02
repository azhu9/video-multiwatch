// Orchestration only: tracks which tabs are being watched and which one is
// "hot," and persists that across service-worker restarts. It never touches
// captured media itself — viewer.html does that directly, since only a
// visible extension page can hold/consume a tabCapture MediaStream.

const VIEWER_URL = chrome.runtime.getURL("viewer.html");

async function getState() {
  const { trackedTabs = [], hotTabId = null } = await chrome.storage.session.get([
    "trackedTabs",
    "hotTabId",
  ]);
  return { trackedTabs, hotTabId };
}

async function setState(state) {
  await chrome.storage.session.set(state);
  broadcast(state);
}

function broadcast(state) {
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {
    // No viewer page open to receive it — fine, it'll fetch state on load.
  });
}

async function addTrackedTab(tabId) {
  const state = await getState();
  if (state.trackedTabs.some((t) => t.id === tabId)) return state;

  const tab = await chrome.tabs.get(tabId);
  const entry = { id: tab.id, title: tab.title || "Untitled tab", favIconUrl: tab.favIconUrl || "" };
  state.trackedTabs.push(entry);
  if (state.hotTabId === null) state.hotTabId = tab.id;

  // Chrome can discard a backgrounded tab under memory pressure to free RAM
  // — exactly the state every tracked tab sits in. A discard silently kills
  // its capture, which from the viewer just looks like the stream dying for
  // no reason. Opting out trades a little more memory pressure for not
  // losing a stream you're actively watching.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

  await setState(state);
  return state;
}

async function removeTrackedTab(tabId) {
  const state = await getState();
  state.trackedTabs = state.trackedTabs.filter((t) => t.id !== tabId);
  if (state.hotTabId === tabId) {
    state.hotTabId = state.trackedTabs.length > 0 ? state.trackedTabs[0].id : null;
  }
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {
    // Tab may already be closed — fine either way.
  });
  await setState(state);
  return state;
}

async function setHotTab(tabId) {
  const state = await getState();
  if (!state.trackedTabs.some((t) => t.id === tabId)) return state;
  state.hotTabId = tabId;
  await setState(state);
  return state;
}

// Reorders trackedTabs to match `order` (an array of tabIds) — drives both
// the DOM order in the viewer and its number-key hotkey assignment. Ignores
// any id that isn't actually tracked, and appends any tracked tab missing
// from `order` as a safety net so a stale/partial order never drops a tab.
async function reorderTrackedTabs(order) {
  const state = await getState();
  const byId = new Map(state.trackedTabs.map((t) => [t.id, t]));
  const seen = new Set();
  const reordered = [];
  for (const id of order) {
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      seen.add(id);
      reordered.push(t);
    }
  }
  for (const t of state.trackedTabs) {
    if (!seen.has(t.id)) reordered.push(t);
  }
  state.trackedTabs = reordered;
  await setState(state);
  return state;
}

async function openOrFocusViewer() {
  const existing = await chrome.tabs.query({ url: VIEWER_URL });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: VIEWER_URL });
}

// chrome.tabCapture only works on a tab the extension has been "invoked" on
// (activeTab-style grant) — either the toolbar action or this context menu
// item, both clicked while that tab is focused. There is no way to grant
// this for an arbitrary already-open tab without one of these gestures.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "track-tab",
    title: "Track this tab in Multiwatch",
    contexts: ["page"],
  });
});

async function trackAndOpenViewer(tab) {
  if (tab.url === VIEWER_URL) return;
  await addTrackedTab(tab.id);
  await openOrFocusViewer();
}

chrome.action.onClicked.addListener(trackAndOpenViewer);
chrome.contextMenus.onClicked.addListener((_info, tab) => trackAndOpenViewer(tab));

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.trackedTabs.some((t) => t.id === tabId)) {
    await removeTrackedTab(tabId);
  }
});

// A navigation on a tracked tab invalidates tabCapture's per-tab grant for
// it (the same grant the toolbar/context-menu click established) — the
// capture dies, and there's no way to silently re-establish it without a
// fresh real gesture on that tab. Tell the viewer immediately so it can
// show "capture lost" rather than leaving a frozen/stale frame on screen
// until the stream happens to end on its own.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return; // only true navigations set this field
  const state = await getState();
  if (!state.trackedTabs.some((t) => t.id === tabId)) return;
  chrome.runtime.sendMessage({ type: "TAB_NAVIGATED", tabId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATE":
        sendResponse(await getState());
        break;
      case "ADD_TAB":
        sendResponse(await addTrackedTab(message.tabId));
        break;
      case "REMOVE_TAB":
        sendResponse(await removeTrackedTab(message.tabId));
        break;
      case "SET_HOT":
        sendResponse(await setHotTab(message.tabId));
        break;
      case "REORDER_TABS":
        sendResponse(await reorderTrackedTabs(message.order));
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async response
});
