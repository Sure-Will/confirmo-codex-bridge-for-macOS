#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const BRIDGE_DIR = path.join(os.homedir(), ".confirmo", "codex-bridge");
const NOTIFY_FILE = path.join(BRIDGE_DIR, "notify-cache.json");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function main() {
  const jsonArg = process.argv[2];
  if (!jsonArg) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(jsonArg);
  } catch (_) {
    process.exit(0);
  }

  const threadId = payload["thread-id"];
  if (!threadId) {
    process.exit(0);
  }

  ensureDir(BRIDGE_DIR);

  const cache = readJson(NOTIFY_FILE, { version: 1, sessions: {} });
  cache.version = 1;
  cache.sessions = cache.sessions || {};

  cache.sessions[threadId] = {
    type: payload.type || "",
    threadId,
    turnId: payload["turn-id"] || null,
    cwd: payload.cwd || "",
    lastAssistantMessage: payload["last-assistant-message"] || "",
    lastUpdated: Date.now(),
  };

  writeJsonAtomic(NOTIFY_FILE, cache);
}

main();
