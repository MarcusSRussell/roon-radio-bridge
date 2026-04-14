/*
 * ===========================================================================
 * File:        logTail.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.1.0 (Layer 2)
 *
 * Description:
 *   Tails RoonServer_log.txt from the mounted ROCK SMB share and maintains
 *   a rolling in-memory buffer of recent transport control commands issued
 *   by any API client. Layer 3's watchdog will query this buffer to
 *   distinguish legitimate stops (from the Arduino, touchscreen, Roon app,
 *   or any extension) from the rogue stop that is the Roon live-radio bug.
 *
 *   The log line signature we care about:
 *     [roonapi] [apiclient X.X.X.X:YYYY] GOT com.roonlabs.transport:2/control
 *       {"zone_or_output_id":"...","control":"play|pause|stop|playpause|..."}
 *
 *   Design notes:
 *   - On startup we seek to the end of the current log file so we don't
 *     replay history. Only new events are captured.
 *   - Rotation is detected by watching for either an inode change or the
 *     file shrinking below our last-read position.
 *   - SMB mount drops are handled gracefully: the tailer logs the error,
 *     backs off, and retries on the next poll.
 *   - The buffer retains entries for BUFFER_WINDOW_MS milliseconds and
 *     prunes older ones on each append.
 *   - A public query function isRecentCommand(zoneOrOutputId, withinMs)
 *     is exposed for Layer 3.
 * ===========================================================================
 */

const fs   = require('fs');
const path = require('path');

const LOG_PATH         = '/mnt/rock-logs/RoonServer/Logs/RoonServer_log.txt';
const POLL_INTERVAL_MS = 100;        // how often to check for new log lines
const BUFFER_WINDOW_MS = 60 * 1000;  // keep last 60 seconds of events
const READ_CHUNK_SIZE  = 64 * 1024;  // 64 KB per read

// Rolling buffer of recent transport control events.
// Each entry: { timestamp, clientIp, zoneOrOutputId, control, raw }
const commandBuffer = [];

// Tailer state
let currentInode   = null;
let readPosition   = 0;
let lineRemainder  = '';
let pollTimer      = null;
let consecutiveErrors = 0;

// Regex matching the transport control log line we care about.
// Example line:
// 04/09 06:48:41 [Local ...] Trace: [roonapi] [apiclient 192.168.1.176:32872]
//   GOT com.roonlabs.transport:2/control {"zone_or_output_id":"16012544...","control":"playpause"}
const TRANSPORT_CONTROL_REGEX =
  /\[roonapi\]\s+\[apiclient\s+([\d.]+:\d+)\]\s+GOT\s+com\.roonlabs\.transport:2\/control\s+(\{.*\})/;

// ---------------------------------------------------------------------------
// Public API (consumed by Layer 3 watchdog and diagnostic route)
// ---------------------------------------------------------------------------

/**
 * Returns true if any API client issued a transport control command for
 * the given zone or output ID within the last `withinMs` milliseconds.
 */
function isRecentCommand(zoneOrOutputId, withinMs, controlTypes) {
  return findRecentCommand(zoneOrOutputId, withinMs, controlTypes) !== null;
}

/**
 * Like isRecentCommand but returns the actual matching entry (with
 * clientIp etc.) or null. Optional controlTypes array filters by the
 * control field (play/pause/stop/playpause/...).
 */
function findRecentCommand(zoneOrOutputId, withinMs, controlTypes) {
  const cutoff = Date.now() - withinMs;
  for (let i = commandBuffer.length - 1; i >= 0; i--) {
    const entry = commandBuffer[i];
    if (entry.timestamp < cutoff) return null;
    if (entry.zoneOrOutputId !== zoneOrOutputId) continue;
    if (controlTypes && !controlTypes.includes(entry.control)) continue;
    return entry;
  }
  return null;
}

/**
 * Returns a copy of the current buffer contents for diagnostic purposes.
 * Used by the /roonAPI/logTail/recent HTTP route.
 */
function getBufferSnapshot() {
  return {
    mounted:      currentInode !== null,
    bufferLength: commandBuffer.length,
    windowMs:     BUFFER_WINDOW_MS,
    entries:      commandBuffer.slice()
  };
}

