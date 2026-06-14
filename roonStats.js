/*
 * ===========================================================================
 * File:        roonStats.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        14 June 2026
 * Version:     1.0.0
 *
 * Description:
 *   Parses the periodic "[stats]" health line from RoonServer_log.txt
 *   (the same log already tailed by logTail.js for Layer 2/3) and pushes
 *   the latest values to Home Assistant as sensor entities via the REST
 *   API states endpoint.
 *
 *   Observed log line (08/06/2026, RoonServer_log.txt):
 *     ... Info: [stats] 70464mb Virtual, 2412mb Physical, 1275mb Managed,
 *         1137mb estimated Unmanaged, 552 Handles, 70 Threads,
 *         1.07% of runtime in GC pauses, 24ms last GC pause duration
 *
 *   This format is based on a single observed sample, not on any published
 *   Roon documentation (none is known to exist for this line). If Roon
 *   changes the wording in a future update, STATS_REGEX will stop matching;
 *   see handleFormatMismatch() below for how that's surfaced in the logs
 *   without affecting any other bridge function.
 *
 *   Design notes:
 *   - parseStatsLine() is called from logTail.js's parseLine() for every
 *     line read from the log. This deliberately avoids a second SMB file
 *     handle/tailer - same approach, same stream, one more regex test per
 *     line (cheap).
 *   - The [stats] line appears roughly every 14 seconds. We do NOT push to
 *     HA that often - matched values are simply kept in memory, and a
 *     separate interval (HA_STATS_PUSH_INTERVAL_MS, default 60000) pushes
 *     the latest snapshot. This keeps HA's recorder database growth
 *     reasonable while still giving minute-resolution trend data.
 *   - If HA_TOKEN (env SECRET_HA_TOKEN) is not configured, start() logs
 *     once and does nothing further - this module is fully opt-in, in
 *     keeping with the env-var-driven pattern used elsewhere in this
 *     bridge.
 *   - Push failures (HA unreachable, bad token, etc.) are logged with
 *     throttling and never throw - Roon control must keep working
 *     regardless of HA's availability.
 * ===========================================================================
 */

const config = require('./config');

const HA_BASE_URL      = config.HA_BASE_URL;
const HA_TOKEN         = config.HA_TOKEN;
const PUSH_INTERVAL_MS = config.HA_STATS_PUSH_INTERVAL_MS;

// Matches the [stats] line described above. Capture groups (1-8) map
// 1:1 to the ENTITIES array below, in order.
const STATS_REGEX =
  /\[stats\]\s+(\d+)mb Virtual, (\d+)mb Physical, (\d+)mb Managed, (\d+)mb estimated Unmanaged, (\d+) Handles, (\d+) Threads, ([\d.]+)% of runtime in GC pauses, (\d+)ms last GC pause duration/;

// One entry per STATS_REGEX capture group, in order. unit_of_measurement
// is omitted (set to null) for plain counts (Handles, Threads).
const ENTITIES = [
  { entityId: 'sensor.roon_memory_virtual',    unit: 'MB',  friendlyName: 'Roon Virtual Memory' },
  { entityId: 'sensor.roon_memory_physical',   unit: 'MB',  friendlyName: 'Roon Physical Memory' },
  { entityId: 'sensor.roon_memory_managed',    unit: 'MB',  friendlyName: 'Roon Managed Memory' },
  { entityId: 'sensor.roon_memory_unmanaged',  unit: 'MB',  friendlyName: 'Roon Unmanaged Memory (est.)' },
  { entityId: 'sensor.roon_handles',           unit: null,  friendlyName: 'Roon Handle Count' },
  { entityId: 'sensor.roon_threads',           unit: null,  friendlyName: 'Roon Thread Count' },
  { entityId: 'sensor.roon_gc_pause_percent',  unit: '%',   friendlyName: 'Roon GC Pause %' },
  { entityId: 'sensor.roon_gc_pause_duration', unit: 'ms',  friendlyName: 'Roon Last GC Pause Duration' }
];

// Most recently parsed values, in ENTITIES order. null until the first
// [stats] line has been seen.
let latestValues = null;

