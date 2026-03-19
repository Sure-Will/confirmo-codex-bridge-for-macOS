#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_ASAR = "/Applications/Confirmo.app/Contents/Resources/app.asar";
const BACKUP_DIR = path.join(os.homedir(), ".confirmo", "codex-bridge", "backups");
const START_MARKER = "        if (!prev) {";
const END_MARKER = "    } catch (error2) {";
const CLASS_MARKER = "class CodexStatusMonitor {";

const REPLACEMENT = [
  "        if (!prev) {\n          if (session.status === \"working\") this.emitEvent(session, \"agent-active\");\n          else if (session.status === \"completed\") {\n            this.emitEvent(session, \"task-complete\");\n            this.emitEvent(session, \"agent-idle\");\n          }\n        } else if (prev.status !== session.status) {\n          if (session.status === \"working\") this.emitEvent(session, \"agent-active\");\n          else if (session.status === \"completed\") {\n            this.emitEvent(session, \"task-complete\");\n            this.emitEvent(session, \"agent-idle\");\n          } else if (session.status === \"error\") {\n            this.emitEvent(session, \"task-error\");\n            this.emitEvent(session, \"agent-idle\");\n          }\n        } else if (prev.lastEvent?.timestamp !== session.lastEvent?.timestamp) {\n          if (session.status === \"working\") this.emitEvent(session, \"agent-active\");\n          else if (session.status === \"completed\") {\n            this.emitEvent(session, \"task-complete\");\n            this.emitEvent(session, \"agent-idle\");\n          }\n        }\n        this.previousStatuses.set(sessionId, { ...session });\n      }\n      for (const [sessionId, prev] of this.previousStatuses) {\n        if (!status.sessions[sessionId]) {\n          this.previousStatuses.delete(sessionId);\n        }\n      }\n",
].join("");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function backupFile(filePath) {
  ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `app.asar.${stamp}.bak`);
  fs.copyFileSync(filePath, target);
  return target;
}

function main() {
  const originalBuffer = fs.readFileSync(APP_ASAR);
  const originalText = originalBuffer.toString("utf8");

  const classIndex = originalText.indexOf(CLASS_MARKER);
  if (classIndex === -1) {
    throw new Error("CodexStatusMonitor class not found");
  }

  const startIndex = originalText.indexOf(START_MARKER, classIndex);
  const endIndex = originalText.indexOf(END_MARKER, startIndex);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error("Could not locate patch window");
  }

  const originalRegion = originalText.slice(startIndex, endIndex);
  if (originalRegion.includes('agent-active')) {
    console.log("Confirmo Codex monitor already looks patched.");
    return;
  }

  const originalLength = Buffer.byteLength(originalRegion, "utf8");
  const replacementLength = Buffer.byteLength(REPLACEMENT, "utf8");
  if (replacementLength > originalLength) {
    throw new Error(`Replacement is too large (${replacementLength} > ${originalLength})`);
  }

  const padding = " ".repeat(originalLength - replacementLength);
  const patchedRegion = `${REPLACEMENT}${padding}`;
  const patchedText = `${originalText.slice(0, startIndex)}${patchedRegion}${originalText.slice(endIndex)}`;

  backupFile(APP_ASAR);

  const tempPath = `${APP_ASAR}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, Buffer.from(patchedText, "utf8"));
  fs.renameSync(tempPath, APP_ASAR);

  console.log("Patched Confirmo CodexStatusMonitor in place.");
}

main();
