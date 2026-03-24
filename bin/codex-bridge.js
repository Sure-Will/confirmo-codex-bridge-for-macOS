#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const CODEX_STATE_DB = path.join(HOME, ".codex", "state_5.sqlite");
const CODEX_SESSIONS_DIR = path.join(HOME, ".codex", "sessions");
const BRIDGE_DIR = path.join(HOME, ".confirmo", "codex-bridge");
const BRIDGE_STATE_FILE = path.join(BRIDGE_DIR, "bridge-state.json");
const BRIDGE_NOTIFY_FILE = path.join(BRIDGE_DIR, "notify-cache.json");
const OUTPUT_DIR = path.join(HOME, ".confirmo", "codex-status");
const OUTPUT_STATUS_FILE = path.join(OUTPUT_DIR, "status.json");
const OUTPUT_SESSIONS_DIR = path.join(OUTPUT_DIR, "sessions");
const SQLITE_TEMP_PREFIX = path.join(os.tmpdir(), "confirmo-codex-state");
const ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i;

const POLL_MS = Number(process.env.CONFIRMO_CODEX_BRIDGE_POLL_MS || 1000);
const ACTIVE_WINDOW_MS = Number(process.env.CONFIRMO_CODEX_ACTIVE_WINDOW_MS || 90000);
const COMPLETE_TO_IDLE_MS = Number(process.env.CONFIRMO_CODEX_COMPLETE_TO_IDLE_MS || 30000);
const STALE_IDLE_MS = Number(process.env.CONFIRMO_CODEX_STALE_IDLE_MS || 120000);
const IN_PROGRESS_IDLE_MS = Number(process.env.CONFIRMO_CODEX_IN_PROGRESS_IDLE_MS || 15 * 60 * 1000);
const PRUNE_AFTER_MS = Number(process.env.CONFIRMO_CODEX_PRUNE_AFTER_MS || 24 * 60 * 60 * 1000);
const STATE_DB_RETRY_MS = Number(process.env.CONFIRMO_CODEX_STATE_DB_RETRY_MS || 5 * 60 * 1000);

const args = new Set(process.argv.slice(2));
const ONCE = args.has("--once");
const VERBOSE = args.has("--verbose");

let running = false;
let stateDbRetryAfter = 0;

function log(...parts) {
  if (VERBOSE) {
    console.log("[codex-bridge]", ...parts);
  }
}

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

