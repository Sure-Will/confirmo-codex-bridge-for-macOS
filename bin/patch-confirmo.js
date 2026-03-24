#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, "..");
const BRIDGE_DIR = path.join(HOME, ".confirmo", "codex-bridge");
const BACKUP_DIR = path.join(BRIDGE_DIR, "backups");

const CONFIRMO_APP = "/Applications/Confirmo.app";
const RESOURCES_DIR = path.join(CONFIRMO_APP, "Contents", "Resources");
const APP_ASAR_PATH = path.join(RESOURCES_DIR, "app.asar");
const BUNDLED_HOOK_PATH = path.join(RESOURCES_DIR, "confirmo-codex-hook.js");
const USER_HOOK_PATH = path.join(HOME, ".confirmo", "hooks", "confirmo-codex-hook.js");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  ensureDir(BACKUP_DIR);
  const target = path.join(BACKUP_DIR, `${path.basename(filePath)}.${stamp()}.bak`);
  fs.copyFileSync(filePath, target);
  return target;
}

function writeFileAtomic(filePath, content, mode) {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, content, mode == null ? undefined : { mode });
  fs.renameSync(tempPath, filePath);
  if (mode != null) {
    fs.chmodSync(filePath, mode);
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function makeHookShim() {
  return [
    "#!/usr/bin/env node",
    "",
    `require(${JSON.stringify(path.join(REPO_ROOT, "bin", "codex-notify.js"))});`,
    "",
  ].join("\n");
}

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  return source.replace(search, replacement);
}

function replaceOptional(source, search, replacement) {
  if (!source.includes(search)) {
    return { next: source, changed: false };
  }

  return {
    next: source.replace(search, replacement),
    changed: true,
  };
}

function assertContainsAny(source, variants, label) {
  if (variants.some((variant) => source.includes(variant))) {
    return;
  }

  throw new Error(`Patch target not found: ${label}`);
}

