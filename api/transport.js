/*
 * ===========================================================================
 * File:        api/transport.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        17 April 2026
 * Version:     1.3.0 (Layer 3 v2)
 *
 * Description:
 *   HTTP route handlers for transport control. Every play/pause/stop/
 *   playpause is recorded in bridgeCommands so the watchdog knows
 *   instantly that the bridge caused a subsequent zone state change.
 *   Volume and mute are not tracked - they cannot produce a stop event.
 * ===========================================================================
 */

const { state }       = require('../roon');
const bridgeCommands  = require('../bridgeCommands');

function notPaired(res) {
  return res.status(503).send({ error: 'Not paired with Roon core' });
}

function play(req, res) {
  if (!state.transport) return notPaired(res);
  bridgeCommands.note(req.query.zoneId, 'play');
  state.transport.control(req.query.zoneId, 'play');
  res.send({ status: 'play success' });
}

function pause(req, res) {
  if (!state.transport) return notPaired(res);
  bridgeCommands.note(req.query.zoneId, 'pause');
  state.transport.control(req.query.zoneId, 'pause');
  res.send({ status: 'pause success' });
}

function stop(req, res) {
  if (!state.transport) return notPaired(res);
  bridgeCommands.note(req.query.zoneId, 'stop');
  state.transport.control(req.query.zoneId, 'stop');
  res.send({ status: 'stop success' });
}

function playPause(req, res) {
  if (!state.transport) return notPaired(res);
  bridgeCommands.note(req.query.zoneId, 'playpause');
  state.transport.control(req.query.zoneId, 'playpause');
  res.send({ status: 'playpause success' });
}

function changeVolume(req, res) {
  if (!state.transport) return notPaired(res);
  const volume = parseInt(req.query.volume, 10);
  state.transport.change_volume(req.query.outputId, 'absolute', volume);
  res.send({ status: 'change_volume success' });
}

function changeVolumeRelative(req, res) {
  if (!state.transport) return notPaired(res);
  const volume = parseInt(req.query.volume, 10);
  state.transport.change_volume(req.query.outputId, 'relative', volume);
  res.send({ status: 'change_volume_relative success' });
}

function muteOutput(req, res) {
  if (!state.transport) return notPaired(res);
  state.transport.mute(req.query.outputId, 'mute');
  res.send({ status: 'mute success' });
}

function unmuteOutput(req, res) {
  if (!state.transport) return notPaired(res);
  state.transport.mute(req.query.outputId, 'unmute');
  res.send({ status: 'unmute success' });
}

module.exports = {
  play,
  pause,
  stop,
  playPause,
  changeVolume,
  changeVolumeRelative,
  muteOutput,
  unmuteOutput
};
