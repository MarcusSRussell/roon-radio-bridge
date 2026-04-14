/*
 * ===========================================================================
 * File:        bridgeCommands.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        17 April 2026
 * Version:     1.3.0 (Layer 3 v2)
 *
 * Description:
 *   Records every transport control command issued by this bridge (in
 *   response to HTTP requests to its routes). The watchdog consults this
 *   tracker first when analysing a stop event, giving instant and
 *   race-free knowledge of whether the bridge itself caused the stop.
 *
 *   This is the cleaner alternative to reading our own commands back
 *   through the Roon log - we already know what we sent.
 *
 *   Entries are pruned after RETENTION_MS to keep the list small.
 * ===========================================================================
 */

const RETENTION_MS = 10000;

const commands = [];  // { timestamp, zoneOrOutputId, control }

function note(zoneOrOutputId, control) {
  if (!zoneOrOutputId) return;
  commands.push({
    timestamp: Date.now(),
    zoneOrOutputId,
    control
  });
  prune();
}

function isRecent(zoneOrOutputId, withinMs, controlTypes) {
  const cutoff = Date.now() - withinMs;
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].timestamp < cutoff) return false;
    if (commands[i].zoneOrOutputId !== zoneOrOutputId) continue;
    if (controlTypes && !controlTypes.includes(commands[i].control)) continue;
    return true;
  }
  return false;
}

function snapshot() {
  return commands.slice();
}

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  while (commands.length > 0 && commands[0].timestamp < cutoff) {
    commands.shift();
  }
}

module.exports = { note, isRecent, snapshot };
