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

  await setState(state);
  return state;
}

async function removeTrackedTab(tabId) {
  const state = await getState();
  state.trackedTabs = state.trackedTabs.filter((t) => t.id !== tabId);
  if (state.hotTabId === tabId) {
    state.hotTabId = state.trackedTabs.length > 0 ? state.trackedTabs[0].id : null;
  }
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

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url === VIEWER_URL) return;
  await addTrackedTab(tab.id);
  await openOrFocusViewer();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.trackedTabs.some((t) => t.id === tabId)) {
    await removeTrackedTab(tabId);
  }
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
      case "LIST_OPEN_TABS": {
        const tabs = await chrome.tabs.query({});
        sendResponse(
          tabs
            .filter((t) => t.url !== VIEWER_URL)
            .map((t) => ({ id: t.id, title: t.title, favIconUrl: t.favIconUrl, url: t.url }))
        );
        break;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async response
});
