# Multiwatch

A Chrome extension for watching several video tabs at once: one tab plays
with audio in a large main view, the others show as muted live thumbnails
below it. Click any thumbnail to instantly swap it into the main view.

Works with any site that plays video in a standard page element — great for
keeping an eye on multiple livestreams, sports broadcasts, or any
multi-feed setup. (Note: DRM-protected services like Netflix, Disney+, or
Prime Video can't be captured — see [Known limitations](#known-limitations).)

## Features

- **One main view + muted thumbnails.** Only one tab has audio at a time;
  click any thumbnail to swap it in.
- **Split view.** Show two tabs large side by side; click either to switch
  audio between them.
- **Hotkeys.** Press `1`-`9` to jump straight to a tracked tab, or
  `←`/`→` to cycle through them.
- **Smart pausing.** On-demand videos pause automatically when not in
  view (so you don't lose your place) and when you stop tracking a tab;
  live streams keep running in the background.
- **Adjustable layout and quality.** Thumbnails can sit below the main
  view or float over it, at three quality presets.
- **No Picture-in-Picture surprises, no auto-discarded tabs.** Tracked
  tabs are kept alive and prevented from popping into PiP on their own.

## Installing it

This isn't yet on the Chrome Web Store — load it as an unpacked extension:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this repo's folder.
3. Switch to a tab you want to track, then either click the Multiwatch
   toolbar icon or right-click the page and choose **"Track this tab in
   Multiwatch."** This opens the viewer and starts capturing it.
4. Click any thumbnail to swap it into the main view.

## Known limitations

- **DRM-protected content can't be captured** — Netflix, Disney+, Hulu,
  Max, Prime Video, etc. This is a hard limit enforced by Chrome itself at
  the browser level, not something this extension can work around.
- No ad-break auto-detection or in-page ad blocking yet.
- Tracking is global, not scoped to one browser window.

## Development

See [`SPEC.md`](SPEC.md) for the architecture/feasibility writeup and
[`DEVELOPMENT.md`](DEVELOPMENT.md) for implementation notes, known
quirks, and the Chrome Web Store submission checklist. Tests:

```sh
npm install
npm test
```
