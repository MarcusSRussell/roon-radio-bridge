/*
 * ===========================================================================
 * File:        roonStats.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        14 June 2026
 * Version:     2.0.0
 *
 * Description:
 *   Parses the periodic "[stats]" health line from RoonServer_log.txt
 *   (the same log already tailed by logTail.js for Layer 2/3) and exposes
 *   the latest values via GET /roonAPI/stats, for Home Assistant's
 *   RESTful integration to poll.
 *
 *   v2.0.0: Replaced the v1.0.0 push-to-HA design (POST to
 *   /api/states/<entity_id> on an interval, requiring an admin-level
 *   SECRET_HA_TOKEN) with a pull model. Reasons for the change:
 *     - Entities created via POST /api/states/ aren't registered in HA's
 *       entity registry, so they lack unique_id and don't show up
 *       properly in the GUI (dashboards, entity picker, full attribute
 *       view) - only in Developer Tools -> States.
 *     - HA's RESTful integration (configured via Settings -> Devices &
 *       Services -> Add Integration -> RESTful) creates proper
 *       registry-backed entities automatically.
 *     - Removes the need for an admin-level HA token entirely - this
 *       endpoint is a plain unauthenticated GET, consistent with the
 *       bridge's other diagnostic/status routes.
 *   v1.0.0's push logic, the HA_BASE_URL / SECRET_HA_TOKEN /
 *   HA_STATS_PUSH_INTERVAL_MS config, and start()/stop() are gone.
 *
 *   Observed log line (08/06/2026, RoonServer_log.txt):
 *     ... Info: [stats] 70464mb Virtual, 2412mb Physical, 1275mb Managed,
 *         1137mb estimated Unmanaged, 552 Handles, 70 Threads,
 *         1.07% of runtime in GC pauses, 24ms last GC pause duration
 *
 *   This format is based on a single observed sample, not on any published
 *   Roon documentation (none is known to exist for this line). If Roon
 *   changes the wording, STATS_REGEX will stop matching; see
 *   handleFormatMismatch() below for how that's surfaced in the logs
 *   without affecting any other bridge function.
 *
 *   Design notes:
 *   - parseStatsLine() is called from logTail.js's parseLine() for every
 *     line read from the log (unchanged from v1.0.0) - this reuses the
 *     existing tailed stream rather than opening a second SMB file handle.
 *   - getLatestStats() returns a flat object keyed by STAT_KEYS, with all
 *     values null until the first [stats] line has been seen (briefly,
 *     after startup). The JSON shape is always the same 8 keys, so HA's
 *     value_templates never hit a missing key.
 * ===========================================================================
 */

// Matches the [stats] line described above. Capture groups (1-8) map
// 1:1 to STAT_KEYS below, in order.
const STATS_REGEX =
  /\[stats\]\s+(\d+)mb Virtual, (\d+)mb Physical, (\d+)mb Managed, (\d+)mb estimated Unmanaged, (\d+) Handles, (\d+) Threads, ([\d.]+)% of runtime in GC pauses, (\d+)ms last GC pause duration/;

// One key per STATS_REGEX capture group, in order. These are the JSON
// field names returned by getLatestStats() / GET /roonAPI/stats.
const STAT_KEYS = [
  'memory_virtual_mb',
  'memory_physical_mb',
  'memory_managed_mb',
  'memory_unmanaged_mb',
  'handles',
  'threads',
  'gc_pause_percent',
  'gc_pause_duration_ms'
];

// Most recently parsed values, keyed by STAT_KEYS. All null until the
// first [stats] line has been seen.
let latestValues = Object.fromEntries(STAT_KEYS.map(key => [key, null]));

let consecutiveFormatErrors = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called from logTail.js for every line read from RoonServer_log.txt.
 * Cheap no-op for the vast majority of lines (single substring check).
 * If the line is a [stats] line, updates latestValues.
 */
function parseStatsLine(line) {
  if (!line.includes('[stats]')) return;

  const match = line.match(STATS_REGEX);
  if (!match) {
    handleFormatMismatch(line);
    return;
  }

  consecutiveFormatErrors = 0;

  for (let i = 0; i < STAT_KEYS.length; i++) {
    latestValues[STAT_KEYS[i]] = Number(match[i + 1]);
  }
}

/**
 * Returns the latest parsed values as a flat object, e.g.:
 *   { memory_virtual_mb: 70464, ..., gc_pause_duration_ms: 24 }
 * All values are null until the first [stats] line has been seen
 * (briefly, after startup). Used by GET /roonAPI/stats.
 */
function getLatestStats() {
  return { ...latestValues };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Throttled warning if a [stats] line is seen but doesn't match
// STATS_REGEX - most likely cause is Roon changing the line's wording in
// an update. Logged but otherwise harmless: latestValues simply stops
// updating, so /roonAPI/stats keeps returning the last known values.
function handleFormatMismatch(line) {
  consecutiveFormatErrors++;
  if (consecutiveFormatErrors === 1 || consecutiveFormatErrors % 60 === 0) {
    console.log(`[roonStats] [stats] line did not match expected format (${consecutiveFormatErrors} consecutive): ${line.trim()}`);
  }
}

module.exports = {
  parseStatsLine,
  getLatestStats
};
