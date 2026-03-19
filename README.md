# confirmo-codex-bridge

Local bridge that derives live Codex CLI status for Confirmo without waiting for
official Codex lifecycle hooks to ship.

## What It Does

- Watches local Codex state in `~/.codex/state_5.sqlite`
- Reads rollout JSONL events from `~/.codex/sessions/...`
- Derives `working`, `completed`, and `idle` session states
- Writes Confirmo-compatible status files to `~/.confirmo/codex-status/`
- Installs a tiny notify hook so Codex no longer fights with Confirmo's stock
  `confirmo-codex-hook.js`

## Repo Layout

- `bin/codex-bridge.js`: long-running sidecar monitor
- `bin/codex-notify.js`: lightweight notify hook owned by this repo
- `bin/install.js`: installs the LaunchAgent and rewrites `~/.codex/config.toml`
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

To test one cycle without launchd:

```bash
node bin/codex-bridge.js --once --verbose
```

## Optional Confirmo Patch

To let Confirmo treat Codex `working` sessions like `agent-active`, run:

```bash
node bin/patch-confirmo.js
```

This script:

- creates a backup of `app.asar`
- patches the `CodexStatusMonitor` logic in place
- keeps the archive byte length unchanged

Because Confirmo updates can overwrite the patch, keeping this repo around makes
re-applying the bridge straightforward after every update.
