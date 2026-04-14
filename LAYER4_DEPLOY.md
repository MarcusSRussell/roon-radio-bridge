# Layer 4 Deployment — Dockerised Bridge on WWMS

This replaces the `node index.js` process with a Docker container managed
via Portainer. Same code, same behaviour, but with auto-restart, easy
config changes through the Portainer UI, and no direct Node.js dependency
on the host.

## What's new in Layer 4

- **`config.js`** — centralised config that reads env vars with current
  hardcoded values as defaults. Same code runs unchanged natively or
  in a container.
- **`Dockerfile`** — Node 20 Alpine, copies source, runs the bridge.
- **`docker-compose.yml`** — the Portainer stack definition with all
  tunable values exposed as env vars.

## Tunable env vars (all editable in Portainer UI)

| Variable                 | Default                                      | Purpose                                                  |
|--------------------------|----------------------------------------------|----------------------------------------------------------|
| `AUTO_RESUME_ENABLED`    | `false`                                      | Flip to `true` after RoPieee investigation completes     |
| `RESUME_DELAY_MS`        | `2500`                                       | Delay before auto-resume — tune for shorter audible gap  |
| `REARM_WINDOW_MS`        | `30000`                                      | Two stops in this window = user intent, exit direct mode |
| `COMMAND_LOOKBACK_MS`    | `3000`                                       | How far back to check trackers when attributing a stop   |
| `DIRECT_CONTROL_IPS`     | `192.168.1.103,192.168.1.176`                | WWMS + RoPieee touchscreen                               |
| `KITCHEN_PI_ZONE_ID`     | `16012544785f8b36a95b4cf93ed846179af7`       | The KitchenPi zone in Roon                               |
| `KITCHEN_PI_OUTPUT_ID`   | `17012544785f8b36a95b4cf93ed846179af7`       | The KitchenPi output in Roon                             |
| `LOG_PATH`               | `/mnt/rock-logs/RoonServer/Logs/RoonServer_log.txt` | Roon log file path inside the container           |
| `LOG_POLL_INTERVAL_MS`   | `100`                                        | Log tailer poll interval                                 |
| `BRIDGE_PORT`            | `33262`                                      | HTTP port                                                |

## Prerequisites on WWMS

Already in place from previous layers — no changes needed:

1. SMB share `//rock.local/Data` mounted at `/mnt/rock-logs` (fstab entry)
2. Portainer running
3. Port 33262 available

## Deployment steps

### 1. Stop the native bridge

In the terminal where you're running `node index.js`, press Ctrl-C.

### 2. Copy the Layer 4 package to WWMS

```bash
# From your Mac
scp roon-radio-bridge-layer4.zip admin@wwms.local:/tmp/
```

### 3. Extract on WWMS

```bash
ssh wwmsadmin@wwms.local
cd /opt/roon-radio-bridge
unzip -o /tmp/roon-radio-bridge-layer4.zip
# Move files up if they landed in a subfolder
# (same as previous deployments)

# Create the Roon config directory that will persist the pairing token
mkdir -p roon-config

# If you had a native Roon pairing, copy its state file across so you
# don't have to re-enable the extension in Roon:
if [ -f config/roon-state.json ]; then
  cp config/roon-state.json roon-config/
fi
```

### 4. Create the Portainer stack

In Portainer:

1. **Stacks → Add stack**
2. Name: `roon-radio-bridge`
3. Build method: **Repository** or **Upload** — easiest is:
   - Select **Web editor**
   - Paste the contents of `docker-compose.yml`
   - Modify the `build: .` line to `build: /opt/roon-radio-bridge` so it
     finds the Dockerfile and source on the host
4. Review env vars in the **Environment variables** section — they
   match the defaults from `docker-compose.yml` but you can override
   any here through the UI
5. **Deploy the stack**

Alternatively, from SSH on WWMS:

```bash
cd /opt/roon-radio-bridge
docker compose up -d --build
```

Portainer will discover the stack automatically.

### 5. Verify

```bash
docker logs -f roon-radio-bridge
```

You should see the same startup output as native:

```
[bridge] Roon Radio Bridge v1.0.0 listening on port 33262
[watchdog] Config: AUTO_RESUME_ENABLED=false, RESUME_DELAY_MS=2500, ...
[watchdog] Direct Control IPs: 192.168.1.103, 192.168.1.176
[logTail] Starting tailer on /mnt/rock-logs/RoonServer/Logs/RoonServer_log.txt
[roon] Discovery started
[roon] Paired with core: RoonAlwaysOn
```

Test a route: `curl http://wwms.local:33262/roonAPI/listZones` — should
return the zone list as before.

### 6. Flipping AUTO_RESUME_ENABLED later

In Portainer:

1. **Stacks → roon-radio-bridge → Editor**
2. Change `AUTO_RESUME_ENABLED: "false"` to `"true"`
3. **Update the stack** — the container restarts with the new value

No code changes or rebuilds required.

## What doesn't change

- The Arduino still points at `wwms.local:33262` — container uses
  `network_mode: host` so the address is unchanged
- Roon extension ID stays `marcus.roon-radio-bridge` so pairing persists
- All bridge HTTP routes work identically
- The watchdog logic is exactly what you tested natively — only its
  config source has changed
