/*
 * ===========================================================================
 * File:        roon.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.0.0
 *
 * Description:
 *   Roon API connection management. Handles core pairing, the transport
 *   zone subscription, and the settings service used to configure radio
 *   presets via the Roon UI.
 *
 *   Exposes a shared `state` object used by the HTTP route handlers under
 *   ./api/. State includes the paired core, the transport and browse
 *   services, the current preset configuration, the fetched station list,
 *   and a zoneStates Map that tracks the current state of every zone.
 *
 *   The zoneStates tracker is the foundation for the future watchdog
 *   module (Layer 3). It maintains per-zone state, previous state, and
 *   whether the zone is playing live radio, so the watchdog can later
 *   detect unexpected transitions from playing -> stopped.
 * ===========================================================================
 */

const RoonApi          = require('node-roon-api');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiBrowse    = require('node-roon-api-browse');
const RoonApiStatus    = require('node-roon-api-status');
const RoonApiSettings  = require('node-roon-api-settings');

const NO_PRESET_VALUE = 'None (disabled)';
const NUM_PRESETS     = 10;

// ---------------------------------------------------------------------------
// Shared state exposed to API route handlers
// ---------------------------------------------------------------------------
const state = {
  core:        null,
  browser:     null,
  transport:   null,
  presets:     null,
  stationList: [],
  // zone_id -> { state, prevState, isRadio, displayName, nowPlaying, lastChange }
  zoneStates:  new Map()
};

// Default preset configuration (empty slots — user configures via Roon UI)
const defaultPresets = {};
for (let i = 1; i <= NUM_PRESETS; i++) {
  defaultPresets[`preset_${i}`] = NO_PRESET_VALUE;
}

// ---------------------------------------------------------------------------
// Roon extension definition
// ---------------------------------------------------------------------------
const roon = new RoonApi({
  extension_id:    'marcus.roon-radio-bridge',
  display_name:    'Roon Radio Bridge',
  display_version: '1.0.0',
  publisher:       'Marcus Russell',
  email:           'marcus@glebelands.com',
  log_level:       'none',

  core_paired: (core) => {
    state.core      = core;
    state.transport = core.services.RoonApiTransport;
    state.browser   = core.services.RoonApiBrowse;

    console.log(`[roon] Paired with core: ${core.display_name} (${core.core_id})`);

    // Subscribe to zone updates. This populates the zone state tracker
    // and is the hook point for the future watchdog module.
    state.transport.subscribe_zones((cmd, data) => {
      handleZoneUpdate(cmd, data);
    });
  },

  core_unpaired: (core) => {
    console.log(`[roon] Unpaired from core: ${core.display_name}`);
    state.core      = null;
    state.transport = null;
    state.browser   = null;
    state.zoneStates.clear();
  }
});

// Load saved preset configuration from Roon's config store
state.presets = roon.load_config('settings') || defaultPresets;

// ---------------------------------------------------------------------------
// Status service (visible in Roon Settings > Extensions)
// ---------------------------------------------------------------------------
const svcStatus = new RoonApiStatus(roon);

// ---------------------------------------------------------------------------
// Settings service (preset configuration via Roon UI)
// ---------------------------------------------------------------------------
const svcSettings = new RoonApiSettings(roon, {
  get_settings: (cb) => {
    fetchStationList(() => {
      cb(makeLayout(state.presets));
    });
  },
  save_settings: (req, isdryrun, settings) => {
    const l = makeLayout(settings.values);
    req.send_complete(l.has_error ? 'NotValid' : 'Success', { settings: l });
    if (!isdryrun && !l.has_error) {
      state.presets = l.values;
      svcSettings.update_settings(l);
      roon.save_config('settings', state.presets);
      console.log('[roon] Preset configuration saved');
    }
  }
});

// Build the settings dialog layout shown in the Roon UI
function makeLayout(settings) {
  const l = {
    values:    settings,
    layout:    [],
    has_error: false
  };
  for (let i = 1; i <= NUM_PRESETS; i++) {
    l.layout.push({
      type:    'dropdown',
      title:   `Preset ${i}`,
      values:  state.stationList,
      setting: `preset_${i}`
    });
  }
  return l;
}

// Fetch the list of available internet radio stations from Roon,
// used to populate the dropdowns in the settings UI.
function fetchStationList(cb) {
  if (!state.browser) {
    state.stationList = [{ title: NO_PRESET_VALUE, value: NO_PRESET_VALUE }];
    cb && cb();
    return;
  }
  const opts = { hierarchy: 'internet_radio', pop_all: true };
  state.browser.browse(opts, (err) => {
    if (err) {
      console.log('[roon] station list browse error:', err);
      cb && cb();
      return;
    }
    state.browser.load(opts, (err, r) => {
      if (err) {
        console.log('[roon] station list load error:', err);
        cb && cb();
        return;
      }
      state.stationList = [{ title: NO_PRESET_VALUE, value: NO_PRESET_VALUE }]
        .concat(r.items.map(item => ({ title: item.title, value: item.title })));
      cb && cb();
    });
  });
}

// ---------------------------------------------------------------------------
// Zone state tracking
//
// Maintains a map of zone_id -> state info, updated on every Roon zone
// change notification. Logs state transitions to the console for
// diagnostics. In Layer 3 the watchdog module will consume transitions
// from this map to detect unexpected stops of live radio streams.
// ---------------------------------------------------------------------------
function handleZoneUpdate(cmd, data) {
  if (cmd === 'Subscribed') {
    for (const zone of data.zones) {
      updateZoneState(zone);
    }
  } else if (cmd === 'Changed') {
    if (data.zones_added) {
      for (const zone of data.zones_added) updateZoneState(zone);
    }
    if (data.zones_changed) {
      for (const zone of data.zones_changed) updateZoneState(zone);
    }
    if (data.zones_removed) {
      for (const zoneId of data.zones_removed) state.zoneStates.delete(zoneId);
    }
  }
}

function updateZoneState(zone) {
  const prev = state.zoneStates.get(zone.zone_id);
  const isRadio = zone.is_seek_allowed === false;
  const nowPlaying = zone.now_playing && zone.now_playing.one_line
                     ? zone.now_playing.one_line.line1
                     : null;

  const current = {
    state:       zone.state,
    prevState:   prev ? prev.state : null,
    isRadio:     isRadio,
    displayName: zone.display_name,
    nowPlaying:  nowPlaying,
    lastChange:  Date.now()
  };
  state.zoneStates.set(zone.zone_id, current);

  // Log state transitions for diagnostics
  if (prev && prev.state !== current.state) {
    const radioTag = isRadio ? ' (radio)' : '';
    console.log(`[zone] ${current.displayName}: ${prev.state} -> ${current.state}${radioTag}`);

    // Notify the watchdog (Layer 3). Lazy-require to avoid circular
    // dependency at module load time.
    try {
      const watchdog = require('./watchdog');
      watchdog.onZoneTransition(zone.zone_id, prev.state, current.state, zone);
    } catch (err) {
      // Watchdog module not available - no-op
    }
  }
}

// ---------------------------------------------------------------------------
// Initialise services and start discovery
// ---------------------------------------------------------------------------
roon.init_services({
  required_services: [ RoonApiTransport, RoonApiBrowse ],
  provided_services: [ svcStatus, svcSettings ]
});

svcStatus.set_status('Starting...', false);

function start() {
  roon.start_discovery();
  svcStatus.set_status('Extension running', false);
  console.log('[roon] Discovery started');
}

module.exports = {
  start,
  state,
  NO_PRESET_VALUE
};
