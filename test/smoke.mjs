// Smoke test for the extension's tab-tracking/UI mechanics.
//
// It deliberately does NOT (and cannot) verify a real successful
// chrome.tabCapture call: that requires the extension to be "invoked" on a
// tab via a genuine user gesture on real browser UI (the toolbar action or
// the right-click context menu item), which only a human clicking a real
// Chrome window can produce — Playwright's synthetic clicks satisfy the
// generic "user activation" requirement for getUserMedia, but not Chrome's
// separate per-tab tabCapture grant. Tracking a tab here via a direct
// runtime message (bypassing that gesture) is expected to make
// "Start capture" fail with a tabCapture permission error — that's the
// correct, secure behavior, not a bug. See README.md's Testing section.
//
// What this DOES verify: tiles render for tracked tabs, the start-capture
// button wires up without throwing, and click-to-swap correctly moves a
// tile into #main-stage and flips its mute flag — i.e. everything that
// doesn't require a real capture grant.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const PORT = 8791;

function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(FIXTURES_DIR, req.url === "/" ? "stream-a.html" : req.url);
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

const errors = [];
function watchConsole(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[${label}] console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`[${label}] pageerror: ${err.message}`));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const server = await serveStatic();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  sw.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[background] console.error: ${msg.text()}`);
  });

  const tabA = await context.newPage();
  watchConsole(tabA, "tabA");
  await tabA.goto(`http://localhost:${PORT}/stream-a.html`);

  const tabB = await context.newPage();
  watchConsole(tabB, "tabB");
  await tabB.goto(`http://localhost:${PORT}/stream-b.html`);

  const viewer = await context.newPage();
  watchConsole(viewer, "viewer");
  await viewer.goto(`chrome-extension://${extId}/viewer.html`);
  await viewer.waitForSelector("#main-stage");

  const tabAId = await viewer.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://localhost:${port}/stream-a.html*` });
    return tabs[0].id;
  }, PORT);
  const tabBId = await viewer.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://localhost:${port}/stream-b.html*` });
    return tabs[0].id;
  }, PORT);

  await viewer.evaluate((id) => chrome.runtime.sendMessage({ type: "ADD_TAB", tabId: id }), tabAId);
  await viewer.evaluate((id) => chrome.runtime.sendMessage({ type: "ADD_TAB", tabId: id }), tabBId);
  await viewer.waitForTimeout(500);

  const tileCount = await viewer.locator(".tile").count();
  assert(tileCount === 2, `expected 2 tiles, got ${tileCount}`);

  // Capture now starts automatically as soon as a tab is tracked (no more
  // per-tile "Start capture" button) — give those in-flight attempts a
  // moment. Real tabCapture can't succeed here (no genuine user gesture on
  // browser chrome), but it should fail cleanly via the expected permission
  // error rather than throwing/crashing the page.
  await viewer.waitForTimeout(500);
  const connectingCount = await viewer.locator(".connecting-overlay:not(.hidden)").count();
  assert(connectingCount === 2, `expected both tiles still showing "Connecting…", got ${connectingCount}`);

  // Swap mechanics are independent of tabCapture succeeding, so exercise them
  // by attaching a fake local stream through the same attachStream() the real
  // capture path uses, rather than depending on a real capture grant.
  await viewer.evaluate((id) => {
    const stream = document.createElement("canvas").captureStream();
    window.attachStream(id, stream);
  }, tabAId);
  await viewer.evaluate((id) => {
    const stream = document.createElement("canvas").captureStream();
    window.attachStream(id, stream);
  }, tabBId);
  await viewer.waitForTimeout(200);

  const thumbTile = viewer.locator("#thumb-strip .tile").first();
  const thumbTabId = await thumbTile.getAttribute("data-tab-id");
  await thumbTile.click();
  await viewer.waitForTimeout(300);

  const placements = await viewer.evaluate(() =>
    [...document.querySelectorAll(".tile")].map((tile) => ({
      tabId: tile.dataset.tabId,
      parent: tile.parentElement?.id,
      muted: tile.querySelector("video")?.muted,
    }))
  );
  const swapped = placements.find((p) => p.tabId === thumbTabId);
  assert(swapped.parent === "main-stage", "clicked thumbnail should move to #main-stage");
  assert(swapped.muted === false, "promoted tile should be unmuted");
  const other = placements.find((p) => p.tabId !== thumbTabId);
  assert(other.parent === "thumb-strip", "demoted tile should move to #thumb-strip");
  assert(other.muted === true, "demoted tile should be muted");

  console.log("Tile/swap mechanics: PASS");

  // --- Live/VOD pause-on-demote behavior ---
  // chrome.scripting.executeScript would hit the same real-gesture permission
  // wall as tabCapture in this harness, so stub it to record calls and verify
  // *our* call logic (when we decide to pause/resume) independently of
  // whether Chrome would actually grant it in a real browser.
  await viewer.evaluate(() => {
    window.__scriptingCalls = [];
    chrome.scripting.executeScript = async (opts) => {
      window.__scriptingCalls.push({ tabId: opts.target.tabId, shouldPlay: opts.args?.[0] });
      return [];
    };
  });
  const getCalls = () => viewer.evaluate(() => window.__scriptingCalls);
  const clearCalls = () => viewer.evaluate(() => (window.__scriptingCalls = []));

  // thumbTabId is currently hot (promoted above). Mark it VOD via its badge —
  // since it's hot, that should immediately send a "play" call. The label
  // bar is hover-revealed now, same as main-controls, so hover first.
  await viewer.locator("#main-stage .tile").hover();
  await viewer.locator("#main-stage .live-badge").click();
  await viewer.waitForTimeout(200);
  let calls = await getCalls();
  assert(
    calls.some((c) => c.tabId === Number(thumbTabId) && c.shouldPlay === true),
    "marking the hot tile as VOD should sync it to playing"
  );

  // Promote the other (still-LIVE) tile, demoting our VOD tile — expect a pause.
  await clearCalls();
  const otherTile = viewer.locator(`.tile[data-tab-id="${other.tabId}"]`);
  await otherTile.click();
  await viewer.waitForTimeout(300);
  calls = await getCalls();
  assert(
    calls.some((c) => c.tabId === Number(thumbTabId) && c.shouldPlay === false),
    "demoting a VOD tile should pause it"
  );
  assert(
    !calls.some((c) => c.tabId === Number(other.tabId)),
    "a tile still marked LIVE should never receive play/pause calls"
  );

  // Swap back — expect the VOD tile to resume.
  await clearCalls();
  await viewer.locator(`.tile[data-tab-id="${thumbTabId}"]`).click();
  await viewer.waitForTimeout(300);
  calls = await getCalls();
  assert(
    calls.some((c) => c.tabId === Number(thumbTabId) && c.shouldPlay === true),
    "promoting a VOD tile back to main should resume it"
  );

  console.log("Live/VOD pause-on-demote mechanics: PASS");

  // --- Manual play/pause button, and that a manual pause survives a swap ---
  // main-controls is hover-revealed (opacity:0/pointer-events:none until the
  // tile is hovered), so a real .hover() is needed before .click() will see
  // it as interactable — exactly what a real mouse hovering the tile does.
  await clearCalls();
  await viewer.locator("#main-stage .tile").hover();
  await viewer.locator("#main-stage .play-pause-btn").click();
  await viewer.waitForTimeout(200);
  calls = await getCalls();
  assert(
    calls.some((c) => c.tabId === Number(thumbTabId) && c.shouldPlay === false),
    "clicking pause in the main view should pause the VOD source"
  );
  const paused = await viewer.evaluate(() => document.querySelector("#main-stage video").paused);
  assert(paused === true, "local video element should reflect the manual pause");

  // Swap away and back — the manual pause should NOT be auto-resumed.
  await clearCalls();
  await otherTile.click();
  await viewer.waitForTimeout(300);
  await viewer.locator(`.tile[data-tab-id="${thumbTabId}"]`).click();
  await viewer.waitForTimeout(300);
  calls = await getCalls();
  assert(
    !calls.some((c) => c.tabId === Number(thumbTabId) && c.shouldPlay === true),
    "a manual pause should survive being swapped away and back"
  );

  // The play button explicitly resumes it.
  await clearCalls();
  await viewer.locator("#main-stage .tile").hover();
  await viewer.locator("#main-stage .play-pause-btn").click();
  await viewer.waitForTimeout(200);
  calls = await getCalls();
  assert(
    calls.some((c) => c.tabId === Number(thumbTabId) && c.shouldPlay === true),
    "clicking play in the main view should resume the VOD source"
  );

  console.log("Manual pause/resume mechanics: PASS");

  // --- Thumbnail layout toggle ---
  for (const mode of ["overlay-bottom", "overlay-left", "below"]) {
    await viewer.locator("#thumb-layout-select").selectOption(mode);
    const hasClass = await viewer.evaluate(() => document.getElementById("stage").className);
    assert(hasClass.includes(`layout-${mode}`), `#stage should carry layout-${mode} after selecting it`);
  }
  console.log("Thumbnail layout toggle: PASS");

  // --- Thumbnail quality toggle ---
  // "other" (from the swap-mechanics section above) is the current thumbnail
  // tile. applyConstraints on a real canvas.captureStream() track is a
  // normal WebRTC API call (not gated like tabCapture/scripting), so this
  // checks real effect via getConstraints() rather than stubbing anything.
  await viewer.locator("#thumb-quality-select").selectOption("high");
  await viewer.waitForTimeout(150);
  let coldConstraints = await viewer.evaluate((tid) => {
    const video = document.querySelector(`.tile[data-tab-id="${tid}"] video`);
    return video.srcObject.getVideoTracks()[0].getConstraints();
  }, other.tabId);
  assert(coldConstraints.frameRate === 30, `expected high-quality frameRate 30, got ${coldConstraints.frameRate}`);

  await viewer.locator("#thumb-quality-select").selectOption("low");
  await viewer.waitForTimeout(150);
  coldConstraints = await viewer.evaluate((tid) => {
    const video = document.querySelector(`.tile[data-tab-id="${tid}"] video`);
    return video.srcObject.getVideoTracks()[0].getConstraints();
  }, other.tabId);
  assert(coldConstraints.frameRate === 8, `expected low-quality frameRate 8 after switching back, got ${coldConstraints.frameRate}`);
  console.log("Thumbnail quality toggle: PASS");

  // --- Resync button ---
  await viewer.locator("#main-stage .tile").hover();
  await viewer.locator("#main-stage .resync-btn").click();
  await viewer.waitForTimeout(200);
  const hasSrc = await viewer.evaluate(() => !!document.querySelector("#main-stage video").srcObject);
  assert(hasSrc, "main video should still have a srcObject after resync");
  console.log("Resync button: PASS");

  // --- Number-key hotkeys ---
  // hotkeyOrder is track order, not hot/cold order: tabA (tracked first) is
  // slot 1, tabB (tracked second, aka thumbTabId) is slot 2 — regardless of
  // which is currently hot. A leftover focused <select> from the toggles
  // above would make our isTypingTarget guard swallow the keypress, so
  // explicitly blur first, matching a real user having clicked elsewhere.
  await viewer.evaluate(() => document.activeElement?.blur());
  await viewer.keyboard.press("1");
  await viewer.waitForTimeout(200);
  let mainTabId = await viewer.evaluate(() => document.querySelector("#main-stage .tile")?.dataset.tabId);
  assert(mainTabId === other.tabId, `pressing "1" should promote the first-tracked tab (${other.tabId}), got ${mainTabId}`);

  await viewer.keyboard.press("2");
  await viewer.waitForTimeout(200);
  mainTabId = await viewer.evaluate(() => document.querySelector("#main-stage .tile")?.dataset.tabId);
  assert(mainTabId === thumbTabId, `pressing "2" should promote the second-tracked tab (${thumbTabId}), got ${mainTabId}`);
  console.log("Number-key hotkeys: PASS");

  // --- Drag-to-reorder (via the exposed reorderTabs(), not simulated native
  // DnD — Playwright's synthetic drag events don't reliably trigger real
  // HTML5 drag-and-drop, so this checks the actual reordering logic the
  // drop handler calls rather than the fragile part of driving a real drag) ---
  // Current tabOrder is [tabA, tabB] (slot 1, 2). Swap it to [tabB, tabA].
  await viewer.evaluate(
    ({ a, b }) => window.reorderTabs(b, a),
    { a: tabAId, b: tabBId }
  );
  await viewer.waitForTimeout(100);
  let badges = await viewer.evaluate(({ a, b }) => ({
    a: document.querySelector(`.tile[data-tab-id="${a}"] .hotkey-badge`)?.textContent,
    b: document.querySelector(`.tile[data-tab-id="${b}"] .hotkey-badge`)?.textContent,
  }), { a: tabAId, b: tabBId });
  assert(badges.b === "1" && badges.a === "2", `expected reordered badges B=1,A=2, got A=${badges.a},B=${badges.b}`);
  console.log("Drag-to-reorder (via reorderTabs): PASS");

  // --- Split view (shift+click) ---
  // tabB is hot (main), tabA is the lone thumbnail at this point.
  await viewer.locator(`.tile[data-tab-id="${tabAId}"]`).click({ modifiers: ["Shift"] });
  await viewer.waitForTimeout(200);
  let splitState = await viewer.evaluate(({ a }) => ({
    mainStageHasSplit: document.getElementById("main-stage").classList.contains("split"),
    tileIsSplit: document.querySelector(`.tile[data-tab-id="${a}"]`)?.classList.contains("split-tile"),
    tileParent: document.querySelector(`.tile[data-tab-id="${a}"]`)?.parentElement?.id,
    muted: document.querySelector(`.tile[data-tab-id="${a}"] video`)?.muted,
  }), { a: tabAId });
  assert(splitState.mainStageHasSplit, "shift+click should put #main-stage into split mode");
  assert(splitState.tileIsSplit, "shift-clicked tile should carry .split-tile");
  assert(splitState.tileParent === "main-stage", "split tile should be placed in #main-stage");
  assert(splitState.muted === true, "split tile should stay muted — only the hot tile has audio");

  // Shift+click again to exit split.
  await viewer.locator(`.tile[data-tab-id="${tabAId}"]`).click({ modifiers: ["Shift"] });
  await viewer.waitForTimeout(200);
  splitState = await viewer.evaluate(() => ({
    mainStageHasSplit: document.getElementById("main-stage").classList.contains("split"),
  }));
  assert(!splitState.mainStageHasSplit, "shift+click again should exit split mode");
  console.log("Split view (shift+click): PASS");

  // --- Split view via the visible button (discoverability fix — the
  // overlay-bottom bar, including this button, is hover-revealed now) ---
  const thumbA = viewer.locator(`.tile[data-tab-id="${tabAId}"]`);
  await thumbA.hover();
  await thumbA.locator(".split-btn").click();
  await viewer.waitForTimeout(200);
  splitState = await viewer.evaluate(({ a }) => ({
    mainStageHasSplit: document.getElementById("main-stage").classList.contains("split"),
    btnActive: document.querySelector(`.tile[data-tab-id="${a}"] .split-btn`)?.classList.contains("active"),
  }), { a: tabAId });
  assert(splitState.mainStageHasSplit, "clicking the split button should enter split mode");
  assert(splitState.btnActive, "the split button should show active state while split");

  await thumbA.hover(); // now in #main-stage as the split tile — re-hover there
  await thumbA.locator(".split-btn").click();
  await viewer.waitForTimeout(200);
  splitState = await viewer.evaluate(() => ({
    mainStageHasSplit: document.getElementById("main-stage").classList.contains("split"),
  }));
  assert(!splitState.mainStageHasSplit, "clicking the split button again should exit split mode");
  console.log("Split view (button): PASS");

  // --- Cycle hotkeys (arrow keys) ---
  // tabB is hot; tabOrder is [tabB, tabA] after the reorder above, so
  // ArrowRight should move audio focus to tabA, and a second ArrowRight
  // should wrap back around to tabB.
  await viewer.evaluate(() => document.activeElement?.blur());
  await viewer.keyboard.press("ArrowRight");
  await viewer.waitForTimeout(200);
  mainTabId = await viewer.evaluate(() => document.querySelector("#main-stage .tile")?.dataset.tabId);
  assert(mainTabId === String(tabAId), `ArrowRight should cycle to tabA, got ${mainTabId}`);

  await viewer.keyboard.press("ArrowRight");
  await viewer.waitForTimeout(200);
  mainTabId = await viewer.evaluate(() => document.querySelector("#main-stage .tile")?.dataset.tabId);
  assert(mainTabId === String(tabBId), `ArrowRight should wrap back to tabB, got ${mainTabId}`);

  await viewer.keyboard.press("ArrowLeft");
  await viewer.waitForTimeout(200);
  mainTabId = await viewer.evaluate(() => document.querySelector("#main-stage .tile")?.dataset.tabId);
  assert(mainTabId === String(tabAId), `ArrowLeft should cycle back to tabA, got ${mainTabId}`);
  console.log("Cycle hotkeys (arrow keys): PASS");

  // --- Stale-capture detection via a real tab navigation ---
  // This is a genuine end-to-end check, not a stub: navigating tabA for
  // real should make background.js's chrome.tabs.onUpdated listener fire
  // (changeInfo.url is only set on an actual navigation), which broadcasts
  // TAB_NAVIGATED, which the viewer should catch and mark that tile lost.
  await tabA.goto(`http://localhost:${PORT}/stream-b.html`);
  await viewer.waitForTimeout(500);
  const lostState = await viewer.evaluate(({ a }) => {
    const tile = document.querySelector(`.tile[data-tab-id="${a}"]`);
    return {
      overlayVisible: !tile.querySelector(".connecting-overlay").classList.contains("hidden"),
      overlayText: tile.querySelector(".connecting-overlay").textContent,
      hasSrc: !!tile.querySelector("video").srcObject,
    };
  }, { a: tabAId });
  assert(lostState.overlayVisible, "navigating the tracked tab should surface the connecting/lost overlay");
  assert(lostState.overlayText.includes("Capture lost"), `expected "Capture lost" text, got "${lostState.overlayText}"`);
  assert(!lostState.hasSrc, "video srcObject should be cleared once capture is marked lost");
  console.log("Stale-capture detection (real navigation): PASS");

  // --- Overlay layouts have no background (regression check — an earlier
  // version left the gradient removed but the solid #thumb-strip background
  // still showing through as a flat black box) ---
  await viewer.locator("#thumb-layout-select").selectOption("overlay-left");
  await viewer.waitForTimeout(150);
  const stripBg = await viewer.evaluate(
    () => getComputedStyle(document.getElementById("thumb-strip")).backgroundColor
  );
  assert(
    stripBg === "rgba(0, 0, 0, 0)" || stripBg === "transparent",
    `expected #thumb-strip to have no background in overlay mode, got "${stripBg}"`
  );
  await viewer.locator("#thumb-layout-select").selectOption("below");
  console.log("Overlay layout has no background: PASS");

  // --- Untracking pauses the source tab ---
  // Stopping capture restores the source tab's native audio — without an
  // explicit pause, untracking leaves it playing audibly in the background.
  await clearCalls();
  const tileA = viewer.locator(`.tile[data-tab-id="${tabAId}"]`);
  await tileA.hover();
  await tileA.locator(".remove-btn").click();
  await viewer.waitForTimeout(200);
  calls = await getCalls();
  assert(
    calls.some((c) => c.tabId === tabAId && c.shouldPlay === false),
    "untracking a tab should pause its source video"
  );
  const tileCountAfterRemove = await viewer.locator(".tile").count();
  assert(tileCountAfterRemove === 1, `expected 1 tile left after removing one, got ${tileCountAfterRemove}`);
  console.log("Untrack pauses source tab: PASS");

  const unexpectedErrors = errors.filter(
    (e) =>
      !e.includes("tabCapture failed") &&
      !e.includes("404 (Not Found)") &&
      !e.includes("live detection failed") && // same no-real-gesture limitation as tabCapture
      !e.includes("disablePiPOnTab failed") // ditto
  );
  if (unexpectedErrors.length > 0) {
    console.log("Unexpected console/page errors:");
    unexpectedErrors.forEach((e) => console.log(" ", e));
    throw new Error("unexpected errors present");
  }
  console.log("No unexpected console/page errors.");
  console.log(
    "(tabCapture permission errors above this line are expected — this test can't perform the real user gesture Chrome requires; see file header comment.)"
  );

  await context.close();
  server.close();
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
