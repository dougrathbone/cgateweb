# HACS Distribution Setup

This document explains the automated HACS distribution system for the cgateweb Home Assistant addon.

## Overview

The cgateweb project uses a dual-repository approach for HACS distribution:

1. **Main Repository** (`dougrathbone/cgateweb`): Contains all development, source code, and documentation
2. **HACS Distribution Repository** (`dougrathbone/cgateweb-hacs`): Contains only the Home Assistant addon files for HACS installation

## Architecture

```
Main Repo (dougrathbone/cgateweb)
├── Development happens here
├── All issues and PRs
├── Source code in src/
├── Tests in tests/
├── Documentation in docs/
└── Addon files in homeassistant-addon/

GitHub Actions Workflow
├── Triggers on version tags (v1.0.0, v1.2.3, etc.)
├── Runs tests
├── Builds distribution package
└── Deploys to HACS repo

HACS Repo (dougrathbone/cgateweb-hacs)  
├── Contains only addon files
├── Automatically updated by workflow
├── Users install from here via HACS
└── Redirects contributors back to main repo
```

## Workflow Process

### Triggering a Release

1. **Create and push a version tag** in the main repository:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **GitHub Actions automatically**:
   - Runs the full test suite
   - Builds the distribution package
   - Updates the HACS repository
   - Creates a GitHub release

### What Gets Distributed

The workflow copies to the HACS repository:

**Included Files:**
- `homeassistant-addon/` → Root directory (config.yaml, Dockerfile, run.sh, etc.)
- `src/` → Source code directory
- `package.json` and `package-lock.json` → For dependencies
- Auto-generated `README.md` → Points back to main repo
- Auto-generated `CONTRIBUTING.md` → Redirects to main repo
- `LICENSE.txt` → License file

**Excluded Files:**
- Tests (`tests/` directory)
- Development configs (`.github/`, `eslint.config.js`)
- Documentation (`docs/` directory)
- Development files (`AGENT.md`, `CLAUDE.md`)

## Repository Setup Requirements

### Main Repository Setup

1. **GitHub Actions Workflow**: The `hacs-distribution.yml` workflow file in `.github/workflows/`

2. **Repository Secret**: `HACS_DEPLOY_TOKEN`
   - Personal Access Token with repo permissions
   - Must have access to push to the HACS distribution repository

### HACS Distribution Repository Setup

1. **Repository**: `dougrathbone/cgateweb-hacs` (or your preferred name)
2. **Branch**: `main` (default branch)
3. **Access**: GitHub Actions from main repo needs push access
4. **Initial Setup**: Can be empty - workflow will populate it

## User Experience

### For HACS Users

1. Add `https://github.com/dougrathbone/cgateweb-hacs` as custom repository
2. Install addon through HACS interface
3. Clean, focused installation without development files

### For Contributors/Issues

The HACS repository prominently redirects users to the main repository:
- Clear README explaining this is distribution-only
- CONTRIBUTING.md redirecting to main repo
- All development happens in main repo

## Maintenance

### Regular Updates

- Tag new versions in main repo → Automatic distribution
- No manual maintenance required for HACS repo

### Emergency Updates

Manual trigger available via GitHub Actions:
```
Repository → Actions → Build and Deploy HACS Distribution → Run workflow
```

### Monitoring

Check the Actions tab in the main repository for:
- Build status
- Deployment success/failure
- Test results before distribution

## Security Considerations

1. **Token Security**: `HACS_DEPLOY_TOKEN` should be repo-scoped only
2. **Automated Only**: HACS repo should only be updated by automation
3. **Test Gate**: Distribution only happens after tests pass
4. **Source Tracking**: Each release includes source commit reference

## Benefits

1. **Clean Distribution**: HACS users get only necessary files
2. **Centralized Development**: All development in one repository
3. **Automated**: No manual release process
4. **User-Friendly**: Clear paths for both users and contributors
5. **Maintainable**: Single source of truth for code

## Troubleshooting

### Distribution Fails

1. Check GitHub Actions logs in main repository
2. Verify `HACS_DEPLOY_TOKEN` permissions
3. Ensure HACS repository exists and is accessible

### HACS Installation Issues

1. Direct users to main repository issues
2. HACS-specific problems should reference both repos
3. Configuration issues likely belong in main repo

### Version Mismatches

- HACS repo version should match main repo tags
- Check GitHub Actions completed successfully
- Verify `config.yaml` version was updated correctly
