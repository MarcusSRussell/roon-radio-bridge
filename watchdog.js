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
const config                = require('./config');

// ---------------------------------------------------------------------------
// Configuration (loaded from config.js / env vars)
// ---------------------------------------------------------------------------
const KITCHEN_PI_ZONE_ID   = config.KITCHEN_PI_ZONE_ID;
const KITCHEN_PI_OUTPUT_ID = config.KITCHEN_PI_OUTPUT_ID;
const DIRECT_CONTROL_IPS   = config.DIRECT_CONTROL_IPS;
const AUTO_RESUME_ENABLED  = config.AUTO_RESUME_ENABLED;
const COMMAND_LOOKBACK_MS  = config.COMMAND_LOOKBACK_MS;
const RESUME_DELAY_MS      = config.RESUME_DELAY_MS;
const REARM_WINDOW_MS      = config.REARM_WINDOW_MS;

console.log(`[watchdog] Config: AUTO_RESUME_ENABLED=${AUTO_RESUME_ENABLED}, RESUME_DELAY_MS=${RESUME_DELAY_MS}, REARM_WINDOW_MS=${REARM_WINDOW_MS}`);
console.log(`[watchdog] Direct Control IPs: ${DIRECT_CONTROL_IPS.join(', ')}`);

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

  // When the zone starts playing, check if a Direct Control surface
  // triggered it. This catches touchscreen play/playpause actions and
  // bridge-originated play commands, putting the watchdog into direct
  // mode so it will protect the stream if the bug fires later.
  if (newState === 'loading' && (prevState === 'stopped' || prevState === 'paused')) {
    handlePlayEvent();
  }

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

// Controls that indicate a play action (used by handlePlayEvent to
// detect Direct Control play commands).
const PLAY_CAUSING_CONTROLS = ['play', 'playpause'];

/**
 * Called when KitchenPi transitions from stopped/paused to loading.
 * Checks whether a Direct Control surface (touchscreen, Arduino via
 * bridge) triggered the play. If so, enters direct mode so the watchdog
 * will protect the stream.
 *
 * This handles the common scenario where someone presses play on the
 * touchscreen without having pressed a preset button first.
 */
function handlePlayEvent() {
  // Check bridge command tracker first (Arduino via bridge routes)
  if (bridgeCommands.isRecent(KITCHEN_PI_ZONE_ID,   COMMAND_LOOKBACK_MS, PLAY_CAUSING_CONTROLS) ||
      bridgeCommands.isRecent(KITCHEN_PI_OUTPUT_ID, COMMAND_LOOKBACK_MS, PLAY_CAUSING_CONTROLS)) {
    if (controlMode !== 'direct') {
      controlMode = 'direct';
      console.log('[watchdog] Direct control (bridge play command)');
    }
    return;
  }

  // Check log for play commands from Direct Control IPs
  const logByZone   = logTail.findRecentCommand(KITCHEN_PI_ZONE_ID,   COMMAND_LOOKBACK_MS, PLAY_CAUSING_CONTROLS);
  const logByOutput = logTail.findRecentCommand(KITCHEN_PI_OUTPUT_ID, COMMAND_LOOKBACK_MS, PLAY_CAUSING_CONTROLS);
  const logEntry    = logByZone || logByOutput;

  if (logEntry) {
    const sourceIp = logEntry.clientIp.split(':')[0];
    if (DIRECT_CONTROL_IPS.includes(sourceIp)) {
      if (controlMode !== 'direct') {
        controlMode = 'direct';
        console.log(`[watchdog] Direct control (play from ${sourceIp})`);
      }
    }
    // Play from an indirect IP — don't change mode
  }
  // No play command found in tracker or log — could be auto-radio,
  // Roon app, or similar. Don't change mode.
}

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
