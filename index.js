/*
 * ===========================================================================
 * File:        index.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.1.0
 *
 * Description:
 *   Entry point for the Roon Radio Bridge. Starts the Express HTTP server
 *   and initialises the Roon API connection. This bridge is a cleaned-up
 *   replacement for the original st0g1e Node.js Roon HTTP API, purpose-
 *   built to serve the KitchenPi Arduino controller.
 *
 *   Layer 1 (this version): drop-in replacement
 *   Layer 2 (planned):      Roon log-tailing module
 *   Layer 3 (planned):      live radio stream watchdog
 *
 *   v1.1.0: Added roonStats - pushes Roon Core health stats to Home
 *   Assistant. Started alongside logTail since it depends on logTail
 *   feeding it parsed lines; no-ops if SECRET_HA_TOKEN isn't configured.
 * ===========================================================================
 */

const express        = require('express');
const roon           = require('./roon');
const registerRoutes = require('./routes');
const logTail        = require('./logTail');
const roonStats      = require('./roonStats');
const config         = require('./config');

const PORT = config.PORT;

// Enable/disable log tailing (Layer 2). Set to false to run without it
// (e.g. if the SMB mount is unavailable during testing).
const ENABLE_LOG_TAIL = true;

const app = express();

// CORS headers (kept for parity with the original bridge)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Register all HTTP routes under /roonAPI/*
registerRoutes(app);

// Kick off Roon discovery and pairing
roon.start();

// Start log tailer (Layer 2), and the HA stats reporter that piggybacks
// on its tailed stream (no-op if SECRET_HA_TOKEN isn't configured)
if (ENABLE_LOG_TAIL) {
  logTail.start();
  roonStats.start();
}

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bridge] Roon Radio Bridge v1.0.0 listening on port ${PORT}`);
  console.log(`[bridge] Routes available at http://wwms.local:${PORT}/roonAPI/...`);
});
