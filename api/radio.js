/*
 * ===========================================================================
 * File:        api/radio.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.0.0
 *
 * Description:
 *   HTTP route handler for internet radio preset selection.
 *
 *   Two modes are supported, matching the original bridge behaviour:
 *
 *     1. By preset number:
 *          /roonAPI/getInternetRadios?preset=N&outputId=...
 *        Plays the station currently configured as preset N in the
 *        extension settings (Roon Settings > Extensions > Roon Radio
 *        Bridge).
 *
 *     2. By search string:
 *          /roonAPI/getInternetRadios?toSearch=NAME&outputId=...
 *        Plays the station whose title matches NAME exactly.
 *
 *   The playback is triggered by browsing the internet radio hierarchy,
 *   matching the station title, then browsing into the matched item with
 *   the target output ID attached — Roon interprets this as a play
 *   request on that zone.
 * ===========================================================================
 */

const { state, NO_PRESET_VALUE } = require('../roon');
const watchdog                   = require('../watchdog');
const bridgeCommands             = require('../bridgeCommands');

function getInternetRadios(req, res) {
  if (!state.transport || !state.browser) {
    return res.status(503).send({ error: 'Not paired with Roon core' });
  }

  const outputId      = req.query.outputId;
  const presetNumber  = req.query.preset;
  const searchInput   = req.query.toSearch;

  const zone = state.transport.zone_by_output_id(outputId);
  if (!zone) {
    return res.send({ list: `Output ID ${outputId} Invalid` });
  }

  // Determine which station title to look for
  let targetStation;
  if (presetNumber !== undefined && presetNumber !== '') {
    const presetKey = `preset_${presetNumber}`;
    targetStation = state.presets[presetKey];
    if (!targetStation || targetStation === NO_PRESET_VALUE) {
      console.log(`[radio] preset ${presetNumber} is not set`);
      return res.send({ list: `Preset ${presetNumber} is not set` });
    }
  } else if (searchInput) {
    targetStation = searchInput;
  } else {
    return res.status(400).send({ error: 'Must provide preset or toSearch parameter' });
  }

  // Browse the internet radio hierarchy to get the station list
  const browseOpts = { hierarchy: 'internet_radio', pop_all: true };
  state.browser.browse(browseOpts, (err) => {
    if (err) {
      console.log('[radio] browse error:', err);
      return res.status(500).send({ error: 'Browse failed' });
    }
    state.browser.load({ hierarchy: 'internet_radio' }, (err, r) => {
      if (err) {
        console.log('[radio] load error:', err);
        return res.status(500).send({ error: 'Load failed' });
      }

      // Find the matching station by title
      const match = r.items.find(item => item.title === targetStation);
      if (!match) {
        console.log(`[radio] station not found: "${targetStation}"`);
        return res.send({ list: `Station not found: ${targetStation}` });
      }

      console.log(`[radio] playing "${targetStation}" on ${zone.display_name}`);

      // Drill into the matched station with the target output ID to
      // trigger playback on that zone.
      const playOpts = {
        hierarchy:         'internet_radio',
        item_key:          match.item_key,
        zone_or_output_id: outputId
      };
      state.browser.browse(playOpts, (err) => {
        if (err) {
          console.log('[radio] play-browse error:', err);
          return res.status(500).send({ error: 'Play failed' });
        }
        // Preset-initiated play: put the watchdog into direct control mode.
        // Only triggered when called with ?preset=N (not ?toSearch=), since
        // only preset selection represents a deliberate handover to the
        // Direct Control hardware surface.
        if (presetNumber !== undefined && presetNumber !== '') {
          // Note this as a bridge command against both zone and output
          // IDs so any subsequent state transitions are correctly
          // attributed to the bridge.
          bridgeCommands.note(outputId, 'play');
          watchdog.notePresetPlay(presetNumber, targetStation);
        }
        res.send({ list: [match] });
      });
    });
  });
}

module.exports = {
  getInternetRadios
};
