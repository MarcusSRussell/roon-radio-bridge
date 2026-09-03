/*
 * ===========================================================================
 * File:        roonStats.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        03 September 2026
 * Version:     2.1.0
 *
 * Description:
 *   Parses the periodic "[stats]" health line from RoonServer_log.txt
 *   (the same log already tailed by logTail.js for Layer 2/3) and exposes
 *   the latest values via GET /roonAPI/stats, for Home Assistant's
 *   RESTful integration to poll.
 *
 *   v2.1.0: Updated STATS_REGEX and STAT_KEYS to match Roon's new [stats]
 *   line format, observed from approximately August 2026. The old format
 *   used comma-separated fields with "Managed" and "estimated Unmanaged"
 *   as top-level memory fields. The new format uses semicolons as major
 *   separators and provides a richer memory breakdown:
 *
 *   Old (v2.0.0):
 *     70464mb Virtual, 2412mb Physical, 1275mb Managed,
 *     1137mb estimated Unmanaged, 552 Handles, 70 Threads,
 *     1.07% of runtime in GC pauses, 24ms last GC pause duration
 *     (8 extractable values)
 *
 *   New (v2.1.0):
 *     70142mb Virtual; 2054mb Physical = 862mb GC-committed
 *     (643mb Managed-live = 74% of committed) + 1192mb Native;
 *     472 Handles, 74 Threads, 0.68% of runtime in GC pauses,
 *     96ms GC pause in last window (0.64% of window)
 *     (11 extractable values)
 *
 *   The 6 values that map cleanly (Virtual, Physical, Handles, Threads,
 *   GC pause %, GC pause duration) keep the same JSON keys where possible.
 *   The old "Managed" and "estimated Unmanaged" keys are replaced by
 *   "memory_gc_committed_mb", "memory_managed_live_mb",
 *   "memory_managed_live_percent", and "memory_native_mb".
 *   Three new fields are added: see STAT_KEYS below.
 *   HA configuration.yaml must be updated alongside this change -
 *   see HA_STATS_REPORTING.md.
 *
 *   The format caveat (no known Roon documentation for this line) still
 *   applies. If the format changes again, the throttled
 *   "[stats] line did not match expected format" log warning will fire -
 *   update STATS_REGEX and STAT_KEYS to match.
 * ===========================================================================
 */

// Matches the new [stats] line format (observed from ~Aug 2026).
// 11 capture groups - each maps to a STAT_KEYS entry in order.
const STATS_REGEX =
  /\[stats\]\s+(\d+)mb Virtual; (\d+)mb Physical = (\d+)mb GC-committed \((\d+)mb Managed-live = (\d+)% of committed\) \+ (\d+)mb Native; (\d+) Handles, (\d+) Threads, ([\d.]+)% of runtime in GC pauses, (\d+)ms GC pause in last window \(([\d.]+)% of window\)/;

// One key per STATS_REGEX capture group, in order.
// These are the JSON field names returned by GET /roonAPI/stats.
const STAT_KEYS = [
  'memory_virtual_mb',            // group 1:  Virtual
  'memory_physical_mb',           // group 2:  Physical (total)
  'memory_gc_committed_mb',       // group 3:  GC-committed (heap reserved by runtime)
  'memory_managed_live_mb',       // group 4:  Managed-live (live managed objects)
  'memory_managed_live_percent',  // group 5:  Managed-live as % of GC-committed
  'memory_native_mb',             // group 6:  Native (unmanaged/native heap)
  'handles',                      // group 7:  OS handle count
  'threads',                      // group 8:  Thread count
  'gc_pause_percent',             // group 9:  % of runtime spent in GC pauses
  'gc_pause_last_window_ms',      // group 10: GC pause duration in last reporting window (ms)
  'gc_pause_window_percent'       // group 11: GC pause as % of last reporting window
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
 * Returns the latest parsed values as a flat object. All values are null
 * until the first [stats] line has been seen (briefly, after startup).
 * Used by GET /roonAPI/stats.
 */
function getLatestStats() {
  return { ...latestValues };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function handleFormatMismatch(line) {
  consecutiveFormatErrors++;
  if (consecutiveFormatErrors === 1 || consecutiveFormatErrors % 60 === 0) {
    console.log('[roonStats] [stats] line did not match expected format (' + consecutiveFormatErrors + ' consecutive): ' + line.trim());
  }
}

module.exports = {
  parseStatsLine,
  getLatestStats
};