function patchIndexJs(indexPath) {
  const source = fs.readFileSync(indexPath, "utf8");

  const handleHooksOld = [
    "  const handleHooksAgentEvent = (event) => {",
    '    if (event.type === "agent-idle" || event.type === "task-complete") {',
    "      hooksIdleAgents.set(event.agent, Date.now());",
    "    }",
    "    broadcastAgentEvent(event);",
    "  };",
  ].join("\n");

  const handleHooksNew = [
    "  const handleHooksAgentEvent = (event) => {",
    '    if (event.type === "agent-active" || event.type === "agent-start") {',
    "      hooksIdleAgents.delete(event.agent);",
    "    }",
    '    if (event.type === "agent-idle" || event.type === "task-complete") {',
    "      hooksIdleAgents.set(event.agent, Date.now());",
    "    }",
    "    broadcastAgentEvent(event);",
    "  };",
  ].join("\n");

  const codexMonitorOld = [
    "        if (!prev) {",
    "          console.log(",
    '            `[CodexStatusMonitor] New session: ${sessionId.slice(0, 8)}..., status: ${session.status}`',
    "          );",
    '          if (session.status === "completed") {',
    '            this.emitEvent(session, "task-complete");',
    '            this.emitEvent(session, "agent-idle");',
    "          }",
    "        } else if (prev.status !== session.status) {",
    '          console.log(`[CodexStatusMonitor] Status changed: ${prev.status} -> ${session.status}`);',
    '          if (session.status === "completed") {',
    '            this.emitEvent(session, "task-complete");',
    '            this.emitEvent(session, "agent-idle");',
    '          } else if (session.status === "error") {',
    '            this.emitEvent(session, "task-error");',
    '            this.emitEvent(session, "agent-idle");',
    "          }",
    '        } else if (prev.lastEvent?.timestamp !== session.lastEvent?.timestamp && session.status === "completed") {',
    '          console.log(`[CodexStatusMonitor] New completion: ${session.lastEvent?.details}`);',
    '          this.emitEvent(session, "task-complete");',
    '          this.emitEvent(session, "agent-idle");',
    "        }",
  ].join("\n");

  const codexMonitorNew = [
    "        if (!prev) {",
    "          console.log(",
    '            `[CodexStatusMonitor] New session: ${sessionId.slice(0, 8)}..., status: ${session.status}`',
    "          );",
    '          if (session.status === "working") {',
    '            this.emitEvent(session, "agent-active");',
    '          } else if (session.status === "completed") {',
    '            this.emitEvent(session, "task-complete");',
    '            this.emitEvent(session, "agent-idle");',
    '          } else if (session.status === "error") {',
    '            this.emitEvent(session, "task-error");',
    '            this.emitEvent(session, "agent-idle");',
    '          } else if (session.status === "idle") {',
    '            this.emitEvent(session, "agent-idle");',
    "          }",
    "        } else if (prev.status !== session.status) {",
    '          console.log(`[CodexStatusMonitor] Status changed: ${prev.status} -> ${session.status}`);',
    '          if (session.status === "working") {',
    '            this.emitEvent(session, "agent-active");',
    '          } else if (session.status === "completed") {',
    '            this.emitEvent(session, "task-complete");',
    '            this.emitEvent(session, "agent-idle");',
    '          } else if (session.status === "error") {',
    '            this.emitEvent(session, "task-error");',
    '            this.emitEvent(session, "agent-idle");',
    '          } else if (session.status === "idle") {',
    '            this.emitEvent(session, "agent-idle");',
    "          }",
    "        } else if (prev.lastEvent?.timestamp !== session.lastEvent?.timestamp) {",
    '          if (session.status === "working") {',
    '            console.log(`[CodexStatusMonitor] Working update: ${session.lastEvent?.details}`);',
    '            this.emitEvent(session, "agent-active");',
    '          } else if (session.status === "completed") {',
    '            console.log(`[CodexStatusMonitor] New completion: ${session.lastEvent?.details}`);',
    '            this.emitEvent(session, "task-complete");',
    '            this.emitEvent(session, "agent-idle");',
    "          }",
    "        }",
  ].join("\n");

  const codexMonitorCurrent = [
    "        } else if (prev.status !== session.status) {",
    '          console.log(`[CodexStatusMonitor] Status changed: ${prev.status} -> ${session.status}`);',
    "          this.handleStatusChange(prev, session);",
    '        } else if (prev.lastEvent?.timestamp !== session.lastEvent?.timestamp && session.status === \"working\") {',
    '          console.log(`[CodexStatusMonitor] Activity event: ${session.lastEvent?.details}`);',
    "          this.emitActivityEvent(session);",
  ].join("\n");

  let next = source;
  next = replaceOptional(next, handleHooksOld, handleHooksNew).next;
  assertContainsAny(next, [handleHooksNew], "handleHooksAgentEvent");

  next = replaceOptional(next, codexMonitorOld, codexMonitorNew).next;
  assertContainsAny(next, [codexMonitorNew, codexMonitorCurrent], "CodexStatusMonitor");

  if (next === source) {
    console.log("Confirmo main bundle already compatible; no JS patch changes required.");
  }

  fs.writeFileSync(indexPath, next);
}

function main() {
  if (!fs.existsSync(APP_ASAR_PATH)) {
    throw new Error(`Confirmo app.asar not found: ${APP_ASAR_PATH}`);
  }
  if (!fs.existsSync(BUNDLED_HOOK_PATH)) {
    throw new Error(`Bundled Confirmo hook not found: ${BUNDLED_HOOK_PATH}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "confirmo-asar-patch-"));
  const extractedDir = path.join(tempRoot, "app");
  const packedAsarPath = path.join(tempRoot, "app.patched.asar");
  const indexPath = path.join(extractedDir, "out", "main", "index.js");
  const shim = makeHookShim();

  ensureDir(BACKUP_DIR);
  const appAsarBackup = backupFile(APP_ASAR_PATH);
  const hookBackup = backupFile(BUNDLED_HOOK_PATH);

  run("asar", ["extract", APP_ASAR_PATH, extractedDir]);
  patchIndexJs(indexPath);
  run("asar", ["pack", extractedDir, packedAsarPath]);

  writeFileAtomic(BUNDLED_HOOK_PATH, shim, 0o755);
  writeFileAtomic(USER_HOOK_PATH, shim, 0o755);
  fs.copyFileSync(packedAsarPath, APP_ASAR_PATH);

  console.log("Patched Confirmo:");
  console.log(`- app.asar: ${APP_ASAR_PATH}`);
  console.log(`- bundled hook: ${BUNDLED_HOOK_PATH}`);
  console.log(`- user hook: ${USER_HOOK_PATH}`);
  if (appAsarBackup) {
    console.log(`- backup: ${appAsarBackup}`);
  }
  if (hookBackup) {
    console.log(`- hook backup: ${hookBackup}`);
  }
}

main();
