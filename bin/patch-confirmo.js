#!/usr/bin/env node

console.error(
  [
    "patch-confirmo.js is intentionally disabled.",
    "The previous raw app.asar patch approach corrupted Confirmo and caused launch crashes.",
    "Use the bridge sidecar and hook shim only until a proper asar-aware patch workflow is built.",
  ].join("\n")
);

process.exit(1);
