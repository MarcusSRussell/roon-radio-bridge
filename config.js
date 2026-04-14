/*
 * ===========================================================================
 * File:        config.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        14 April 2026
 * Version:     1.4.0 (Layer 4)
 *
 * Description:
 *   Centralised configuration. All tunable values can be overridden via
 *   environment variables (set in docker-compose.yml and editable through
 *   the Portainer UI). When no env var is set, the baked-in default is
 *   used - these are the same values that worked during native testing.
 *
 *   This lets the same code run unchanged either natively (using defaults)
 *   or in a container (using env vars from the stack).
 * ===========================================================================
 */

function envBool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function envInt(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function envString(name, defaultValue) {
  return process.env[name] !== undefined ? process.env[name] : defaultValue;
}

function envList(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  // HTTP port the bridge listens on
  PORT: envInt('BRIDGE_PORT', 33262),

  // KitchenPi zone/output IDs
  KITCHEN_PI_ZONE_ID:   envString('KITCHEN_PI_ZONE_ID',   '16012544785f8b36a95b4cf93ed846179af7'),
  KITCHEN_PI_OUTPUT_ID: envString('KITCHEN_PI_OUTPUT_ID', '17012544785f8b36a95b4cf93ed846179af7'),

  // Direct Control IP whitelist - sources whose commands keep/put the
  // watchdog in direct mode. Comma-separated in env var form.
  DIRECT_CONTROL_IPS: envList('DIRECT_CONTROL_IPS', [
    '192.168.1.103',  // WWMS (bridge itself)
    '192.168.1.176'   // RoPieee touchscreen
  ]),

  // Watchdog behaviour
  AUTO_RESUME_ENABLED: envBool('AUTO_RESUME_ENABLED', false),
  RESUME_DELAY_MS:     envInt ('RESUME_DELAY_MS',     2500),
  COMMAND_LOOKBACK_MS: envInt ('COMMAND_LOOKBACK_MS', 3000),
  REARM_WINDOW_MS:     envInt ('REARM_WINDOW_MS',     30000),

  // Log tailer
  LOG_PATH:             envString('LOG_PATH', '/mnt/rock-logs/RoonServer/Logs/RoonServer_log.txt'),
  LOG_POLL_INTERVAL_MS: envInt('LOG_POLL_INTERVAL_MS', 100),
  LOG_BUFFER_WINDOW_MS: envInt('LOG_BUFFER_WINDOW_MS', 60000)
};
