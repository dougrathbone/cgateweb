# Home Assistant Addon Distribution

This document explains the automated distribution system for the cgateweb Home Assistant addon.

## Overview

The cgateweb project uses a dual-repository approach:

1. **Main Repository** (`dougrathbone/cgateweb`): All development, source code, tests, and documentation
2. **Distribution Repository** (`dougrathbone/cgateweb-homeassistant`): Home Assistant addon files only, auto-generated

## Distribution Repository Structure

Home Assistant requires addons to be in a subfolder with `repository.yaml` at the root:

```
cgateweb-homeassistant/
  repository.yaml            # HA addon repo metadata
  README.md                  # Points users to main repo
  cgateweb/                  # Addon subfolder
    config.yaml              # Addon configuration schema
    Dockerfile               # Container build
    build.yaml               # Architecture base images
    run.sh                   # Entrypoint script
    DOCS.md                  # User documentation
    CHANGELOG.md             # Version history
    README.md                # Addon readme
    icon.png                 # 128x128 addon icon
    logo.png                 # 250x100 addon logo
    translations/en.yaml     # Config option descriptions
    rootfs/                  # s6-overlay service definitions
    src/                     # Application source code
    index.js                 # Application entry point
    package.json             # Node.js dependencies
    package-lock.json        # Locked dependencies
```

## Workflow

### Triggering a Release

1. Tag a version in the main repository:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. GitHub Actions automatically:
   - Runs the full test suite
   - Builds the distribution package
   - Pushes to the distribution repository
   - Creates a GitHub release

### Manual Trigger

```
Repository -> Actions -> Build and Deploy Home Assistant Addon -> Run workflow
```

## Setup Requirements

### Main Repository

- Workflow file: `.github/workflows/hacs-distribution.yml`
- Secret: `HACS_DEPLOY_TOKEN` (Personal Access Token with `repo` scope)

### Distribution Repository

- Repository: `dougrathbone/cgateweb-homeassistant`
- Can start empty -- the workflow populates it

## For Users

1. Add `https://github.com/dougrathbone/cgateweb-homeassistant` as a custom repository in Home Assistant
2. Install the "C-Gate Web Bridge" addon
3. All issues and contributions go to the main repository
