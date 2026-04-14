# Roon Radio Bridge

HTTP bridge between the KitchenPi Arduino controller and Roon ROCK.
A cleaned-up replacement for the original st0g1e Node.js Roon HTTP API,
purpose-built for this setup.

**Author:** Marcus Russell
**Version:** 1.0.0 (Layer 1 — drop-in replacement)
**Date:** 10 April 2026

## Architecture Roadmap

The bridge is being built in three layers so each can be tested independently
before moving on:

- **Layer 1 (this version)** — Drop-in HTTP bridge. All routes the Arduino
  needs, in a cleaner modular structure. Tracks zone state transitions in
  memory as preparation for later layers but does not act on them.
- **Layer 2 (planned)** — Roon log-tailing module. Reads
  `RoonServer_log.txt` from the ROCK SMB share to observe API transport
  commands from all sources (bridge, touchscreen, Roon app, extensions).
  This gives the bridge visibility it can't get from the Roon API alone.
- **Layer 3 (planned)** — Live radio stream watchdog. When the KitchenPi
  zone transitions to stopped, the watchdog cross-references the log to
  determine whether the stop was triggered by any legitimate API command.
  If not, it auto-resumes the stream to work around the Roon live-radio
  stop bug.

Dockerisation will follow once Layer 3 is proven on the native install.

## Running Alongside the Existing Bridge

The existing Node.js bridge runs on `roonem2.local:33262`. This new bridge
runs on `wwms.local:33262`. Because the hostnames differ, both can run in
parallel during testing. The Arduino can be switched between them by
updating the `HOST_NAME` constant in the firmware.

The new bridge registers with Roon using extension ID
`marcus.roon-radio-bridge`, distinct from the original's
`st0g1e.roon-http-api`, so Roon treats them as entirely separate extensions.
Both can be enabled simultaneously. They do not share configuration.

## Installation on WWMS

### 1. Install Node.js 20 LTS

WWMS does not currently have Node.js installed. Install from NodeSource
(the cleanest route on Ubuntu; the default apt package is typically well
behind):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # should show v20.x
npm --version
```

### 2. Deploy the bridge

```bash
sudo mkdir -p /opt/roon-radio-bridge
sudo chown $USER:$USER /opt/roon-radio-bridge
# Copy this directory's contents into /opt/roon-radio-bridge
cd /opt/roon-radio-bridge
npm install
```

The `npm install` step downloads the Roon API modules from GitHub and
Express from npm. It may take a minute or two on first run.

### 3. Run manually for testing

```bash
cd /opt/roon-radio-bridge
node index.js
```

You should see output similar to:

```
[bridge] Roon Radio Bridge v1.0.0 listening on port 33262
[bridge] Routes available at http://wwms.local:33262/roonAPI/...
[roon] Discovery started
```

When Roon finds and pairs with the extension, you will also see:

```
[roon] Paired with core: <your core name>
[zone] KitchenPi: playing -> stopped (radio)
[zone] HiFi Altair: stopped -> playing
```

The `[zone]` lines are the zone state tracker in action — this is the
infrastructure Layer 3's watchdog will later consume.

Stop the bridge with Ctrl-C.

### 4. Enable the extension in Roon

1. Open any Roon client (desktop app, mobile, or web UI)
2. Go to **Settings > Extensions**
3. Find **Roon Radio Bridge** in the list (it will appear within a few
   seconds of the bridge starting)
4. Click **Enable**

### 5. Configure presets

Presets must be configured before the Arduino can select stations by
number.

1. **Settings > Extensions > Roon Radio Bridge > Settings**
2. For each of the 10 preset slots, select a station from the dropdown.
   The dropdown is populated from your Roon internet radio library, so you
   can only choose stations Roon already knows about.
3. Click **Save**

You should see `[roon] Preset configuration saved` in the bridge console.

## Quick Test

From any machine on the LAN:

```bash
# List all Roon zones (works immediately once paired)
curl http://wwms.local:33262/roonAPI/listZones

# Check core info
curl http://wwms.local:33262/roonAPI/getCore

# Check the state of the KitchenPi output (substitute the real ID)
curl 'http://wwms.local:33262/roonAPI/getOutputState?outputId=1701058455ab643a92313693b022837e196a'
```

These three calls exercise the pairing, the transport service, and the
zone-by-output-id lookup — enough to confirm the bridge is functioning.

## Switching the Arduino Over

Once you're satisfied the new bridge works, update the Arduino firmware:

```c
char HOST_NAME[] = "wwms.local";
// HTTP_PORT stays at 33262
```

The Arduino code is being updated in a separate project conversation to
repurpose the RHS encoder long-press for this purpose — see that thread for
details. No other Arduino changes are required.

## Running as a systemd Service (Later)

Once testing is complete, the bridge should run as a systemd service so it
starts on boot and restarts on failure. A unit file will be provided in a
follow-up step. For now, running manually under `node index.js` (perhaps
inside `tmux` or `screen` for persistence) is fine.

## Files

| File                | Purpose                                          |
|---------------------|--------------------------------------------------|
| `package.json`      | Node dependencies                                |
| `index.js`          | Entry point, Express server setup                |
| `roon.js`           | Roon API connection, settings, zone tracker      |
| `routes.js`         | HTTP URL path mapping                            |
| `api/transport.js`  | play/pause/stop/volume/mute handlers             |
| `api/zones.js`      | listZones/getOutputState etc handlers            |
| `api/radio.js`      | Internet radio preset selection                  |
| `README.md`         | This file                                        |

## Differences from the Original Bridge

- Modular structure: one file per concern rather than a single 767-line
  `roonAPI.js`
- Unused routes removed: browse navigation, timers, image serving, and
  several broken/unreferenced handlers have been dropped. Only the routes
  the Arduino actually calls remain.
- Zone subscription is no longer a no-op. It now maintains a state tracker
  that logs transitions and will be consumed by Layer 3.
- Clean error handling: all handlers return HTTP 503 if the bridge is not
  paired with a Roon core, rather than crashing on null dereferences.
- Standalone extension ID so it coexists with the existing bridge during
  migration.
