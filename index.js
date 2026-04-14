/*
 * ===========================================================================
 * File:        index.js
 * Application: Roon Radio Bridge
 * Author:      Marcus Russell
 * Date:        10 April 2026
 * Version:     1.0.0
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
 * ===========================================================================
 */

const express        = require('express');
const roon           = require('./roon');
const registerRoutes = require('./routes');
const logTail        = require('./logTail');

const PORT = 33262;

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

// Start log tailer (Layer 2)
if (ENABLE_LOG_TAIL) {
  logTail.start();
}

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bridge] Roon Radio Bridge v1.0.0 listening on port ${PORT}`);
  console.log(`[bridge] Routes available at http://wwms.local:${PORT}/roonAPI/...`);
});
