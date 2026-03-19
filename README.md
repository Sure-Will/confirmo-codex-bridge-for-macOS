# confirmo-codex-bridge

Local bridge that derives live Codex CLI status for Confirmo without waiting for
official Codex lifecycle hooks to ship.

## What It Does

- Watches local Codex state in `~/.codex/state_5.sqlite`
- Reads rollout JSONL events from `~/.codex/sessions/...`
- Derives `working`, `completed`, and `idle` session states
- Writes Confirmo-compatible status files to `~/.confirmo/codex-status/`
- Installs a tiny shim at `~/.confirmo/hooks/confirmo-codex-hook.js` so Codex
  forwards completions into this repo instead of fighting Confirmo's stock hook

## Repo Layout

- `bin/codex-bridge.js`: long-running sidecar monitor
- `bin/codex-notify.js`: lightweight notify hook owned by this repo
- `bin/install.js`: installs the LaunchAgent, rewrites `~/.codex/config.toml`,
  and writes the Confirmo hook shim
- `bin/patch-confirmo.js`: optional in-place patch for Confirmo's Codex monitor

## Why A Bridge Is Needed

Current Codex CLI public config exposes `notify`, but that only fires when a turn
completes. Codex itself writes richer local state, including `task_started`,
`function_call`, `reasoning`, and `task_complete` events. This bridge uses that
local state directly.

Confirmo 1.0.88 also under-handles Codex `working` states in its bundled
`CodexStatusMonitor`, so a local Confirmo patch is still recommended if you want
the pet to visibly enter the "working" state for Codex instead of only reacting
to completions.

## Install

From this repo:

```bash
node bin/install.js
launchctl unload ~/Library/LaunchAgents/com.sure.confirmo.codex-bridge.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.sure.confirmo.codex-bridge.plist
```

What `install.js` changes:

- writes `~/.confirmo/hooks/confirmo-codex-hook.js` as a repo-owned shim
- points Codex `notify` at that shim in `~/.codex/config.toml`
- installs `~/Library/LaunchAgents/com.sure.confirmo.codex-bridge.plist`

To test one cycle without launchd:

```bash
node bin/codex-bridge.js --once --verbose
```

## Confirmo Patch Status

`bin/patch-confirmo.js` is currently disabled on purpose.

A previous raw `app.asar` patch attempt caused Confirmo to crash on launch, so
the safe state right now is:

- keep the sidecar bridge
- keep the hook shim
- do not patch the Electron archive until there is a proper asar-aware workflow

Backups created during local experiments are stored under:

- `~/.confirmo/codex-bridge/backups`
