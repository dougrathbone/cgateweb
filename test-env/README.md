# cgateweb Add-on Test Environment

Simulates the Home Assistant Supervisor environment locally using Docker Compose.
The HA base image (`ghcr.io/home-assistant/amd64-base:3.19`) ships with `bashio` and
`s6-overlay`, so all addon scripts run identically to a real HA installation.
The only thing mocked is `/data/options.json`.

## Prerequisites

- [Podman](https://podman.io/) + podman-compose (free, no Docker Desktop licence required)
- A C-Gate Linux zip (upload mode only, not needed for download mode)

### Install Podman (one-time)

```bash
brew install podman podman-compose
podman machine init
podman machine start
```

## Quick Start

### Managed mode - direct download (easiest)

Downloads C-Gate 3.3.2 automatically from Schneider Electric:

```bash
cp options-managed-download.json active-options.json
podman compose up --build
```

### Managed mode - zip upload

1. Obtain a C-Gate 3.x Linux zip from Schneider Electric and place it in:
   ```
   test-env/volumes/share/cgate/<filename>.zip
   ```

2. ```bash
   cp options-managed-upload.json active-options.json
   podman compose up --build
   ```

### Remote mode (cgateweb only, external C-Gate)

Edit `options-remote.json` to set `cgate_host` to your C-Gate server IP, then:
```bash
cp options-remote.json active-options.json
podman compose up --build
```

## Integration test

`integration-test.js` boots the full managed stack and asserts the bridge
reaches a working state. It includes a strict **issue #16 regression guard**:
it talks to C-Gate's command port inside the addon container and verifies the
project actually loaded (`project=HOME state=started`) and its real database
parsed (App 56 Lighting present). MQTT readiness alone never caught a
project-not-loaded failure.

```bash
cp options-managed-download.json active-options.json
node integration-test.js                 # build → assert → teardown
node integration-test.js --no-teardown   # leave the stack up afterwards
```

### Test project fixture

`volumes/share/cgate/tag/HOME.db` is a committed sample C-Gate project. On
startup the addon's `cgate-project-sync.sh` copies it to
`volumes/data/cgate/Projects/HOME/HOME.db` (C-Gate loads projects from
`Projects/<NAME>/`, **not** `tag/`), and `cgate-install.sh` sets
`project.start=HOME` so C-Gate auto-loads it.

The project's network is `type=serial` (COM1), so **without real C-Bus hardware
it never syncs** — `TREEXML` returns an empty tree and no entities are
discovered. Entity-discovery assertions therefore soft-pass by default. Set
`CGATEWEB_E2E_EXPECT_LIVE=1` to make them strict when running against a live
C-Bus. (Simulating a CNI so discovery runs end-to-end in CI is future work.)

## Watch logs

```bash
podman compose logs -f addon
```

## Resetting the install

C-Gate is installed into `volumes/data/cgate/`. To force a fresh install:
```bash
rm -rf volumes/data/cgate
podman compose restart addon
```

## Monitoring MQTT

Subscribe to all topics from your Mac:
```bash
mosquitto_sub -h localhost -p 1883 -t '#' -v
```

Or exec into the addon container:
```bash
podman compose exec addon sh
```

## What to look for in logs (managed mode)

Success path:
```
[INFO] C-Gate not found, installing from source: upload
[INFO] Found C-Gate installation in: /tmp/cgate-install.XXX/extract/...
[INFO] C-Gate installation complete
[INFO] Starting C-Gate server...
[INFO] C-Gate is ready
[INFO] Starting C-Gate Web Bridge application...
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `No .zip file found in /share/cgate` | Place C-Gate zip in `volumes/share/cgate/` |
| `cgate.jar not found in extracted archive` | Wrong zip, must be the C-Gate Linux package |
| C-Gate exits with code 1 in a loop | Check java version (`openjdk17-jre-headless` required) |
| cgateweb fails to connect to MQTT | Check `mqtt_host` in options, use `mqtt` (service name) |
