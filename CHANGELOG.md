# Changelog

All notable changes to this project will be documented in this file.

## [1.0.2] - 2026-03-07

### Fixed
- Fixed an issue where casting YouTube Music streams to Sonos would fail with an "encoding error" due to Sonos blocking chunked HTTP transfers, by forcing the connection to use the `x-rincon-mp3radio://` protocol.
- Forced `Express` to immediately flush 200 OK headers for live streams to prevent the backend from triggering the new 5-second `play()` timeout.

## [1.0.1] - 2026-03-07

### Added
- Created a beautiful new `customAlert` modal to replace standard browser/OS alert boxes.

### Fixed
- Fixed an issue where "Manual Sonos IP" background polling would continuously spam the user with an "Invalid IP" alert window.
- Handled unreachable/offline Sonos players gracefully by adding a strict 5-second `Promise.race` timeout to backend playback events, properly bubbling up connection errors to the UI instead of silently hanging.
- Filtered out developer files (`.ps1`, `.py`, `.zip`) from source control to drastically reduce repository bundle size.

## [1.0.0] - Initial Release
- Core desktop music player application wrapping web technologies in Electron.
- Local playback supporting `.mp3` and `.flac`.
- Sonos network discovery and UPnP casting.
- Sandboxed YouTube Music streaming with active bridging.
- Advanced queue, playlists, and dynamic theming (Dark, Light, Volcanic).
