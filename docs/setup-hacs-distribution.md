# HACS Distribution Setup Guide

This guide explains how to set up the HACS distribution repository and GitHub Actions workflow.

## Prerequisites

Before running the automated distribution workflow, you need to:

### 1. Create the Distribution Repository

1. Go to GitHub and create a new **public** repository:
   - Repository name: `cgateweb-hacs`
   - Description: "C-Gate Web Bridge - Home Assistant Addon (HACS Distribution)"
   - Make it **public** (required for HACS)
   - **Do not** initialize with README, .gitignore, or license (the workflow will populate it)

### 2. Create a Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate a new token with these permissions:
   - `repo` (Full control of private repositories)
   - `workflow` (Update GitHub Action workflows)
3. Copy the token (you won't see it again!)

### 3. Add GitHub Secrets

In the main repository (`dougrathbone/cgateweb`):

1. Go to Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add the secret:
   - Name: `HACS_DEPLOY_TOKEN`
   - Value: The personal access token from step 2

## How the Workflow Works

The GitHub Actions workflow (`.github/workflows/hacs-distribution.yml`) is triggered when:

- A version tag is pushed (e.g., `v1.0.0`)
- Manually triggered via GitHub Actions UI

### Workflow Steps:

1. **Checkout & Test**: Gets the source code and runs tests
2. **Build Distribution**: Creates the addon structure in `distribution/`
3. **Initialize Repository**: Clones or initializes the HACS distribution repo
4. **Deploy Content**: Copies distribution files to the HACS repo
5. **Create Release**: Creates a GitHub release in the distribution repo

## First Run

When you run the workflow for the first time:

1. **Create the distribution repository** on GitHub (step 1 above)
2. **Add the deploy token** as a secret (steps 2-3 above)
3. **Tag a version** in the main repo:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. **Monitor the workflow** in the Actions tab

The workflow will automatically:
- Initialize the distribution repository
- Set up the main branch
- Populate it with the addon files
- Create the first release

## Troubleshooting

### "Repository not found" error
- Ensure the distribution repository exists and is public
- Verify the `HACS_DEPLOY_TOKEN` has the correct permissions

### "Branch main doesn't exist" error
- The workflow now handles this automatically
- It will create the main branch if it doesn't exist

### Permission denied
- Check that the personal access token has `repo` and `workflow` permissions
- Ensure the token is added as `HACS_DEPLOY_TOKEN` in repository secrets

## Manual Testing

To test the workflow without creating a tag:

1. Go to Actions → "Build and Deploy HACS Distribution"
2. Click "Run workflow"
3. Select the branch and click "Run workflow"

This will create a development build with a timestamp-based version.