function parseTimestamp(value) {
  if (typeof value === "number") {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function truncateText(value, maxLength = 200) {
  if (!value) {
    return "";
  }
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {}
}

function copyFileIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function withTempStateDb(callback) {
  const tempBase = `${SQLITE_TEMP_PREFIX}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempDbPath = `${tempBase}.sqlite`;
  const tempWalPath = `${tempDbPath}-wal`;
  const tempShmPath = `${tempDbPath}-shm`;

  fs.copyFileSync(CODEX_STATE_DB, tempDbPath);
  copyFileIfExists(`${CODEX_STATE_DB}-wal`, tempWalPath);
  copyFileIfExists(`${CODEX_STATE_DB}-shm`, tempShmPath);

  try {
    return callback(tempDbPath);
  } finally {
    safeUnlink(tempDbPath);
    safeUnlink(tempWalPath);
    safeUnlink(tempShmPath);
  }
}

function runSqlJson(sql) {
  if (!fs.existsSync(CODEX_STATE_DB)) {
    return [];
  }

  const output = withTempStateDb((dbPath) => execFileSync(
    "sqlite3",
    ["-readonly", "-json", dbPath, sql],
    { encoding: "utf8" }
  )).trim();

  if (!output) {
    return [];
  }

  return JSON.parse(output);
}

function loadBridgeState() {
  return readJson(BRIDGE_STATE_FILE, { version: 1, sessions: {} });
}

function loadNotifyCache() {
  return readJson(BRIDGE_NOTIFY_FILE, { version: 1, sessions: {} });
}

function saveBridgeState(state) {
  writeJsonAtomic(BRIDGE_STATE_FILE, state);
}

function listRolloutFiles(dirPath, files = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      listRolloutFiles(entryPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
}

function extractThreadIdFromRolloutPath(filePath) {
  const match = path.basename(filePath).match(ROLLOUT_FILE_RE);
  return match ? match[1] : null;
}

function extractUserMessage(entry, allowResponseUserMessage = false) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
    return truncateText(entry.payload.message || "", 120);
  }

  if (
    allowResponseUserMessage &&
    entry.type === "response_item" &&
    entry.payload?.type === "message" &&
    entry.payload?.role === "user"
  ) {
    return truncateText(getMessageText(entry.payload), 120);
  }

  return "";
}

function readRolloutMetadata(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    const metadata = {
      id: extractThreadIdFromRolloutPath(filePath),
      cwd: "",
      title: "",
      firstUserMessage: "",
    };
    let seenTurnContext = false;
    let fallbackUserMessage = "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue;
      }

      if (entry.type === "session_meta") {
        metadata.id = entry.payload?.id || metadata.id;
        metadata.cwd = entry.payload?.cwd || metadata.cwd;
      } else if (entry.type === "turn_context") {
        seenTurnContext = true;
        metadata.cwd = entry.payload?.cwd || metadata.cwd;
      }

      const userMessage = extractUserMessage(entry, seenTurnContext);
      if (entry.type === "event_msg" && entry.payload?.type === "user_message" && userMessage) {
        metadata.firstUserMessage = metadata.firstUserMessage || userMessage;
        metadata.title = metadata.title || userMessage;
      } else if (!metadata.firstUserMessage && userMessage) {
        fallbackUserMessage = fallbackUserMessage || userMessage;
      }

      if (metadata.id && metadata.cwd && metadata.title) {
        break;
      }
    }

    if (!metadata.firstUserMessage && fallbackUserMessage) {
      metadata.firstUserMessage = fallbackUserMessage;
      metadata.title = metadata.title || fallbackUserMessage;
    }

    return metadata;
  } finally {
    fs.closeSync(fd);
  }
}

function listThreadsFromRollouts(limit = 50) {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    return [];
  }

  return listRolloutFiles(CODEX_SESSIONS_DIR)
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(({ filePath, mtimeMs }) => {
      const metadata = readRolloutMetadata(filePath);
      if (!metadata.id) {
        return null;
      }

      return {
        id: metadata.id,
        rollout_path: filePath,
        updated_at: mtimeMs,
        cwd: metadata.cwd,
        title: metadata.title,
        first_user_message: metadata.firstUserMessage,
      };
    })
    .filter(Boolean);
}

function listThreads() {
  const sql = [
    "select id, rollout_path, updated_at, cwd, title, first_user_message",
    "from threads",
    "where archived = 0",
    "order by updated_at desc",
    "limit 50;",
  ].join(" ");

  if (Date.now() < stateDbRetryAfter) {
    return listThreadsFromRollouts(50);
  }

  try {
    return runSqlJson(sql);
  } catch (error) {
    stateDbRetryAfter = Date.now() + STATE_DB_RETRY_MS;
    console.error(
      `[codex-bridge] Failed to query state DB, using rollout scan for ${Math.round(STATE_DB_RETRY_MS / 1000)}s:`,
      error.message
    );
    return listThreadsFromRollouts(50);
  }
}

function readAppendedText(filePath, previousOffset) {
  if (!fs.existsSync(filePath)) {
    return { text: "", nextOffset: 0 };
  }

  const stat = fs.statSync(filePath);
  const safeOffset = Math.min(previousOffset || 0, stat.size);
  const length = stat.size - safeOffset;

  if (length <= 0) {
    return { text: "", nextOffset: stat.size };
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, safeOffset);
    return { text: buffer.toString("utf8"), nextOffset: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function updateLastEvent(session, type, timestamp, details, turnId, options = {}) {
  const countAsActivity = options.countAsActivity !== false;
  session.lastEvent = {
    type,
    timestamp,
    details: truncateText(details),
    ...(turnId ? { turnId } : {}),
  };
  session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
  if (countAsActivity) {
    session.lastActivityAt = Math.max(session.lastActivityAt || 0, timestamp);
  }
}

function getMessageText(payload) {
  if (!payload || !Array.isArray(payload.content)) {
    return "";
  }

  return payload.content
    .filter((part) => part && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function summarizeToolCall(payload) {
  if (!payload) {
    return "";
  }

  const name = payload.name || "tool";
  if (!payload.arguments) {
    return name;
  }

  return truncateText(`${name}: ${payload.arguments}`, 140);
}

function applyEntry(session, entry) {
  const timestamp = parseTimestamp(entry.timestamp);
  const payload = entry.payload || {};
  const payloadType = payload.type;

  if (entry.type === "session_meta") {
    session.startedAt = session.startedAt || parseTimestamp(payload.timestamp || entry.timestamp);
    session.workingDirectory = payload.cwd || session.workingDirectory;
    session.status = session.status || "idle";
    session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
    return;
  }

  if (entry.type === "turn_context") {
    session.workingDirectory = payload.cwd || session.workingDirectory;
    session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
    return;
  }

  if (entry.type === "event_msg") {
    switch (payloadType) {
      case "task_started":
        session.status = "working";
        session.startedAt = session.startedAt || timestamp;
        session.lastTaskStartAt = timestamp;
        updateLastEvent(session, "task_started", timestamp, "Turn started", payload.turn_id);
        return;
      case "task_complete":
        session.status = "completed";
        session.lastTaskCompleteAt = timestamp;
        session.endedAt = timestamp;
        updateLastEvent(
          session,
          "turn_complete",
          timestamp,
          payload.last_agent_message || "Turn complete",
          payload.turn_id,
          { countAsActivity: false }
        );
        return;
      case "agent_message":
        if (session.status === "working") {
          updateLastEvent(session, "agent_message", timestamp, payload.message || "", undefined);
        }
        return;
      case "turn_aborted":
        session.status = "idle";
        session.endedAt = timestamp;
        updateLastEvent(session, "turn_aborted", timestamp, "Turn aborted", undefined, {
          countAsActivity: false,
        });
        return;
      default:
        session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
        return;
    }
  }

  if (entry.type === "response_item") {
    switch (payloadType) {
      case "function_call":
      case "custom_tool_call":
        session.status = "working";
        updateLastEvent(session, "tool_use", timestamp, summarizeToolCall(payload), payload.call_id);
        return;
      case "function_call_output":
      case "custom_tool_call_output":
      case "reasoning":
        if (session.status !== "completed") {
          session.status = "working";
          session.lastActivityAt = Math.max(session.lastActivityAt || 0, timestamp);
          session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
        }
        return;
      case "message":
        if (session.status === "working") {
          const text = getMessageText(payload);
          if (text) {
            updateLastEvent(session, "agent_message", timestamp, text, undefined);
          } else {
            session.lastActivityAt = Math.max(session.lastActivityAt || 0, timestamp);
            session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
          }
        }
        return;
      default:
        session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
        return;
    }
  }
}

function mergeNotifyCache(session, notifyEntry) {
  if (!notifyEntry) {
    return;
  }

  const timestamp = parseTimestamp(notifyEntry.lastUpdated || notifyEntry.timestamp || Date.now());

  if (notifyEntry.type === "agent-turn-complete") {
    if (session.lastTaskStartAt && timestamp < session.lastTaskStartAt) {
      return;
    }
    if (session.lastTaskCompleteAt && timestamp < session.lastTaskCompleteAt) {
      return;
    }

    session.lastUpdated = Math.max(session.lastUpdated || 0, timestamp);
    session.status = "completed";
    session.lastTaskCompleteAt = Math.max(session.lastTaskCompleteAt || 0, timestamp);
    session.endedAt = timestamp;
    updateLastEvent(
      session,
      "turn_complete",
      timestamp,
      notifyEntry.lastAssistantMessage || session.lastEvent?.details || "Turn complete",
      notifyEntry.turnId,
      { countAsActivity: false }
    );
  }
}

function reconcileSession(session, thread, now) {
  const threadUpdatedAt = parseTimestamp(thread.updated_at);
  const freshestActivity = Math.max(
    session.lastActivityAt || 0,
    session.lastTaskCompleteAt || 0,
    threadUpdatedAt || 0
  );
  const hasOpenTask = Boolean(
    session.lastTaskStartAt &&
    (!session.lastTaskCompleteAt || session.lastTaskStartAt > session.lastTaskCompleteAt)
  );

  session.sessionId = thread.id;
  session.workingDirectory = thread.cwd || session.workingDirectory;
  session.sessionTitle = truncateText(
    thread.title || thread.first_user_message || session.sessionTitle || `Codex ${thread.id.slice(0, 8)}`,
    120
  );
  session.lastUpdated = Math.max(session.lastUpdated || 0, freshestActivity);

  if (
    hasOpenTask &&
    now - freshestActivity < IN_PROGRESS_IDLE_MS
  ) {
    session.status = "working";
    delete session.endedAt;
    if (!session.lastEvent || session.lastEvent.type === "idle") {
      updateLastEvent(
        session,
        "activity",
        Math.max(session.lastTaskStartAt || 0, threadUpdatedAt || 0),
        "Codex turn in progress",
        undefined
      );
    }
  } else if (
    now - threadUpdatedAt < ACTIVE_WINDOW_MS &&
    (!session.lastTaskCompleteAt || threadUpdatedAt > session.lastTaskCompleteAt)
  ) {
    session.status = "working";
    delete session.endedAt;
    if (!session.lastEvent || session.lastEvent.type === "idle") {
      updateLastEvent(session, "activity", threadUpdatedAt, "Recent Codex activity", undefined);
    }
  }

  const idleAfterMs = hasOpenTask ? IN_PROGRESS_IDLE_MS : STALE_IDLE_MS;
  if (session.status === "working" && now - freshestActivity > idleAfterMs) {
    session.status = "idle";
    session.endedAt = now;
    updateLastEvent(
      session,
      "idle",
      now,
      hasOpenTask ? "Codex activity stalled" : "No recent Codex activity",
      undefined,
      { countAsActivity: false }
    );
  }

  if (session.status === "completed" && now - (session.lastTaskCompleteAt || 0) > COMPLETE_TO_IDLE_MS) {
    session.status = "idle";
    session.endedAt = now;
    updateLastEvent(session, "idle", now, "Codex idle", undefined, { countAsActivity: false });
  }

  if (!session.startedAt) {
    session.startedAt = threadUpdatedAt || now;
  }
}

function exportSession(session) {
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt || Date.now(),
    status: session.status || "idle",
    workingDirectory: session.workingDirectory || HOME,
    sessionTitle: session.sessionTitle || "",
    lastEvent: session.lastEvent || {
      type: "idle",
      timestamp: Date.now(),
      details: "",
    },
    lastUpdated: session.lastUpdated || Date.now(),
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
  };
}

function writeOutput(state, now) {
  ensureDir(OUTPUT_DIR);
  ensureDir(OUTPUT_SESSIONS_DIR);

  const status = {
    version: 1,
    lastUpdated: now,
    sessions: {},
  };

  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const exported = exportSession(session);
    status.sessions[sessionId] = exported;
    writeJsonAtomic(
      path.join(OUTPUT_SESSIONS_DIR, `${sessionId.replace(/[/\\:]/g, "_")}.json`),
      exported
    );
  }

  writeJsonAtomic(OUTPUT_STATUS_FILE, status);
}

function pruneSessions(state, now) {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const lastSeen = Math.max(
      session.lastUpdated || 0,
      session.lastTaskCompleteAt || 0,
      session.lastActivityAt || 0
    );

    if (now - lastSeen > PRUNE_AFTER_MS) {
      delete state.sessions[sessionId];
      const sessionFile = path.join(OUTPUT_SESSIONS_DIR, `${sessionId.replace(/[/\\:]/g, "_")}.json`);
      try {
        fs.unlinkSync(sessionFile);
      } catch (_) {}
    }
  }
}

function cycle() {
  if (running) {
    return;
  }

  running = true;
  try {
    ensureDir(BRIDGE_DIR);
    ensureDir(OUTPUT_DIR);
    ensureDir(OUTPUT_SESSIONS_DIR);

    const now = Date.now();
    const state = loadBridgeState();
    state.version = 1;
    state.sessions = state.sessions || {};
    const notifyCache = loadNotifyCache();
    const threads = listThreads();

    log("threads", threads.length);

    for (const thread of threads) {
      if (!thread.id || !thread.rollout_path) {
        continue;
      }

      const session = state.sessions[thread.id] || {
        sessionId: thread.id,
        status: "idle",
        offset: 0,
        lastUpdated: 0,
      };

      const { text, nextOffset } = readAppendedText(thread.rollout_path, session.offset || 0);
      if (text) {
        const lines = text.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            applyEntry(session, JSON.parse(line));
          } catch (error) {
            log("skip malformed line", error.message);
          }
        }
      }

      session.offset = nextOffset;
      session.rolloutPath = thread.rollout_path;
      mergeNotifyCache(session, notifyCache.sessions?.[thread.id]);
      reconcileSession(session, thread, now);
      state.sessions[thread.id] = session;
    }

    pruneSessions(state, now);
    saveBridgeState(state);
    writeOutput(state, now);
  } catch (error) {
    console.error("[codex-bridge] Poll cycle failed:", error);
  } finally {
    running = false;
  }
}

function main() {
  cycle();
  if (ONCE) {
    return;
  }

  setInterval(cycle, POLL_MS);
}

main();
