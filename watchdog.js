/*
 * ===========================================================================
 * File:        watchdog.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        17 April 2026
 * Version:     1.3.0 (Layer 3 v2)
 *
 * Description:
 *   Live radio stream watchdog for the KitchenPi zone. Works around the
 *   suspected RoPieee/AirPlay interaction where live radio streams
 *   sometimes spontaneously pause when Apple devices probe for AirPlay
 *   targets. Roon converts the pause to a stop because live streams
 *   cannot be paused.
 *
 *   Control Mode Model
 *   ------------------
 *   Two modes:
 *
 *     direct   - Radio is under hardware control. Watchdog active.
 *                Entered/maintained by any control action from a Direct
 *                Control surface: the Arduino or RoPieee touchscreen
 *                (preset button, play, pause, stop, playpause).
 *                Volume and mute are not control mode signals.
 *
 *     indirect - Anything else: Roon app, AirPlay, other extensions.
 *                Watchdog dormant.
 *
 *   Classifying commands as Direct vs Indirect:
 *
 *     Commands issued by this bridge itself (recorded in bridgeCommands)
 *     are always Direct Control - the bridge only receives them from
 *     the Arduino and touchscreen.
 *
 *     Commands seen in the Roon log are classified by source IP:
 *
 *       IP in DIRECT_CONTROL_IPS -> Direct Control
 *         - WWMS itself (commands the bridge issues appear here too)
 *         - RoPieee touchscreen
 *
 *       Any other IP -> Indirect Control
 *         - Roon app, other extensions, etc.
 *
 *   Detection Logic on playing -> stopped transition
 *   -------------------------------------------------
 *
 *     1. Did this bridge issue the stop command? (instant, no race)
 *        Yes -> Direct Control stop. Stay in/enter direct, exit here.
 *
 *     2. Does the log show a command from a Direct Control IP?
 *        Yes -> Direct Control stop. Stay in/enter direct, exit here.
 *
 *     3. Does the log show a command from an Indirect Control IP?
 *        Yes -> Indirect Control stop. Switch to indirect, exit here.
 *
 *     4. No command found anywhere. It is the bug (or similar
 *        invisible source like the Roon app).
 *        If currently in direct mode:
 *          - Two unexplained stops in REARM_WINDOW_MS -> treat as
 *            deliberate, switch to indirect
 *          - Otherwise schedule auto-resume (if AUTO_RESUME_ENABLED)
 *
 *   Diagnostic / AutoResume
 *   -----------------------
 *   AUTO_RESUME_ENABLED = false (default): watchdog detects and logs bug
 *   events prominently but does NOT issue a play command. This allows
 *   the user to capture RoPieee logs at the moment of failure without
 *   the watchdog masking the event.
 *
 *   AUTO_RESUME_ENABLED = true: normal operation - bridge auto-resumes
 *   after RESUME_DELAY_MS.
 * ===========================================================================
 */

const { state: roonState } = require('./roon');
const logTail              = require('./logTail');
const bridgeCommands        = require('./bridgeCommands');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const KITCHEN_PI_ZONE_ID   = '16012544785f8b36a95b4cf93ed846179af7';
const KITCHEN_PI_OUTPUT_ID = '17012544785f8b36a95b4cf93ed846179af7';

// IPs of Direct Control surfaces. Commands appearing in the Roon log
// from these IPs put/keep the watchdog in direct mode. Other IPs are
// treated as Indirect Control (Roon app, other extensions).
//
// In the dockerised version this list will be loaded from an env var
// DIRECT_CONTROL_IPS=192.168.1.103,192.168.1.176
const DIRECT_CONTROL_IPS = [
  '192.168.1.103',  // WWMS - the bridge itself
  '192.168.1.176'   // RoPieee touchscreen
];

// Diagnostic mode: when false, detection and logging happen but no
// auto-resume is issued. Flip to true once the RoPieee investigation
// is complete.
const AUTO_RESUME_ENABLED = true;

const COMMAND_LOOKBACK_MS = 3000;   // how far back in tracker/log to check
const RESUME_DELAY_MS     = 2500;   // wait before auto-resume
const REARM_WINDOW_MS     = 30000;  // two unexplained stops = user intent

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let controlMode          = 'indirect';
let lastAutoResumeTime   = 0;
let pendingResumeTimeout = null;
let lastBugEventTime     = null;
let enabled              = true;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called by api/radio.js when a preset is successfully played. The
 * strongest possible Direct Control signal.
 */
function notePresetPlay(presetNumber, stationTitle) {
  controlMode = 'direct';
  console.log(`[watchdog] Direct control (preset ${presetNumber}: ${stationTitle})`);
}

/**
 * Called by roon.js on every zone state transition.
 */
function onZoneTransition(zoneId, prevState, newState, zone) {
  if (zoneId !== KITCHEN_PI_ZONE_ID) return;
  if (!enabled) return;

  if (prevState === 'playing' && newState === 'stopped') {
    handleStopEvent(zone);
  }
}

