/*
 * ===========================================================================
 * File:        routes.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.0.0
 *
 * Description:
 *   Maps HTTP URL paths to their handler functions. Route paths are kept
 *   identical to the original st0g1e bridge so the KitchenPi Arduino
 *   controller works without code changes (only the HOST_NAME needs
 *   updating to point at wwms.local).
 *
 *   Only the routes actually used by the Arduino are included here. The
 *   original bridge exposed additional routes for browse navigation,
 *   timers, and image serving which are not needed by this project.
 * ===========================================================================
 */

const transport = require('./api/transport');
const zones     = require('./api/zones');
const radio     = require('./api/radio');
const logTail   = require('./logTail');
const watchdog  = require('./watchdog');

module.exports = function(app) {

  // --- Diagnostic (Layer 2): view current log tail buffer ---
  app.get('/roonAPI/logTail/recent', (req, res) => {
    res.send(logTail.getBufferSnapshot());
  });

  // --- Diagnostic (Layer 3): watchdog status ---
  app.get('/roonAPI/watchdog/status',  (req, res) => res.send(watchdog.getStatus()));
  app.get('/roonAPI/watchdog/enable',  (req, res) => { watchdog.enable();  res.send(watchdog.getStatus()); });
  app.get('/roonAPI/watchdog/disable', (req, res) => { watchdog.disable(); res.send(watchdog.getStatus()); });

  // --- Zone and output information ---
  app.get('/roonAPI/getCore',        zones.getCore);
  app.get('/roonAPI/listZones',      zones.listZones);
  app.get('/roonAPI/listOutputs',    zones.listOutputs);
  app.get('/roonAPI/getZone',        zones.getZone);
  app.get('/roonAPI/getZoneState',   zones.getZoneState);
  app.get('/roonAPI/getOutputState', zones.getOutputState);
  app.get('/roonAPI/getOutputMuted', zones.getOutputMuted);

  // --- Transport control ---
  app.get('/roonAPI/play',                   transport.play);
  app.get('/roonAPI/pause',                  transport.pause);
  app.get('/roonAPI/stop',                   transport.stop);
  app.get('/roonAPI/play_pause',             transport.playPause);
  app.get('/roonAPI/change_volume',          transport.changeVolume);
  app.get('/roonAPI/change_volume_relative', transport.changeVolumeRelative);
  app.get('/roonAPI/mute_output',            transport.muteOutput);
  app.get('/roonAPI/unmute_output',          transport.unmuteOutput);

  // --- Internet radio preset selection ---
  app.get('/roonAPI/getInternetRadios', radio.getInternetRadios);
};
