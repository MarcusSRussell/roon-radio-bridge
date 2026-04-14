/*
 * ===========================================================================
 * File:        api/zones.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.0.0
 *
 * Description:
 *   HTTP route handlers for zone and output information queries. These
 *   routes read state from the Roon transport service. They are used by
 *   the Arduino to check playback state (play/pause/mute) before issuing
 *   follow-up commands.
 * ===========================================================================
 */

const { state } = require('../roon');

function notPaired(res) {
  return res.status(503).send({ error: 'Not paired with Roon core' });
}

function getCore(req, res) {
  if (!state.core) return notPaired(res);
  res.send({
    id:              state.core.core_id,
    display_name:    state.core.display_name,
    display_version: state.core.display_version
  });
}

function listZones(req, res) {
  if (!state.transport) return notPaired(res);
  state.transport.get_zones((isError, body) => {
    if (isError) return res.status(500).send({ error: 'Failed to get zones' });
    res.send({ zones: body.zones });
  });
}

function listOutputs(req, res) {
  if (!state.transport) return notPaired(res);
  state.transport.get_outputs((isError, body) => {
    if (isError) return res.status(500).send({ error: 'Failed to get outputs' });
    res.send({ outputs: body.outputs });
  });
}

function getZone(req, res) {
  if (!state.transport) return notPaired(res);
  res.send({ zone: state.transport.zone_by_zone_id(req.query.zoneId) });
}

function getZoneState(req, res) {
  if (!state.transport) return notPaired(res);
  const zone = state.transport.zone_by_zone_id(req.query.zoneId);
  const zoneState = zone ? zone.state : `Zone ID ${req.query.zoneId} Invalid`;
  res.send({ state: zoneState });
}

// Returns { "playerState": "playing" | "paused" | "stopped" | "loading" }
// matching the format the Arduino's httpGet() parser expects.
function getOutputState(req, res) {
  if (!state.transport) return notPaired(res);
  const zone = state.transport.zone_by_output_id(req.query.outputId);
  const playerState = zone ? zone.state : `Output ID ${req.query.outputId} Invalid`;
  res.send({ playerState });
}

// Returns { "is_muted": true | false } matching the Arduino's parser.
function getOutputMuted(req, res) {
  if (!state.transport) return notPaired(res);
  const zone = state.transport.zone_by_output_id(req.query.outputId);
  let isMuted;
  if (!zone) {
    isMuted = `Output ID ${req.query.outputId} Invalid`;
  } else {
    const output = zone.outputs[0];
    isMuted = output && output.volume ? output.volume.is_muted : false;
  }
  res.send({ is_muted: isMuted });
}

module.exports = {
  getCore,
  listZones,
  listOutputs,
  getZone,
  getZoneState,
  getOutputState,
  getOutputMuted
};
