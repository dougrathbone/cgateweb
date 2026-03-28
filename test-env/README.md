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