function getStatus() {
  return {
    enabled,
    autoResumeEnabled:  AUTO_RESUME_ENABLED,
    controlMode,
    lastAutoResumeTime,
    lastBugEventTime,
    pendingResume:      pendingResumeTimeout !== null,
    kitchenPiZoneId:    KITCHEN_PI_ZONE_ID,
    kitchenPiOutputId:  KITCHEN_PI_OUTPUT_ID,
    directControlIps:   DIRECT_CONTROL_IPS,
    commandLookbackMs:  COMMAND_LOOKBACK_MS,
    resumeDelayMs:      RESUME_DELAY_MS,
    rearmWindowMs:      REARM_WINDOW_MS
  };
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

// Controls that could plausibly cause a zone to transition to stopped.
// Used to filter the command trackers so a recent 'play' command does
// not get mistakenly credited as the cause of a stop event.
const STOP_CAUSING_CONTROLS = ['stop', 'pause', 'playpause'];

function handleStopEvent(zone) {
  // Step 1: did this bridge itself issue a stop-causing command?
  if (bridgeCommands.isRecent(KITCHEN_PI_ZONE_ID,   COMMAND_LOOKBACK_MS, STOP_CAUSING_CONTROLS) ||
      bridgeCommands.isRecent(KITCHEN_PI_OUTPUT_ID, COMMAND_LOOKBACK_MS, STOP_CAUSING_CONTROLS)) {
    if (controlMode !== 'direct') {
      controlMode = 'direct';
      console.log('[watchdog] Direct control (bridge command - Arduino)');
    } else {
      console.log('[watchdog] Stop via bridge (Arduino) - staying in direct');
    }
    return;
  }

  // Step 2/3: does the log show a stop-causing command?
  const logByZone   = logTail.findRecentCommand(KITCHEN_PI_ZONE_ID,   COMMAND_LOOKBACK_MS, STOP_CAUSING_CONTROLS);
  const logByOutput = logTail.findRecentCommand(KITCHEN_PI_OUTPUT_ID, COMMAND_LOOKBACK_MS, STOP_CAUSING_CONTROLS);
  const logEntry    = logByZone || logByOutput;

  if (logEntry) {
    const sourceIp = logEntry.clientIp.split(':')[0];
    if (DIRECT_CONTROL_IPS.includes(sourceIp)) {
      if (controlMode !== 'direct') {
        controlMode = 'direct';
        console.log(`[watchdog] Direct control (log: ${sourceIp} ${logEntry.control})`);
      } else {
        console.log(`[watchdog] Stop via Direct Control surface (${sourceIp}) - staying in direct`);
      }
      return;
    } else {
      console.log(`[watchdog] Indirect Control stop from ${sourceIp} - exiting direct mode`);
      controlMode = 'indirect';
      return;
    }
  }

  // Step 4: no command found - this is the bug (or an invisible source
  // like the Roon app).
  lastBugEventTime = new Date().toISOString();
  console.log(`[watchdog] *** UNEXPLAINED STOP at ${lastBugEventTime} *** (no command from any client)`);

  if (controlMode !== 'direct') {
    console.log('[watchdog] Not in direct mode - no action taken');
    return;
  }

  // Two unexplained stops within the rearm window = user deliberately
  // stopping via an invisible path (e.g. iPhone Roon app). Give up.
  const now = Date.now();
  if (now - lastAutoResumeTime < REARM_WINDOW_MS) {
    console.log('[watchdog] Second unexplained stop within rearm window - treating as deliberate, exiting direct');
    controlMode = 'indirect';
    if (pendingResumeTimeout) {
      clearTimeout(pendingResumeTimeout);
      pendingResumeTimeout = null;
    }
    return;
  }

  if (!AUTO_RESUME_ENABLED) {
    console.log('[watchdog] AUTO_RESUME_ENABLED=false - diagnostic mode, no resume issued');
    console.log('[watchdog] Capture the RoPieee log now if needed, then manually resume');
    return;
  }

  console.log(`[watchdog] Auto-resume scheduled in ${RESUME_DELAY_MS}ms`);
  pendingResumeTimeout = setTimeout(attemptResume, RESUME_DELAY_MS);
}

function attemptResume() {
  pendingResumeTimeout = null;

  if (!roonState.transport) {
    console.log('[watchdog] Cannot resume - transport service unavailable');
    return;
  }

  const zone = roonState.transport.zone_by_zone_id(KITCHEN_PI_ZONE_ID);
  if (!zone) {
    console.log('[watchdog] Cannot resume - zone no longer exists');
    return;
  }
  if (zone.state !== 'stopped') {
    console.log(`[watchdog] Resume aborted - zone is now ${zone.state}`);
    return;
  }
  if (controlMode !== 'direct') {
    console.log('[watchdog] Resume aborted - no longer in direct mode');
    return;
  }

  console.log('[watchdog] Auto-resuming KitchenPi');
  lastAutoResumeTime = Date.now();
  bridgeCommands.note(KITCHEN_PI_ZONE_ID, 'play');
  roonState.transport.control(KITCHEN_PI_ZONE_ID, 'play');
}

// ---------------------------------------------------------------------------
// Runtime enable/disable
// ---------------------------------------------------------------------------
function enable()  { enabled = true;  console.log('[watchdog] Enabled');  }
function disable() {
  enabled = false;
  if (pendingResumeTimeout) {
    clearTimeout(pendingResumeTimeout);
    pendingResumeTimeout = null;
  }
  console.log('[watchdog] Disabled');
}

module.exports = {
  notePresetPlay,
  onZoneTransition,
  getStatus,
  enable,
  disable,
  KITCHEN_PI_ZONE_ID,
  KITCHEN_PI_OUTPUT_ID
};
