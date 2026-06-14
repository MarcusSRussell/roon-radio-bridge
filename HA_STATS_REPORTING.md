# HA Stats Reporting - Knowledge File

**Application:** Roon Radio Bridge
**Author:** Marcus Russell
**Date:** 14 June 2026
**Version:** 1.0.0

## Purpose

Pushes Roon Core's periodic health/diagnostic stats (memory, handles,
threads, GC pause behaviour) into Home Assistant as sensor entities, for
dashboard visibility and (eventually) automation-based alerting on
exceptions. This was prompted by noticing a `[stats]` line in
`RoonServer_log.txt`.

## Source Data

The `[stats]` line is written by Roon Core roughly every 14 seconds
(observed: ~3000 occurrences in 12 hours). Example:

```
06/14 08:50:35 [Local 06/14 09:50:35] Info: [stats] 70464mb Virtual,
2412mb Physical, 1275mb Managed, 1137mb estimated Unmanaged, 552 Handles,
70 Threads, 1.07% of runtime in GC pauses, 24ms last GC pause duration
```

**Important caveat:** this format is based on a single observed sample
line. There is no known published Roon documentation describing it - it's
consistent with standard .NET runtime/GC diagnostic output (Roon Core runs
on .NET), but its stability across Roon versions is unverified. If Roon
changes the wording, `roonStats.js` will log a throttled warning
(`[stats] line did not match expected format`) rather than failing
silently - if you ever see that in the logs, the regex in `roonStats.js`
will need updating to match the new wording.

## Architecture

- `roonStats.js` (new) owns the regex, the entity list, the in-memory
  "latest values", and the push-to-HA logic.
- `logTail.js` (v1.2.0) calls `roonStats.parseStatsLine(line)` for every
  line it reads from `RoonServer_log.txt` - this reuses the existing
  tailed stream rather than opening a second SMB file handle.
- Parsing happens on every `[stats]` line (~every 14s), but pushing to HA
  only happens on a separate interval (`HA_STATS_PUSH_INTERVAL_MS`,
  default 60000ms / 1 minute) - keeps HA's recorder database growth
  reasonable while giving minute-resolution trend data.
- `index.js` (v1.1.0) starts `roonStats` alongside `logTail`.

## HA Entities (8)

| Entity ID                          | Unit | Source field                  |
|-------------------------------------|------|--------------------------------|
| `sensor.roon_memory_virtual`         | MB   | Virtual                         |
| `sensor.roon_memory_physical`        | MB   | Physical                        |
| `sensor.roon_memory_managed`         | MB   | Managed                         |
| `sensor.roon_memory_unmanaged`       | MB   | estimated Unmanaged             |
| `sensor.roon_handles`                | -    | Handles                         |
| `sensor.roon_threads`                | -    | Threads                         |
| `sensor.roon_gc_pause_percent`       | %    | % of runtime in GC pauses       |
| `sensor.roon_gc_pause_duration`      | ms   | last GC pause duration          |

Each is pushed via `POST /api/states/<entity_id>` with
`attributes: { friendly_name, unit_of_measurement, state_class: "measurement" }`.
`state_class: measurement` enables HA long-term statistics (history graphs
over days/weeks) for each entity.

**Known limitation:** entities created via the REST states API are not
restored across an HA restart - they'll briefly show "unavailable" until
the next push (within `HA_STATS_PUSH_INTERVAL_MS`). Not considered a
problem at a 1-minute interval.

## Configuration (env vars)

All optional - the feature is fully disabled (no-op, logged once at
startup) unless `SECRET_HA_TOKEN` is set.

| Env var                      | Default                          | Notes |
|-------------------------------|-----------------------------------|-------|
| `HA_BASE_URL`                  | `http://192.168.1.100:8123`       | HA instance |
| `SECRET_HA_TOKEN`              | *(unset)*                          | Long-lived access token for the `roon-radio-bridge` HA user |
| `HA_STATS_PUSH_INTERVAL_MS`    | `60000`                            | Push frequency |

## HA Setup (already done)

- Created a dedicated HA user `roon-radio-bridge` (mirrors the approach
  used for zigbee2mqtt - separate revocable token, separate audit trail).
- Initially non-admin; `POST /api/states/<entity_id>` returned `401` for
  that user despite `GET /api/` succeeding (200 `{"message":"API
  running."}`) - non-admin users could not create new states via the REST
  API.
- Made `roon-radio-bridge` an Administrator (Settings -> People -> Users
  -> Administrator toggle). Re-tested the same POST - succeeded (`200`
  with the new entity's state object). Confirmed end-to-end.
- Generated a Long-Lived Access Token from that user's profile (Security
  tab) - this is the value for `SECRET_HA_TOKEN`.

## Files Changed

| File                | Change |
|---------------------|--------|
| `roonStats.js`      | New - regex parsing, entity list, HA push |
| `logTail.js`        | v1.2.0 - calls `roonStats.parseStatsLine()` per line |
| `config.js`         | v1.5.0 - new `HA_*` config block |
| `index.js`          | v1.1.0 - starts `roonStats` alongside `logTail` |
| `Dockerfile`         | Added `roonStats.js` to the COPY list |
| `docker-compose.yml` | Added `HA_BASE_URL`, `SECRET_HA_TOKEN`, `HA_STATS_PUSH_INTERVAL_MS` |

## Status / Next Steps

1. **Not yet deployed.** Add `SECRET_HA_TOKEN` in Portainer's Environment
   variables panel for the `roon-radio-bridge` stack, redeploy.
2. Confirm the 8 entities appear in HA (Developer Tools -> States, search
   "roon_") and update with new values roughly once a minute.
3. Build dashboard cards for the 8 sensors.
4. Once a few days of baseline data exist, consider HA automations for
   exception-based notifications (e.g. `sensor.roon_handles` trending
   upward over hours = possible leak; `sensor.roon_gc_pause_percent`
   sustained high = possible memory pressure). Deliberately deferred until
   real baseline values are known - thresholds picked now would be guesses.
5. Watch the bridge logs for `[roonStats]` lines after deploy - both the
   "pushing every Nms" startup line and any throttled
   format-mismatch/push-failure warnings.
