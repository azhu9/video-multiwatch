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

  const startButtons = viewer.locator(".start-overlay button");
  const startCount = await startButtons.count();
  assert(startCount === 2, `expected 2 start-capture buttons, got ${startCount}`);
  // Real tabCapture can't succeed here (no genuine user gesture on browser
  // chrome), but clicking should still fail cleanly via the expected
  // permission error rather than throwing/crashing the page.
  for (let i = 0; i < startCount; i++) {
    await startButtons.nth(i).click();
    await viewer.waitForTimeout(500);
  }

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

  const unexpectedErrors = errors.filter(
    (e) => !e.includes("tabCapture failed") && !e.includes("404 (Not Found)")
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
