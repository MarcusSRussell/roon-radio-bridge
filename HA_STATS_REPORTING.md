# HA Stats Reporting - Knowledge File

**Application:** Roon Radio Bridge
**Author:** Marcus Russell
**Date:** 14 June 2026
**Version:** 2.0.0 (pull-based redesign)

## Purpose

Exposes Roon Core's periodic health/diagnostic stats (memory, handles,
threads, GC pause behaviour) for Home Assistant, for dashboard visibility
and (eventually) automation-based alerting on exceptions. Prompted by
noticing a `[stats]` line in `RoonServer_log.txt`.

## v1 -> v2: Why This Changed

v1.0.0 had the bridge push values to HA via `POST /api/states/<entity_id>`
on a 1-minute timer, using a long-lived token for a dedicated admin user
(`roon-radio-bridge`). This worked (values appeared in Developer Tools ->
States and updated correctly), but:

- Entities created this way aren't registered in HA's **entity registry**,
  so they have no `unique_id` and don't behave like normal entities in the
  GUI - they're invisible to the dashboard entity picker, Settings ->
  Entities, and the full attribute view in the more-info dialog. Only
  Developer Tools -> States shows them properly.
- It required an **Administrator**-level HA token (non-admin users got
  `401` on the states-write endpoint), which was a security tradeoff we
  accepted reluctantly at the time.

v2.0.0 flips the direction: **the bridge exposes a read-only endpoint, and
HA pulls from it** using the built-in RESTful integration. Because that's
a UI-configured integration, HA creates proper registry-backed entities
(with `unique_id`) automatically - full GUI support, for free, and no HA
token of any kind is needed.

## Source Data (unchanged from v1)

The `[stats]` line is written by Roon Core roughly every 14 seconds.
Example:

```
06/14 08:50:35 [Local 06/14 09:50:35] Info: [stats] 70464mb Virtual,
2412mb Physical, 1275mb Managed, 1137mb estimated Unmanaged, 552 Handles,
70 Threads, 1.07% of runtime in GC pauses, 24ms last GC pause duration
```

**Caveat (unchanged):** this format is based on a single observed sample
line, with no known published Roon documentation. If Roon changes the
wording, `roonStats.js` logs a throttled
`[stats] line did not match expected format` warning - if you see that,
the regex in `roonStats.js` needs updating. Harmless otherwise:
`/roonAPI/stats` just keeps returning the last known values.

## Architecture (v2)

- `roonStats.js` parses every `[stats]` line (called from `logTail.js`,
  same as v1 - no second SMB file handle) and keeps the latest values in
  memory as a flat object.
- `routes.js` adds `GET /roonAPI/stats`, returning that object as JSON.
- HA's RESTful integration polls this endpoint (suggested: every 60s) and
  defines 8 sensors via `value_template`.
- No push interval, no HA token, no `start()`/`stop()` - the endpoint just
  answers on demand.

## GET /roonAPI/stats

Example response (all fields `null` until the first `[stats]` line has
been seen, e.g. briefly after startup):

```json
{
  "memory_virtual_mb": 70464,
  "memory_physical_mb": 2412,
  "memory_managed_mb": 1275,
  "memory_unmanaged_mb": 1137,
  "handles": 552,
  "threads": 70,
  "gc_pause_percent": 1.07,
  "gc_pause_duration_ms": 24
}
```

Unauthenticated GET, consistent with the bridge's other diagnostic routes
(`/roonAPI/listZones`, `/roonAPI/logTail/recent`, etc.) - no control
capability, just current numbers.

## HA Setup (to do)

1. **Verify the endpoint first**, before touching HA - from any machine on
   the LAN:
   ```
   curl http://192.168.1.103:33262/roonAPI/stats
   ```
   Confirm you get the JSON shown above with real (non-null) numbers.

2. **Settings -> Devices & Services -> Add Integration -> "RESTful"**.
   - Resource: `http://192.168.1.103:33262/roonAPI/stats`
   - Method: GET
   - Scan interval: 60 (seconds)
   - HA will fetch the resource and then prompt you to define sensors
     from the JSON response.

3. For each of the 8 fields, add a sensor with:
   - **Value template**: `{{ value_json.<field_name> }}` (field names as
     in the JSON above, e.g. `{{ value_json.handles }}`)
   - **Unit of measurement**: `MB` / `ms` / `%` as appropriate, blank for
     `handles`/`threads`
   - **State class**: `Measurement` - enables HA long-term statistics
     (history graphs over days/weeks)

   (Exact wording/steps in HA's UI may vary slightly by version - the
   above is the general shape. The important parts are the resource URL,
   the `value_json.<field>` template syntax, and setting `state_class` so
   long-term stats work.)

## Cleanup from v1 (optional)

These are no longer used by the bridge, but nothing breaks if left as-is:

- `SECRET_HA_TOKEN` env var in Portainer - can be removed.
- The dedicated `roon-radio-bridge` HA user / its long-lived access token -
  can be deleted, or left dormant for a future feature that needs to push
  *into* HA (this pull-based approach doesn't need it, but some future
  thing might).

## Files Changed (v1 -> v2)

| File                | Change |
|---------------------|--------|
| `roonStats.js`      | v2.0.0 - removed push/HA-token logic; `getLatestStats()` now returns a flat JSON-ready object |
| `routes.js`         | v1.1.0 - added `GET /roonAPI/stats` |
| `index.js`          | v1.1.0 - removed `roonStats.start()` (no longer a separate process) |
| `config.js`         | v1.4.0 - removed `HA_*`/`SECRET_HA_TOKEN` config (reverted to pre-v1 state) |
| `docker-compose.yml` | Removed `HA_BASE_URL`, `SECRET_HA_TOKEN`, `HA_STATS_PUSH_INTERVAL_MS` |
| `logTail.js`        | Unchanged from v1.2.0 - the `roonStats.parseStatsLine()` hook is still correct |
| `Dockerfile`         | Unchanged - `roonStats.js` already in the COPY list |

## Status / Next Steps

1. Merge these changes (same workflow as before: copy files into
   `/opt/roon-radio-bridge`, `git add`/`commit`/`push`, then "Pull and
   redeploy" with "Re-pull image and redeploy" checked in Portainer, since
   `routes.js`/`index.js`/`roonStats.js`/`config.js` all changed).
2. After redeploy, `curl http://192.168.1.103:33262/roonAPI/stats` to
   confirm the new route works and returns real numbers.
3. Set up the RESTful integration in HA as above.
4. Confirm all 8 entities appear in Settings -> Entities (proper
   registry-backed entities this time) and on a dashboard.
5. Once a few days of baseline data exist, consider automations for
   exception-based notifications - deliberately deferred until real
   baseline values are known.