// ---------------------------------------------------------------------------
// Tailing implementation
// ---------------------------------------------------------------------------

function start() {
  console.log(`[logTail] Starting tailer on ${LOG_PATH}`);
  initialiseFromEnd();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Seek to end of file on startup so we don't reprocess historical entries.
function initialiseFromEnd() {
  try {
    const stats = fs.statSync(LOG_PATH);
    currentInode = stats.ino;
    readPosition = stats.size;
    consecutiveErrors = 0;
    console.log(`[logTail] Initialised at offset ${readPosition} (inode ${currentInode})`);
  } catch (err) {
    handleAccessError('initialise', err);
  }
}

// Called on every poll tick. Detects rotation and reads new content.
function poll() {
  let stats;
  try {
    stats = fs.statSync(LOG_PATH);
  } catch (err) {
    handleAccessError('stat', err);
    return;
  }

  // If we previously couldn't access the file and now can, re-initialise
  if (currentInode === null) {
    currentInode = stats.ino;
    readPosition = stats.size;
    lineRemainder = '';
    console.log(`[logTail] File accessible again, resuming at offset ${readPosition}`);
    return;
  }

  // Detect log rotation: inode change or file shrunk below our read position
  if (stats.ino !== currentInode || stats.size < readPosition) {
    console.log(`[logTail] Log rotation detected (inode ${currentInode} -> ${stats.ino}), reading from start`);
    currentInode = stats.ino;
    readPosition = 0;
    lineRemainder = '';
  }

  // Nothing new to read
  if (stats.size === readPosition) return;

  // Read new content in chunks
  try {
    const fd = fs.openSync(LOG_PATH, 'r');
    try {
      while (readPosition < stats.size) {
        const buffer = Buffer.alloc(READ_CHUNK_SIZE);
        const bytesToRead = Math.min(READ_CHUNK_SIZE, stats.size - readPosition);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, readPosition);
        if (bytesRead === 0) break;
        readPosition += bytesRead;
        processChunk(buffer.toString('utf8', 0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    consecutiveErrors = 0;
  } catch (err) {
    handleAccessError('read', err);
  }

  // Prune old entries on every poll
  pruneBuffer();
}

// Split chunk into lines, carrying any partial line across chunk boundaries
function processChunk(chunk) {
  const combined = lineRemainder + chunk;
  const lines    = combined.split('\n');
  lineRemainder  = lines.pop();  // last element may be partial
  for (const line of lines) {
    if (line) parseLine(line);
  }
}

// Parse a single log line and append to buffer if it's a transport control
function parseLine(line) {
  const match = line.match(TRANSPORT_CONTROL_REGEX);
  if (!match) return;

  const clientIp = match[1];
  const jsonStr  = match[2];

  let zoneOrOutputId = null;
  let control        = null;
  try {
    const payload = JSON.parse(jsonStr);
    zoneOrOutputId  = payload.zone_or_output_id || null;
    control         = payload.control            || null;
  } catch (err) {
    // Malformed JSON, skip
    return;
  }

  if (!zoneOrOutputId || !control) return;

  const entry = {
    timestamp:      Date.now(),
    clientIp:       clientIp,
    zoneOrOutputId: zoneOrOutputId,
    control:        control,
    raw:            line.trim()
  };
  commandBuffer.push(entry);
  console.log(`[logTail] ${clientIp} -> ${control} on ${zoneOrOutputId.substring(0, 8)}...`);
}

// Remove entries older than BUFFER_WINDOW_MS
function pruneBuffer() {
  const cutoff = Date.now() - BUFFER_WINDOW_MS;
  while (commandBuffer.length > 0 && commandBuffer[0].timestamp < cutoff) {
    commandBuffer.shift();
  }
}

// Centralised error handling with backoff logging (avoids log spam when
// the SMB mount is down)
function handleAccessError(operation, err) {
  consecutiveErrors++;
  currentInode = null;  // force re-initialise on next successful access
  if (consecutiveErrors === 1 || consecutiveErrors % 60 === 0) {
    console.log(`[logTail] ${operation} error (${consecutiveErrors} consecutive): ${err.message}`);
  }
}

module.exports = {
  start,
  stop,
  isRecentCommand,
  findRecentCommand,
  getBufferSnapshot
};
