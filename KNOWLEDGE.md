# Roon Radio Bridge - Knowledge File

**Application:** Roon Radio Bridge
**Author:** Marcus Russell
**Date:** 10 April 2026
**Version:** 1.0.0 (Layer 1)

## Purpose

Replacement for the original st0g1e Node.js Roon HTTP API bridge that serves
the KitchenPi Arduino controller. Built in three layers so each can be
tested and proven before the next is added.

## Background: The Problem Being Solved

The existing st0g1e bridge works, but live radio playback on the KitchenPi
(RoPieee/IQaudIODAC) intermittently stops with no clear trigger. Roon ROCK
logs show a bare `[zone KitchenPi] Pause` followed by `OnPlayFeedback
Stopped`, with no preceding API control command from any logged source.
Analysis (see separate Arduino project conversation) indicates Roon
converts Pause commands into Stops for live radio because live streams
cannot be buffered server-side.

The source of the rogue Pause command is not yet identified. Candidates
include the OSMC RF remote (via the RoPieee extension), something
RAAT-level, or an internal Roon code path. A support ticket is open with
Roon.

Meanwhile, a workaround is being built in the form of a watchdog that can
distinguish legitimate stops (from the Arduino, touchscreen, Roon app) from
the rogue stop and auto-resume the stream in the latter case.

## Architecture Roadmap

### Layer 1: Drop-in replacement (CURRENT)

- Cleaner modular rewrite of the st0g1e bridge
- Only the routes the Arduino actually calls
- Zone subscription upgraded from a no-op to an active state tracker
- Separate `extension_id` so it coexists with the existing bridge
- Runs on `wwms.local:33262` (existing bridge stays on `roonem2.local:33262`)

### Layer 2: Roon log tailing (PLANNED)

- Mounts ROCK SMB share read-only (`/Data/RoonServer/Logs/`)
- Tails `RoonServer_log.txt` (active file; rotates to
  `RoonServer_log.01.txt` etc.)
- Maintains rolling in-memory buffer of recent API transport commands
- Exposes a query function: "did any API client issue a transport control
  command for zone X in the last N seconds?"
- Handles log rotation and SMB mount failures gracefully

### Layer 3: Watchdog (PLANNED)

- Consumes zone state transitions from the Layer 1 state tracker
- On KitchenPi transition from playing (radio) to stopped:
  1. Query Layer 2: any API command in the last ~3 seconds?
  2. Yes -> legitimate stop, do nothing
  3. No -> rogue stop, auto-resume via transport.control('play')
- Configurable delay before auto-resume (default 2-3 seconds)
- Logs all watchdog activity for diagnostics
- Only active for the KitchenPi zone, only for live radio content

### Dockerisation (AFTER Layer 3)

Wrap the tested bridge in a Docker container using `network_mode: host`
(required for Roon SOOD discovery), deploy via Portainer on WWMS,
persistent volume for Roon pairing token.

## Environment

- **Host:** WWMS (Ubuntu headless server, primary purpose: staging/media)
- **Code location:** `/opt/roon-radio-bridge/`
- **Node:** 20 LTS from NodeSource (not installed yet)
- **Port:** 33262 (same as existing bridge; different host avoids conflict)
- **Backup:** `/opt` is backed up to WWNAS via Duplicati

## Roon Setup

- **Extension ID:** `marcus.roon-radio-bridge` (distinct from st0g1e's
  `st0g1e.roon-http-api`)
- **Display name:** Roon Radio Bridge
- **Required services:** RoonApiTransport, RoonApiBrowse
- **Provided services:** RoonApiStatus, RoonApiSettings
- **Settings UI:** 10 preset dropdowns populated from the internet radio
  hierarchy
- **Config persistence:** via Roon's own `load_config`/`save_config`
  mechanism, keyed to the extension ID

## Files (Layer 1)

| File                | Purpose                                     |
|---------------------|---------------------------------------------|
| `package.json`      | Node dependencies                           |
| `index.js`          | Entry point, Express server setup           |
| `roon.js`           | Roon connection, settings, zone tracker     |
| `routes.js`         | HTTP route mapping                          |
| `api/transport.js`  | play/pause/stop/volume/mute handlers        |
| `api/zones.js`      | listZones/getOutputState handlers           |
| `api/radio.js`      | Preset selection logic                      |
| `README.md`         | Install and usage instructions              |
| `KNOWLEDGE.md`      | This file                                   |

## Status

- **Layer 1:** Code complete, ready to install and test on WWMS
- **Layer 2:** Not started
- **Layer 3:** Not started

## Next Actions

1. Install Node 20 on WWMS
2. Deploy Layer 1 code to `/opt/roon-radio-bridge/`
3. Run `npm install` and `node index.js`
4. Enable extension in Roon, configure presets
5. Test all routes from a browser/curl before switching the Arduino over
6. Update Arduino `HOST_NAME` to `wwms.local` (in separate Arduino project)
7. Observe for a few days, then proceed to Layer 2
