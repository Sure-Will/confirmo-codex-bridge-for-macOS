#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_BIN = process.execPath;
const BRIDGE_DIR = path.join(HOME, ".confirmo", "codex-bridge");
const BACKUP_DIR = path.join(BRIDGE_DIR, "backups");
const CONFIRMO_HOOKS_DIR = path.join(HOME, ".confirmo", "hooks");
const CONFIRMO_HOOK_PATH = path.join(CONFIRMO_HOOKS_DIR, "confirmo-codex-hook.js");
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
const LAUNCH_AGENT_PATH = path.join(LAUNCH_AGENTS_DIR, "com.sure.confirmo.codex-bridge.plist");
const CODEX_CONFIG_PATH = path.join(HOME, ".codex", "config.toml");
const NOTIFY_COMMAND = [
  NODE_BIN,
  CONFIRMO_HOOK_PATH,
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, target);
}

function renderNotifyBlock() {
  return [
    "notify = [",
    `  "${NOTIFY_COMMAND[0]}",`,
    `  "${NOTIFY_COMMAND[1]}"`,
    "]",
  ].join("\n");
}

function writeConfirmoHookShim() {
  ensureDir(CONFIRMO_HOOKS_DIR);
  backupFile(CONFIRMO_HOOK_PATH);

  const shim = [
    "#!/usr/bin/env node",
    "",
    `require(${JSON.stringify(path.join(REPO_ROOT, "bin", "codex-notify.js"))});`,
    "",
  ].join("\n");

  fs.writeFileSync(CONFIRMO_HOOK_PATH, shim);
}

function updateCodexConfig() {
  ensureDir(path.dirname(CODEX_CONFIG_PATH));

  const existing = fs.existsSync(CODEX_CONFIG_PATH)
    ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8")
    : "";

  backupFile(CODEX_CONFIG_PATH);

  const notifyBlock = renderNotifyBlock();
  const notifyRegex = /^notify\s*=\s*\[(?:[^\][]|\n)*?\]\n?/m;

  let next;
  if (notifyRegex.test(existing)) {
    next = existing.replace(notifyRegex, `${notifyBlock}\n`);
  } else if (existing.trim().length === 0) {
    next = `${notifyBlock}\n`;
  } else {
    next = `${notifyBlock}\n${existing}`;
  }

  fs.writeFileSync(CODEX_CONFIG_PATH, next);
}

function writeLaunchAgent() {
  ensureDir(LAUNCH_AGENTS_DIR);
  ensureDir(BRIDGE_DIR);

  const stdoutPath = path.join(BRIDGE_DIR, "launchd.stdout.log");
  const stderrPath = path.join(BRIDGE_DIR, "launchd.stderr.log");
  const bridgePath = path.join(REPO_ROOT, "bin", "codex-bridge.js");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sure.confirmo.codex-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${bridgePath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
</dict>
</plist>
`;

  backupFile(LAUNCH_AGENT_PATH);
  fs.writeFileSync(LAUNCH_AGENT_PATH, plist);
}

function main() {
  writeLaunchAgent();
  writeConfirmoHookShim();
  updateCodexConfig();

  console.log("Installed:");
  console.log(`- LaunchAgent: ${LAUNCH_AGENT_PATH}`);
  console.log(`- Confirmo hook shim: ${CONFIRMO_HOOK_PATH}`);
  console.log(`- Codex notify hook: ${CODEX_CONFIG_PATH}`);
  console.log("");
  console.log("Next:");
  console.log(`launchctl unload ${LAUNCH_AGENT_PATH} 2>/dev/null || true`);
  console.log(`launchctl load ${LAUNCH_AGENT_PATH}`);
}

main();