let pushTimer               = null;
let consecutivePushErrors   = 0;
let consecutiveFormatErrors = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called from logTail.js for every line read from RoonServer_log.txt.
 * Cheap no-op for the vast majority of lines (single substring check).
 * If the line is a [stats] line, updates latestValues for the next push.
 */
function parseStatsLine(line) {
  if (!line.includes('[stats]')) return;

  const match = line.match(STATS_REGEX);
  if (!match) {
    handleFormatMismatch(line);
    return;
  }

  consecutiveFormatErrors = 0;
  latestValues = [
    Number(match[1]), // Virtual MB
    Number(match[2]), // Physical MB
    Number(match[3]), // Managed MB
    Number(match[4]), // estimated Unmanaged MB
    Number(match[5]), // Handles
    Number(match[6]), // Threads
    Number(match[7]), // % of runtime in GC pauses
    Number(match[8])  // last GC pause duration (ms)
  ];
}

/**
 * Starts the periodic push to Home Assistant. No-op (with an explanatory
 * log line) if HA_TOKEN is not configured.
 */
function start() {
  if (!HA_TOKEN) {
    console.log('[roonStats] SECRET_HA_TOKEN not configured - HA stats push disabled');
    return;
  }
  console.log(`[roonStats] Pushing Roon health stats to ${HA_BASE_URL} every ${PUSH_INTERVAL_MS}ms`);
  pushTimer = setInterval(pushToHA, PUSH_INTERVAL_MS);
}

function stop() {
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
}

/**
 * Returns the most recent parsed values alongside their entity metadata,
 * or null if no [stats] line has been seen yet. Not currently exposed via
 * an HTTP route, but kept available for future diagnostics (mirrors
 * logTail.getBufferSnapshot()).
 */
function getLatestStats() {
  if (!latestValues) return null;
  return ENTITIES.map((entity, i) => ({
    entityId: entity.entityId,
    value:    latestValues[i]
  }));
}

// ---------------------------------------------------------------------------
// HA push implementation
// ---------------------------------------------------------------------------

/**
 * Pushes the latest parsed values to HA, one entity per value. Skips
 * silently if no [stats] line has been seen yet (expected for the first
 * ~14s after startup).
 */
async function pushToHA() {
  if (!latestValues) return;

  for (let i = 0; i < ENTITIES.length; i++) {
    const entity = ENTITIES[i];
    const value  = latestValues[i];

    const attributes = {
      friendly_name: entity.friendlyName,
      state_class:   'measurement'
    };
    if (entity.unit) attributes.unit_of_measurement = entity.unit;

    try {
      const res = await fetch(`${HA_BASE_URL}/api/states/${entity.entityId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HA_TOKEN}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ state: value, attributes })
      });

      if (!res.ok) {
        handlePushError(entity.entityId, `HTTP ${res.status}`);
      } else {
        consecutivePushErrors = 0;
      }
    } catch (err) {
      handlePushError(entity.entityId, err.message);
    }
  }
}

// Throttled error logging - avoids log spam if HA is unreachable for an
// extended period. Mirrors the approach in logTail.js's handleAccessError.
function handlePushError(entityId, message) {
  consecutivePushErrors++;
  if (consecutivePushErrors === 1 || consecutivePushErrors % 60 === 0) {
    console.log(`[roonStats] HA push failed for ${entityId} (${consecutivePushErrors} consecutive): ${message}`);
  }
}

// Throttled warning if a [stats] line is seen but doesn't match
// STATS_REGEX - most likely cause is Roon changing the line's wording in
// an update. Logged but otherwise harmless: latestValues simply stops
// updating, so HA entities hold their last known value.
function handleFormatMismatch(line) {
  consecutiveFormatErrors++;
  if (consecutiveFormatErrors === 1 || consecutiveFormatErrors % 60 === 0) {
    console.log(`[roonStats] [stats] line did not match expected format (${consecutiveFormatErrors} consecutive): ${line.trim()}`);
  }
}

module.exports = {
  parseStatsLine,
  start,
  stop,
  getLatestStats
};
