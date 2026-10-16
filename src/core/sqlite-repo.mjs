// SQLite Repository, Idempotent Migration, Secret Store & Transactional Upserts (Batch 2)
// Uses built-in node:sqlite (DatabaseSync) with WAL mode and busy_timeout for safe concurrency.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sqlite from "node:sqlite";
import {
  buildHonestChannelRecord,
  evaluateChannelVideosOutliers,
  DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
} from "./metrics.mjs";
import {
  SEED_CHANNELS,
  INITIAL_FILTER_TEMPLATES,
  INITIAL_SWIPE_FOLDERS,
  INITIAL_SWIPE_ITEMS
} from "./seed-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, "../../data");
export const LEGACY_JSON_PATH = path.resolve(DATA_DIR, "nexlev-db.json");
export const SQLITE_DB_PATH =
  process.env.NEXLEV_SQLITE_PATH || path.resolve(DATA_DIR, "nexlev.sqlite");
export const SECRETS_FILE_PATH =
  process.env.NEXLEV_SECRETS_PATH || path.resolve(DATA_DIR, ".secrets.local.json");

export function getActiveSqlitePath(customPath = null) {
  return customPath || process.env.NEXLEV_SQLITE_PATH || SQLITE_DB_PATH;
}

export function getActiveSecretsPath() {
  return process.env.NEXLEV_SECRETS_PATH || SECRETS_FILE_PATH;
}

export { DEFAULT_MIN_OUTLIER_SAMPLE_SIZE };

const DEMO_CHANNEL_IDS = new Set(SEED_CHANNELS.map((c) => c.id));
const DEMO_SWIPE_IDS = new Set(INITIAL_SWIPE_ITEMS.map((i) => i.id));

let dbInstance = null;
let currentDbPath = null;
let migrationCheckedForPath = null;

export function getSqliteDb(customPath = null) {
  const targetPath = getActiveSqlitePath(customPath);
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const db = new sqlite.DatabaseSync(targetPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  dbInstance = db;
  currentDbPath = targetPath;
  return db;
}

export function ensureDbMigrated(customDb = null) {
  if (customDb) {
    initSchema(customDb);
    migrateLegacyJsonToSqlite(customDb, LEGACY_JSON_PATH);
    applyV21ReviewFixesMigration(customDb);
    return customDb;
  }
  const db = getSqliteDb();
  if (migrationCheckedForPath !== currentDbPath) {
    migrateLegacyJsonToSqlite(db, LEGACY_JSON_PATH);
    applyV21ReviewFixesMigration(db);
    migrationCheckedForPath = currentDbPath;
  }
  return db;
}

export function closeSqliteDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore close errors
    }
    dbInstance = null;
    currentDbPath = null;
    migrationCheckedForPath = null;
  }
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      reconciliation_json TEXT
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      handle TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      avatar_url TEXT,
      data_origin TEXT NOT NULL DEFAULT 'observed',
      discovery_country TEXT,
      discovery_lang TEXT,
      discovery_keyword TEXT,
      channel_country TEXT,
      channel_country_status TEXT DEFAULT 'unknown',
      content_language TEXT,
      content_language_status TEXT DEFAULT 'unknown',
      niche TEXT,
      niche_status TEXT DEFAULT 'unknown',
      format TEXT,
      format_status TEXT DEFAULT 'unknown',
      content_type TEXT DEFAULT 'unknown',
      is_faceless INTEGER,
      faceless_label TEXT DEFAULT 'unknown',
      faceless_status TEXT DEFAULT 'unknown',
      faceless_reason TEXT,
      faceless_signals_json TEXT DEFAULT '[]',
      is_ai_content INTEGER,
      ai_label TEXT DEFAULT 'unknown',
      ai_status TEXT DEFAULT 'unknown',
      ai_signals_json TEXT DEFAULT '[]',
      is_monetized INTEGER,
      monetization_status TEXT DEFAULT 'unknown',
      monetization_reason TEXT,
      is_kids_content INTEGER,
      subscribers INTEGER,
      subscribers_status TEXT DEFAULT 'unknown',
      total_views INTEGER,
      total_views_status TEXT DEFAULT 'unknown',
      video_count INTEGER,
      video_count_status TEXT DEFAULT 'unknown',
      observed_video_sample_count INTEGER DEFAULT 0,
      avg_views INTEGER,
      median_views INTEGER,
      avg_duration_minutes REAL,
      upload_frequency_per_month REAL,
      channel_joined_at TEXT,
      channel_age_months REAL,
      channel_age_status TEXT DEFAULT 'unknown',
      channel_age_reason TEXT,
      oldest_observed_video_days REAL,
      estimated_rpm REAL,
      rpm_status TEXT DEFAULT 'estimated',
      monthly_views INTEGER,
      monthly_views_status TEXT DEFAULT 'unknown',
      monthly_revenue_min INTEGER,
      monthly_revenue_max INTEGER,
      revenue_status TEXT DEFAULT 'unknown',
      revenue_assumptions_json TEXT,
      max_outlier_score INTEGER,
      top_outlier_ratio REAL,
      outlier_status TEXT DEFAULT 'insufficient_data',
      outlier_reason TEXT,
      baselines_by_format_json TEXT DEFAULT '{}',
      provenance_json TEXT DEFAULT '{}',
      is_tracked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_enriched_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_channels_origin ON channels(data_origin);
    CREATE INDEX IF NOT EXISTS idx_channels_niche ON channels(niche);
    CREATE INDEX IF NOT EXISTS idx_channels_outlier ON channels(top_outlier_ratio);
    CREATE INDEX IF NOT EXISTS idx_channels_tracked ON channels(is_tracked);

    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      thumbnail_url TEXT,
      canonical_url TEXT,
      content_type TEXT DEFAULT 'unknown',
      views INTEGER,
      views_status TEXT DEFAULT 'unknown',
      views_is_rounded INTEGER DEFAULT 0,
      likes INTEGER,
      comments INTEGER,
      duration_seconds INTEGER,
      duration_minutes REAL,
      published_at TEXT,
      published_days_ago REAL,
      published_status TEXT DEFAULT 'unknown',
      views_per_day INTEGER,
      outlier_ratio REAL,
      outlier_score INTEGER,
      outlier_status TEXT DEFAULT 'insufficient_data',
      outlier_reason TEXT,
      baseline_median_views INTEGER,
      baseline_sample_size INTEGER DEFAULT 0,
      age_skew_warning TEXT,
      estimated_revenue INTEGER,
      estimated_revenue_status TEXT DEFAULT 'unknown',
      data_origin TEXT NOT NULL DEFAULT 'observed',
      source TEXT,
      collected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_videos_outlier ON videos(outlier_ratio);
    CREATE INDEX IF NOT EXISTS idx_videos_published_days ON videos(published_days_ago);

    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      channel_id TEXT,
      views INTEGER,
      subscribers INTEGER,
      video_count INTEGER,
      source TEXT,
      note TEXT,
      scope TEXT DEFAULT 'channel_total_views',
      cohort_hash TEXT DEFAULT '',
      coverage_count INTEGER DEFAULT 0,
      collected_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON metric_snapshots(entity_type, entity_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_channel ON metric_snapshots(channel_id, entity_type, collected_at);

    CREATE TABLE IF NOT EXISTS discovery_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      video_id TEXT,
      market_code TEXT NOT NULL,
      language_code TEXT NOT NULL,
      seed_keyword TEXT NOT NULL,
      source TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      UNIQUE(channel_id, market_code, seed_keyword)
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_channel ON discovery_records(channel_id);
    CREATE INDEX IF NOT EXISTS idx_discovery_market ON discovery_records(market_code);

    CREATE TABLE IF NOT EXISTS crawl_seeds (
      seed_key TEXT PRIMARY KEY,
      market_code TEXT NOT NULL,
      language_code TEXT NOT NULL,
      keyword TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'static',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      discovered_channels_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_seeds_market ON crawl_seeds(market_code, last_success_at);

    CREATE TABLE IF NOT EXISTS crawl_jobs (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      params_json TEXT,
      progress_json TEXT,
      summary_json TEXT,
      error_text TEXT,
      request_count INTEGER DEFAULT 0,
      cancel_requested INTEGER DEFAULT 0,
      worker_id TEXT DEFAULT NULL,
      lease_until TEXT DEFAULT NULL,
      heartbeat_at TEXT DEFAULT NULL,
      actor_username TEXT DEFAULT '',
      dedupe_key TEXT DEFAULT NULL,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swipe_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swipe_items (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'video',
      video_id TEXT,
      channel_id TEXT,
      canonical_url TEXT,
      title TEXT NOT NULL,
      channel_title TEXT DEFAULT '',
      channel_handle TEXT DEFAULT '',
      thumbnail_url TEXT DEFAULT '',
      outlier_ratio REAL,
      views INTEGER,
      estimated_rpm REAL,
      workflow_stage TEXT NOT NULL DEFAULT 'discovered',
      assignee_id TEXT DEFAULT '',
      owner_label TEXT DEFAULT '',
      deadline TEXT DEFAULT '',
      result_url TEXT DEFAULT '',
      published_video_url TEXT DEFAULT '',
      brief_markdown TEXT DEFAULT '',
      brief_status TEXT DEFAULT 'empty',
      tags_json TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      data_origin TEXT NOT NULL DEFAULT 'observed',
      metrics_source_status TEXT NOT NULL DEFAULT 'unknown',
      metrics_as_of TEXT DEFAULT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT DEFAULT NULL,
      approved_by TEXT DEFAULT '',
      approved_at TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      updated_by TEXT DEFAULT '',
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_swipe_folder ON swipe_items(folder_id);
    CREATE INDEX IF NOT EXISTS idx_swipe_stage ON swipe_items(workflow_stage);

    CREATE TABLE IF NOT EXISTS work_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swipe_item_id TEXT NOT NULL,
      actor_user_id TEXT,
      actor_username TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_activity_item ON work_activity(swipe_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS brief_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swipe_item_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      brief_markdown TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_brief_revisions_item ON brief_revisions(swipe_item_id, revision_number DESC);

    CREATE TABLE IF NOT EXISTS import_targets (
      id TEXT PRIMARY KEY,
      raw_input TEXT NOT NULL,
      target_type TEXT NOT NULL,
      canonical_url TEXT,
      resolved_channel_id TEXT,
      resolved_video_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      reason TEXT,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_import_targets_status ON import_targets(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS filter_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      filters_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      api_token TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
  `);

  // Safe schema evolution for existing SQLite files
  ensureColumn(db, "swipe_items", "assignee_id", "TEXT DEFAULT ''");
  ensureColumn(db, "swipe_items", "deadline", "TEXT DEFAULT ''");
  ensureColumn(db, "swipe_items", "result_url", "TEXT DEFAULT ''");
  ensureColumn(db, "swipe_items", "created_by", "TEXT DEFAULT ''");
  ensureColumn(db, "swipe_items", "updated_by", "TEXT DEFAULT ''");
  ensureColumn(db, "swipe_items", "brief_status", "TEXT DEFAULT 'empty'");
  ensureColumn(db, "swipe_items", "data_origin", "TEXT NOT NULL DEFAULT 'observed'");
  ensureColumn(db, "swipe_items", "metrics_source_status", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "swipe_items", "metrics_as_of", "TEXT DEFAULT NULL");
  ensureColumn(db, "swipe_items", "revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "swipe_items", "archived_at", "TEXT DEFAULT NULL");
  ensureColumn(db, "swipe_items", "approved_by", "TEXT DEFAULT ''");
  ensureColumn(db, "swipe_items", "approved_at", "TEXT DEFAULT ''");

  ensureColumn(db, "channels", "watchlist_note", "TEXT DEFAULT ''");
  ensureColumn(db, "channels", "watchlist_added_by", "TEXT DEFAULT ''");
  ensureColumn(db, "channels", "watchlist_added_at", "TEXT DEFAULT ''");

  ensureColumn(db, "crawl_jobs", "worker_id", "TEXT DEFAULT NULL");
  ensureColumn(db, "crawl_jobs", "lease_until", "TEXT DEFAULT NULL");
  ensureColumn(db, "crawl_jobs", "heartbeat_at", "TEXT DEFAULT NULL");
  ensureColumn(db, "crawl_jobs", "actor_username", "TEXT DEFAULT ''");
  ensureColumn(db, "crawl_jobs", "dedupe_key", "TEXT DEFAULT NULL");

  ensureColumn(db, "metric_snapshots", "scope", "TEXT DEFAULT 'channel_total_views'");
  ensureColumn(db, "metric_snapshots", "cohort_hash", "TEXT DEFAULT ''");
  ensureColumn(db, "metric_snapshots", "coverage_count", "INTEGER DEFAULT 0");

  ensureDefaultUsers(db);
}

function ensureColumn(db, tableName, colName, colDef) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (!cols.some((c) => c.name === colName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDef}`);
    }
  } catch {
    // ignore if column already exists
  }
}

// ============================================================================
// INTERNAL TEAM AUTHENTICATION & RBAC (manager / member)
// ============================================================================

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString("hex");
}

export function getUserCapabilities(role) {
  const isManager = role === "manager";
  return {
    canApproveIdea: isManager,
    canAssignWork: isManager,
    canEditAnyWork: isManager,
    canDeleteAnyWork: isManager,
    canManageTeam: isManager,
    canManageSecrets: isManager,
    canManageSchedule: isManager,
    canCollect: true,
    canSaveIdea: true,
    canCreateBrief: true,
    canUpdateOwnAssignedWork: true
  };
}

export function maskApiToken(val = "") {
  if (!val || val.length < 10) return "";
  return `${val.slice(0, 6)}••••${val.slice(-4)}`;
}

export function ensureDefaultUsers(db) {
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (countRow && countRow.c > 0) return;

  const now = new Date().toISOString();
  const defaultAccounts = [
    {
      id: "user-manager-admin",
      username: "admin",
      displayName: "Quản lý Team (Manager)",
      role: "manager",
      password: process.env.NEXLEV_ADMIN_PASSWORD || "nexlev-admin-2026"
    },
    {
      id: "user-member-01",
      username: "member1",
      displayName: "Nhân viên Research 01",
      role: "member",
      password: process.env.NEXLEV_MEMBER_PASSWORD || "nexlev-member-2026"
    },
    {
      id: "user-member-02",
      username: "member2",
      displayName: "Nhân viên Content/Editor 02",
      role: "member",
      password: process.env.NEXLEV_MEMBER_PASSWORD || "nexlev-member-2026"
    }
  ];

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (
      id, username, display_name, role, password_salt, password_hash, api_token, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  for (const acc of defaultAccounts) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(acc.password, salt);
    const apiToken = `nxl_${acc.username}_${crypto.randomBytes(18).toString("hex")}`;
    insertUser.run(
      acc.id,
      acc.username,
      acc.displayName,
      acc.role,
      salt,
      hash,
      apiToken,
      now,
      now
    );
  }
}

export function authenticateUser(db, username, password) {
  const cleanUser = String(username || "").trim().toLowerCase();
  const rawPass = String(password || "");
  if (!cleanUser || !rawPass) return null;

  const row = db
    .prepare("SELECT * FROM users WHERE LOWER(username) = ? AND is_active = 1")
    .get(cleanUser);
  if (!row) return null;

  const computedHash = hashPassword(rawPass, row.password_salt);
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(row.password_hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 86_400_000).toISOString(); // 14 days
  const sessionToken = `sess_${crypto.randomBytes(24).toString("hex")}`;

  db.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionToken, row.id, expiresAt, now.toISOString());

  return {
    token: sessionToken,
    sessionToken,
    expiresAt,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      hasApiToken: Boolean(row.api_token),
      apiTokenMasked: maskApiToken(row.api_token),
      apiTokenPreview: maskApiToken(row.api_token),
      capabilities: getUserCapabilities(row.role)
    }
  };
}

export function revokeUserSession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM user_sessions WHERE token = ?").run(String(token));
}

export function revokeAllUserSessions(db, userId) {
  if (!userId) return;
  db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(String(userId));
}

export function rotateUserApiToken(db, userId) {
  const row = db.prepare("SELECT * FROM users WHERE id = ? AND is_active = 1").get(String(userId));
  if (!row) {
    const err = new Error("Không tìm thấy tài khoản hoạt động để đổi API token.");
    err.statusCode = 404;
    throw err;
  }
  const nextToken = `nxl_${row.username}_${crypto.randomBytes(18).toString("hex")}`;
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET api_token = ?, updated_at = ? WHERE id = ?").run(
    nextToken,
    now,
    row.id
  );
  return {
    apiToken: nextToken,
    apiTokenMasked: maskApiToken(nextToken),
    apiTokenPreview: maskApiToken(nextToken),
    updatedAt: now
  };
}

export function getPersonalApiTokenForUser(db, userId) {
  const row = db.prepare("SELECT api_token FROM users WHERE id = ? AND is_active = 1").get(String(userId));
  if (!row) return null;
  return row.api_token || "";
}

export function resolveUserFromToken(db, rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) return null;

  // 1. Check active user_sessions
  const sess = db
    .prepare(
      `SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role, u.api_token, u.is_active
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (sess) {
    if (!sess.is_active || Date.parse(sess.expires_at) < Date.now()) {
      db.prepare("DELETE FROM user_sessions WHERE token = ?").run(token);
      return null;
    }
    return {
      id: sess.id,
      username: sess.username,
      displayName: sess.display_name,
      role: sess.role,
      hasApiToken: Boolean(sess.api_token),
      apiTokenMasked: maskApiToken(sess.api_token),
      apiTokenPreview: maskApiToken(sess.api_token),
      capabilities: getUserCapabilities(sess.role)
    };
  }

  // 2. Check personal user api_token (for Chrome Extension / API scripts)
  const apiUser = db
    .prepare("SELECT * FROM users WHERE api_token = ? AND is_active = 1")
    .get(token);
  if (apiUser) {
    return {
      id: apiUser.id,
      username: apiUser.username,
      displayName: apiUser.display_name,
      role: apiUser.role,
      hasApiToken: Boolean(apiUser.api_token),
      apiTokenMasked: maskApiToken(apiUser.api_token),
      apiTokenPreview: maskApiToken(apiUser.api_token),
      capabilities: getUserCapabilities(apiUser.role)
    };
  }

  // 3. Check system localApiToken from .secrets.local.json (when explicitly supplied as Bearer token)
  const secrets = loadSecrets();
  if (secrets.localApiToken && token === secrets.localApiToken) {
    const adminRow = db
      .prepare("SELECT * FROM users WHERE role = 'manager' AND is_active = 1 ORDER BY created_at ASC LIMIT 1")
      .get();
    if (adminRow) {
      return {
        id: adminRow.id,
        username: adminRow.username,
        displayName: adminRow.display_name,
        role: adminRow.role,
        hasApiToken: Boolean(adminRow.api_token),
        apiTokenMasked: maskApiToken(adminRow.api_token),
        apiTokenPreview: maskApiToken(adminRow.api_token),
        capabilities: getUserCapabilities(adminRow.role)
      };
    }
  }

  return null;
}

export function listTeamUsers(db) {
  const rows = db.prepare("SELECT * FROM users ORDER BY role ASC, username ASC").all();
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    isActive: Boolean(r.is_active),
    hasApiToken: Boolean(r.api_token),
    apiTokenMasked: maskApiToken(r.api_token),
    apiTokenPreview: maskApiToken(r.api_token),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

export function createTeamUser(db, { username, displayName, role = "member", password }) {
  const cleanUser = String(username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "");
  if (!cleanUser || cleanUser.length < 2) {
    const err = new Error("Username phải có ít nhất 2 ký tự hợp lệ (a-z, 0-9, _, ., -).");
    err.statusCode = 400;
    err.code = "INVALID_USERNAME";
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error("Mật khẩu phải có ít nhất 6 ký tự.");
    err.statusCode = 400;
    err.code = "INVALID_PASSWORD";
    throw err;
  }
  const existing = db.prepare("SELECT id FROM users WHERE LOWER(username) = ?").get(cleanUser);
  if (existing) {
    const err = new Error(`Username "${cleanUser}" đã tồn tại.`);
    err.statusCode = 409;
    err.code = "DUPLICATE_USERNAME";
    throw err;
  }

  const validRole = role === "manager" ? "manager" : "member";
  const now = new Date().toISOString();
  const id = `user-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const apiToken = `nxl_${cleanUser}_${crypto.randomBytes(18).toString("hex")}`;

  db.prepare(`
    INSERT INTO users (
      id, username, display_name, role, password_salt, password_hash, api_token, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    cleanUser,
    String(displayName || cleanUser).trim(),
    validRole,
    salt,
    hash,
    apiToken,
    now,
    now
  );

  return {
    id,
    username: cleanUser,
    displayName: String(displayName || cleanUser).trim(),
    role: validRole,
    isActive: true,
    apiTokenMasked: maskApiToken(apiToken),
    createdAt: now
  };
}

export function updateTeamUser(db, id, patch = {}) {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!existing) {
    const err = new Error(`Không tìm thấy nhân viên "${id}".`);
    err.statusCode = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const nextRole =
    patch.role === "manager" || patch.role === "member" ? patch.role : existing.role;
  const nextActive =
    typeof patch.isActive === "boolean" ? (patch.isActive ? 1 : 0) : existing.is_active;
  const nextDisplayName =
    typeof patch.displayName === "string" && patch.displayName.trim()
      ? patch.displayName.trim()
      : existing.display_name;

  let nextSalt = existing.password_salt;
  let nextHash = existing.password_hash;
  let nextApiToken = existing.api_token;
  const passwordChanged =
    typeof patch.password === "string" && patch.password.trim().length >= 6;
  const deactivated = existing.is_active === 1 && nextActive === 0;
  const roleChanged = existing.role !== nextRole;

  if (passwordChanged) {
    nextSalt = crypto.randomBytes(16).toString("hex");
    nextHash = hashPassword(patch.password.trim(), nextSalt);
  }

  // T01: Revoke all active sessions & rotate personal API token when password changes or user is deactivated
  if (passwordChanged || deactivated || patch.rotateApiToken === true) {
    nextApiToken = `nxl_${existing.username}_${crypto.randomBytes(18).toString("hex")}`;
    revokeAllUserSessions(db, existing.id);
  } else if (roleChanged) {
    // Ensure capabilities are refreshed
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET
      display_name = ?,
      role = ?,
      password_salt = ?,
      password_hash = ?,
      api_token = ?,
      is_active = ?,
      updated_at = ?
    WHERE id = ?
  `).run(nextDisplayName, nextRole, nextSalt, nextHash, nextApiToken, nextActive, now, id);

  return {
    id: existing.id,
    username: existing.username,
    displayName: nextDisplayName,
    role: nextRole,
    isActive: Boolean(nextActive),
    apiTokenMasked: maskApiToken(nextApiToken),
    sessionsRevoked: passwordChanged || deactivated || Boolean(patch.rotateApiToken),
    updatedAt: now
  };
}


// ============================================================================
// LOCAL SECRETS MANAGEMENT (Never stored in SQLite or Git-tracked JSON)
// ============================================================================

export function loadSecrets() {
  const secretsPath = getActiveSecretsPath();
  let fileSecrets = {};
  if (fs.existsSync(secretsPath)) {
    try {
      fileSecrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    } catch {
      fileSecrets = {};
    }
  }

  // Generate a persistent local API token if none exists
  if (!fileSecrets.localApiToken && !process.env.NEXLEV_LOCAL_TOKEN) {
    fileSecrets.localApiToken = crypto.randomBytes(24).toString("hex");
    saveSecretsFile(fileSecrets);
  }

  return {
    youtubeApiKey: process.env.YOUTUBE_API_KEY || fileSecrets.youtubeApiKey || "",
    geminiApiKey: process.env.GEMINI_API_KEY || fileSecrets.geminiApiKey || "",
    localApiToken: process.env.NEXLEV_LOCAL_TOKEN || fileSecrets.localApiToken || ""
  };
}

function saveSecretsFile(secretsObj) {
  const secretsPath = getActiveSecretsPath();
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  const tmp = `${secretsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(secretsObj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, secretsPath);
}

/**
 * Updates secrets with explicit operations: 'keep' | 'replace' | 'clear'
 * Never wipes a key just because an empty string was submitted with 'keep'.
 */
export function updateSecrets({
  youtubeApiKeyAction = "keep",
  youtubeApiKey = "",
  geminiApiKeyAction = "keep",
  geminiApiKey = ""
} = {}) {
  const current = loadSecrets();
  const next = { ...current };

  if (youtubeApiKeyAction === "clear") {
    next.youtubeApiKey = "";
  } else if (youtubeApiKeyAction === "replace" && typeof youtubeApiKey === "string" && youtubeApiKey.trim()) {
    next.youtubeApiKey = youtubeApiKey.trim();
  }

  if (geminiApiKeyAction === "clear") {
    next.geminiApiKey = "";
  } else if (geminiApiKeyAction === "replace" && typeof geminiApiKey === "string" && geminiApiKey.trim()) {
    next.geminiApiKey = geminiApiKey.trim();
  }

  saveSecretsFile(next);
  return next;
}

export function maskSecret(val = "") {
  if (!val || val.length < 8) return "";
  return `${val.slice(0, 4)}••••${val.slice(-4)}`;
}

// ============================================================================
// APP SETTINGS HELPERS
// ============================================================================

export function getAppSetting(db, key, defaultValue = null) {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key);
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return defaultValue;
  }
}

export function setAppSetting(db, key, value) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
}

// ============================================================================
// CHANNEL & VIDEO TRANSACTIONAL UPSERT + RECOMPUTATION
// ============================================================================

/**
 * Upserts a channel and merges its newly observed videos with any existing videos
 * already stored in SQLite, then recomputes honest channel-level and video-level
 * outlier metrics without losing older videos or overwriting observed channel country!
 */
export function upsertChannelAndVideos(
  db,
  {
    channelId,
    handle = null,
    title = null,
    description = null,
    avatarUrl = null,
    observedSubscribers = null,
    observedTotalViews = null,
    observedVideoCount = null,
    observedChannelCountry = null,
    observedJoinedAt = null,
    observedContentLanguage = null,
    isKidsContent = null,
    discoveryMarket = null, // { countryCode, languageCode, seedKeyword, source }
    videos = [],
    dataOrigin = "observed",
    minOutlierSampleSize = null,
    recordSnapshot = true,
    collectedAt = new Date().toISOString()
  }
) {
  if (!channelId) throw new Error("channelId is required for upsertChannelAndVideos");

  const configuredMinSample =
    minOutlierSampleSize !== null && minOutlierSampleSize !== undefined
      ? Number(minOutlierSampleSize)
      : Number(getAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE));
  const effectiveMinSampleSize = Math.max(
    3,
    Number.isFinite(configuredMinSample) ? Math.round(configuredMinSample) : DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
  );

  return withTransaction(db, () => {
    const existingCh = db
      .prepare("SELECT * FROM channels WHERE id = ?")
      .get(channelId);

    const existingVideosRows = db
      .prepare("SELECT * FROM videos WHERE channel_id = ?")
      .all(channelId);

    // Map existing videos by videoId so re-crawling from another market never deletes older videos
    const mergedVideoMap = new Map();
    for (const row of existingVideosRows) {
      mergedVideoMap.set(row.video_id, {
        videoId: row.video_id,
        title: row.title,
        description: row.description || "",
        thumbnailUrl: row.thumbnail_url,
        canonicalUrl: row.canonical_url || `https://www.youtube.com/watch?v=${row.video_id}`,
        contentType: row.content_type && row.content_type !== "unknown" ? row.content_type : null,
        views: row.views,
        viewsStatus: row.views_status || "unknown",
        viewsIsRounded: Boolean(row.views_is_rounded),
        likes: row.likes,
        comments: row.comments,
        durationSeconds: row.duration_seconds,
        durationMinutes: row.duration_minutes,
        publishedAt: row.published_at,
        publishedDaysAgo: row.published_days_ago,
        publishedStatus: row.published_status || "unknown",
        dataOrigin: row.data_origin || "observed",
        source: row.source || row.data_origin || "observed",
        collectedAt: row.collected_at || collectedAt
      });
    }

    // Merge incoming videos with provenance & timestamp protection (T06)
    for (const v of videos || []) {
      const vid = v.videoId || v.video_id;
      if (!vid) continue;
      const prev = mergedVideoMap.get(vid);
      const incomingOrigin = v.dataOrigin || dataOrigin || "observed";
      const incomingCollectedAt = v.collectedAt || collectedAt;
      const incomingTs = Date.parse(incomingCollectedAt) || 0;
      const prevTs = prev?.collectedAt ? Date.parse(prev.collectedAt) || 0 : 0;

      // Determine if incoming observation is allowed to overwrite existing video metadata/metrics:
      // 1. No previous record
      // 2. Upgrading from legacy_unverified / demo to observed
      // 3. Same or stronger provenance with a timestamp >= previous collected_at
      const isUpgradeToObserved =
        incomingOrigin === "observed" && prev && prev.dataOrigin !== "observed";
      const isFresherOrEqual =
        !prev ||
        isUpgradeToObserved ||
        ( !(prev.dataOrigin === "observed" && incomingOrigin !== "observed") &&
          incomingTs >= prevTs );

      const incomingHasViews = typeof v.views === "number" && Number.isFinite(v.views) && v.views >= 0;
      const incomingViewsStatus = incomingHasViews
        ? v.viewsStatus || (incomingOrigin === "observed" ? "observed" : incomingOrigin)
        : v.viewsStatus || "unknown";

      if (!prev) {
        mergedVideoMap.set(vid, {
          videoId: vid,
          title: v.title || `Video ${vid}`,
          description: v.description ?? "",
          thumbnailUrl: v.thumbnailUrl || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          canonicalUrl: v.canonicalUrl || `https://www.youtube.com/watch?v=${vid}`,
          contentType: v.contentType || null,
          isShorts: v.isShorts,
           isLive: v.isLive,
          aspectRatio: v.aspectRatio || null,
          views: incomingHasViews ? Math.round(v.views) : null,
          viewsStatus: incomingViewsStatus,
          viewsIsRounded: Boolean(v.viewsIsRounded),
          likes: typeof v.likes === "number" && Number.isFinite(v.likes) ? Math.round(v.likes) : null,
          comments:
            typeof v.comments === "number" && Number.isFinite(v.comments) ? Math.round(v.comments) : null,
          durationSeconds: typeof v.durationSeconds === "number" ? v.durationSeconds : null,
          durationMinutes:
            typeof v.durationMinutes === "number" && Number.isFinite(v.durationMinutes)
              ? v.durationMinutes
              : null,
          publishedAt: v.publishedAt || null,
          publishedDaysAgo:
            typeof v.publishedDaysAgo === "number" && Number.isFinite(v.publishedDaysAgo)
              ? v.publishedDaysAgo
              : null,
          publishedStatus: v.publishedStatus || "unknown",
          dataOrigin: incomingOrigin,
          source: v.source || incomingOrigin,
          collectedAt: incomingCollectedAt
        });
      } else if (isFresherOrEqual) {
        mergedVideoMap.set(vid, {
          videoId: vid,
          title: v.title || prev.title || `Video ${vid}`,
          description:
            v.description !== undefined && v.description !== ""
              ? v.description
              : prev.description || "",
          thumbnailUrl:
            v.thumbnailUrl || prev.thumbnailUrl || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          canonicalUrl:
            v.canonicalUrl || prev.canonicalUrl || `https://www.youtube.com/watch?v=${vid}`,
          contentType:
            v.contentType && v.contentType !== "unknown"
              ? v.contentType
              : prev.contentType || null,
          isShorts: v.isShorts !== undefined ? v.isShorts : prev.isShorts,
          isLive: v.isLive !== undefined ? v.isLive : prev.isLive,
          aspectRatio: v.aspectRatio || prev.aspectRatio || null,
          views: incomingHasViews ? Math.round(v.views) : prev.views ?? null,
          viewsStatus: incomingHasViews ? incomingViewsStatus : prev.viewsStatus || "unknown",
          viewsIsRounded:
            v.viewsIsRounded !== undefined
              ? Boolean(v.viewsIsRounded)
              : Boolean(prev.viewsIsRounded),
          likes:
            typeof v.likes === "number" && Number.isFinite(v.likes)
              ? Math.round(v.likes)
              : isUpgradeToObserved
                ? null
                : prev.likes ?? null,
          comments:
            typeof v.comments === "number" && Number.isFinite(v.comments)
              ? Math.round(v.comments)
              : isUpgradeToObserved
                ? null
                : prev.comments ?? null,
          durationSeconds:
            typeof v.durationSeconds === "number"
              ? v.durationSeconds
              : prev.durationSeconds ?? null,
          durationMinutes:
            typeof v.durationMinutes === "number" && Number.isFinite(v.durationMinutes)
              ? v.durationMinutes
              : prev.durationMinutes ?? null,
          publishedAt: v.publishedAt || prev.publishedAt || null,
          publishedDaysAgo:
            typeof v.publishedDaysAgo === "number" && Number.isFinite(v.publishedDaysAgo)
              ? v.publishedDaysAgo
              : prev.publishedDaysAgo ?? null,
          publishedStatus:
            v.publishedStatus && v.publishedStatus !== "unknown"
              ? v.publishedStatus
              : prev.publishedStatus || "unknown",
          dataOrigin:
            incomingOrigin === "observed" || prev.dataOrigin === "observed"
              ? "observed"
              : incomingOrigin,
          source: v.source || prev.source || incomingOrigin,
          collectedAt: incomingCollectedAt
        });
      }
    }

    // Preserve previously observed channel-level fields if incoming discovery doesn't have them
    const finalObservedSubscribers =
      observedSubscribers !== null && observedSubscribers !== undefined
        ? observedSubscribers
        : existingCh?.subscribers_status === "observed"
          ? existingCh.subscribers
          : null;

    const finalObservedTotalViews =
      observedTotalViews !== null && observedTotalViews !== undefined
        ? observedTotalViews
        : existingCh?.total_views_status === "observed"
          ? existingCh.total_views
          : null;

    const finalObservedVideoCount =
      observedVideoCount !== null && observedVideoCount !== undefined
        ? observedVideoCount
        : existingCh?.video_count_status === "observed"
          ? existingCh.video_count
          : null;

    // Channel country is NEVER overwritten by discoveryMarket.countryCode!
    const finalObservedChannelCountry =
      observedChannelCountry !== null && observedChannelCountry !== undefined
        ? observedChannelCountry
        : existingCh?.channel_country_status === "observed"
          ? existingCh.channel_country
          : null;

    const finalObservedJoinedAt =
      observedJoinedAt || existingCh?.channel_joined_at || null;

    const finalObservedLanguage =
      observedContentLanguage ||
      (existingCh?.content_language_status === "observed"
        ? existingCh.content_language
        : null);

    const allMergedVideos = Array.from(mergedVideoMap.values());
    const hasAnyObservedVideo = allMergedVideos.some((v) => v.dataOrigin === "observed");
    const allVideosLegacyUnverified =
      allMergedVideos.length > 0 &&
      allMergedVideos.every((v) => v.dataOrigin === "legacy_unverified");

    // T06: Never promote a channel to 'observed' if all its videos are 'legacy_unverified' and no channel-level stats were observed
    let finalOrigin = dataOrigin || existingCh?.data_origin || "observed";
    if (DEMO_CHANNEL_IDS.has(channelId) || dataOrigin === "demo") {
      finalOrigin = hasAnyObservedVideo ? "observed" : "demo";
    } else if (
      allVideosLegacyUnverified &&
      finalObservedSubscribers === null &&
      finalObservedTotalViews === null
    ) {
      finalOrigin = "legacy_unverified";
    } else if (hasAnyObservedVideo || existingCh?.data_origin === "observed" || dataOrigin === "observed") {
      finalOrigin = "observed";
    }

    const honest = buildHonestChannelRecord({
      id: channelId,
      handle: handle || existingCh?.handle || null,
      title: title || existingCh?.title || "Unknown Channel",
      description: description ?? existingCh?.description ?? "",
      avatarUrl: avatarUrl || existingCh?.avatar_url || null,
      observedSubscribers: finalObservedSubscribers,
      observedTotalViews: finalObservedTotalViews,
      observedVideoCount: finalObservedVideoCount,
      observedChannelCountry: finalObservedChannelCountry,
      observedJoinedAt: finalObservedJoinedAt,
      observedContentLanguage: finalObservedLanguage,
      isKidsContent:
        typeof isKidsContent === "boolean"
          ? isKidsContent
          : existingCh?.is_kids_content !== null && existingCh?.is_kids_content !== undefined
            ? Boolean(existingCh.is_kids_content)
            : null,
      discoveryMarket: discoveryMarket || {
        countryCode: existingCh?.discovery_country || null,
        languageCode: existingCh?.discovery_lang || null,
        seedKeyword: existingCh?.discovery_keyword || null
      },
      videos: allMergedVideos,
      minOutlierSampleSize: effectiveMinSampleSize,
      dataOrigin: finalOrigin,
      collectedAt
    });

    const createdAt = existingCh?.created_at || collectedAt;
    const isTracked = existingCh ? existingCh.is_tracked : 0;
    const lastEnrichedAt =
      observedSubscribers !== null || observedTotalViews !== null || observedChannelCountry !== null
        ? collectedAt
        : existingCh?.last_enriched_at || null;

    db.prepare(`
      INSERT INTO channels (
        id, handle, title, description, avatar_url, data_origin,
        discovery_country, discovery_lang, discovery_keyword,
        channel_country, channel_country_status,
        content_language, content_language_status,
        niche, niche_status, format, format_status, content_type,
        is_faceless, faceless_label, faceless_status, faceless_reason, faceless_signals_json,
        is_ai_content, ai_label, ai_status, ai_signals_json,
        is_monetized, monetization_status, monetization_reason, is_kids_content,
        subscribers, subscribers_status, total_views, total_views_status,
        video_count, video_count_status, observed_video_sample_count,
        avg_views, median_views, avg_duration_minutes, upload_frequency_per_month,
        channel_joined_at, channel_age_months, channel_age_status, channel_age_reason,
        oldest_observed_video_days,
        estimated_rpm, rpm_status, monthly_views, monthly_views_status,
        monthly_revenue_min, monthly_revenue_max, revenue_status, revenue_assumptions_json,
        max_outlier_score, top_outlier_ratio, outlier_status, outlier_reason,
        baselines_by_format_json, provenance_json,
        is_tracked, created_at, updated_at, last_enriched_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        handle = COALESCE(excluded.handle, channels.handle),
        title = excluded.title,
        description = CASE WHEN excluded.description != '' THEN excluded.description ELSE channels.description END,
        avatar_url = COALESCE(excluded.avatar_url, channels.avatar_url),
        data_origin = excluded.data_origin,
        discovery_country = COALESCE(excluded.discovery_country, channels.discovery_country),
        discovery_lang = COALESCE(excluded.discovery_lang, channels.discovery_lang),
        discovery_keyword = COALESCE(excluded.discovery_keyword, channels.discovery_keyword),
        channel_country = excluded.channel_country,
        channel_country_status = excluded.channel_country_status,
        content_language = excluded.content_language,
        content_language_status = excluded.content_language_status,
        niche = excluded.niche,
        niche_status = excluded.niche_status,
        format = excluded.format,
        format_status = excluded.format_status,
        content_type = excluded.content_type,
        is_faceless = excluded.is_faceless,
        faceless_label = excluded.faceless_label,
        faceless_status = excluded.faceless_status,
        faceless_reason = excluded.faceless_reason,
        faceless_signals_json = excluded.faceless_signals_json,
        is_ai_content = excluded.is_ai_content,
        ai_label = excluded.ai_label,
        ai_status = excluded.ai_status,
        ai_signals_json = excluded.ai_signals_json,
        is_monetized = excluded.is_monetized,
        monetization_status = excluded.monetization_status,
        monetization_reason = excluded.monetization_reason,
        is_kids_content = excluded.is_kids_content,
        subscribers = excluded.subscribers,
        subscribers_status = excluded.subscribers_status,
        total_views = excluded.total_views,
        total_views_status = excluded.total_views_status,
        video_count = excluded.video_count,
        video_count_status = excluded.video_count_status,
        observed_video_sample_count = excluded.observed_video_sample_count,
        avg_views = excluded.avg_views,
        median_views = excluded.median_views,
        avg_duration_minutes = excluded.avg_duration_minutes,
        upload_frequency_per_month = excluded.upload_frequency_per_month,
        channel_joined_at = excluded.channel_joined_at,
        channel_age_months = excluded.channel_age_months,
        channel_age_status = excluded.channel_age_status,
        channel_age_reason = excluded.channel_age_reason,
        oldest_observed_video_days = excluded.oldest_observed_video_days,
        estimated_rpm = excluded.estimated_rpm,
        rpm_status = excluded.rpm_status,
        monthly_views = excluded.monthly_views,
        monthly_views_status = excluded.monthly_views_status,
        monthly_revenue_min = excluded.monthly_revenue_min,
        monthly_revenue_max = excluded.monthly_revenue_max,
        revenue_status = excluded.revenue_status,
        revenue_assumptions_json = excluded.revenue_assumptions_json,
        max_outlier_score = excluded.max_outlier_score,
        top_outlier_ratio = excluded.top_outlier_ratio,
        outlier_status = excluded.outlier_status,
        outlier_reason = excluded.outlier_reason,
        baselines_by_format_json = excluded.baselines_by_format_json,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at,
        last_enriched_at = COALESCE(excluded.last_enriched_at, channels.last_enriched_at)
    `).run(
      honest.id,
      honest.handle,
      honest.title,
      honest.description,
      honest.avatarUrl,
      honest.dataOrigin,
      discoveryMarket?.countryCode || existingCh?.discovery_country || null,
      discoveryMarket?.languageCode || existingCh?.discovery_lang || null,
      discoveryMarket?.seedKeyword || existingCh?.discovery_keyword || null,
      honest.channelCountry,
      honest.channelCountryStatus,
      honest.contentLanguage,
      honest.contentLanguageStatus,
      honest.niche,
      honest.nicheStatus,
      honest.format,
      honest.formatStatus,
      honest.contentType,
      honest.isFaceless === null ? null : honest.isFaceless ? 1 : 0,
      honest.facelessLabel,
      honest.facelessStatus,
      honest.facelessReason,
      JSON.stringify(honest.facelessSignals || []),
      honest.isAiContent === null ? null : honest.isAiContent ? 1 : 0,
      honest.aiLabel,
      honest.aiStatus,
      JSON.stringify(honest.aiSignals || []),
      null,
      honest.monetizationStatus,
      honest.monetizationReason,
      honest.isKidsContent === null ? null : honest.isKidsContent ? 1 : 0,
      honest.subscribers,
      honest.subscribersStatus,
      honest.totalViews,
      honest.totalViewsStatus,
      honest.videoCount,
      honest.videoCountStatus,
      honest.observedVideoSampleCount,
      honest.avgViews,
      honest.medianViews,
      honest.avgDurationMinutes,
      honest.uploadFrequencyPerMonth,
      honest.channelJoinedAt,
      honest.channelAgeMonths,
      honest.channelAgeStatus,
      honest.channelAgeReason,
      honest.oldestObservedVideoDays,
      honest.estimatedRpm,
      honest.rpmStatus,
      honest.monthlyViews,
      honest.monthlyViewsStatus,
      honest.monthlyRevenueMin,
      honest.monthlyRevenueMax,
      honest.revenueStatus,
      JSON.stringify(honest.revenueAssumptions || {}),
      honest.maxOutlierScore,
      honest.topOutlierRatio,
      honest.outlierStatus,
      honest.outlierReason,
      JSON.stringify(honest.baselinesByFormat || {}),
      JSON.stringify(honest.provenance || {}),
      isTracked,
      createdAt,
      collectedAt,
      lastEnrichedAt
    );

    const upsertVideoStmt = db.prepare(`
      INSERT INTO videos (
        video_id, channel_id, title, description, thumbnail_url, canonical_url,
        content_type, views, views_status, views_is_rounded, likes, comments,
        duration_seconds, duration_minutes, published_at, published_days_ago, published_status,
        views_per_day, outlier_ratio, outlier_score, outlier_status, outlier_reason,
        baseline_median_views, baseline_sample_size, age_skew_warning,
        estimated_revenue, estimated_revenue_status, data_origin, source,
        collected_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(video_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        title = excluded.title,
        description = excluded.description,
        thumbnail_url = COALESCE(excluded.thumbnail_url, videos.thumbnail_url),
        canonical_url = COALESCE(excluded.canonical_url, videos.canonical_url),
        content_type = excluded.content_type,
        views = excluded.views,
        views_status = excluded.views_status,
        views_is_rounded = excluded.views_is_rounded,
        likes = excluded.likes,
        comments = excluded.comments,
        duration_seconds = excluded.duration_seconds,
        duration_minutes = excluded.duration_minutes,
        published_at = excluded.published_at,
        published_days_ago = excluded.published_days_ago,
        published_status = excluded.published_status,
        views_per_day = excluded.views_per_day,
        outlier_ratio = excluded.outlier_ratio,
        outlier_score = excluded.outlier_score,
        outlier_status = excluded.outlier_status,
        outlier_reason = excluded.outlier_reason,
        baseline_median_views = excluded.baseline_median_views,
        baseline_sample_size = excluded.baseline_sample_size,
        age_skew_warning = excluded.age_skew_warning,
        estimated_revenue = excluded.estimated_revenue,
        estimated_revenue_status = excluded.estimated_revenue_status,
        data_origin = excluded.data_origin,
        source = excluded.source,
        collected_at = excluded.collected_at,
        updated_at = excluded.updated_at
    `);

    for (const v of honest.videos) {
      upsertVideoStmt.run(
        v.videoId,
        honest.id,
        v.title,
        v.description || "",
        v.thumbnailUrl,
        v.canonicalUrl || `https://www.youtube.com/watch?v=${v.videoId}`,
        v.contentType || "unknown",
        v.views,
        v.views !== null ? v.viewsStatus || "observed" : v.viewsStatus || "unknown",
        v.viewsIsRounded ? 1 : 0,
        v.likes,
        v.comments,
        v.durationSeconds ?? (v.durationMinutes ? Math.round(v.durationMinutes * 60) : null),
        v.durationMinutes,
        v.publishedAt || null,
        v.publishedDaysAgo,
        v.publishedDaysAgo !== null ? v.publishedStatus || "derived" : "unknown",
        v.viewsPerDay,
        v.outlierRatio,
        v.outlierScore,
        v.outlierStatus,
        v.outlierReason,
        v.baselineMedianViews,
        v.baselineSampleSize,
        v.ageSkewWarning,
        v.estimatedRevenue,
        v.estimatedRevenueStatus,
        v.dataOrigin || honest.dataOrigin,
        v.source || honest.dataOrigin,
        v.collectedAt || collectedAt,
        collectedAt
      );
    }

    // Record discovery provenance if provided
    if (discoveryMarket?.countryCode && discoveryMarket?.seedKeyword) {
      db.prepare(`
        INSERT INTO discovery_records (
          channel_id, video_id, market_code, language_code, seed_keyword, source, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, market_code, seed_keyword) DO UPDATE SET
          discovered_at = excluded.discovered_at
      `).run(
        honest.id,
        honest.videos[0]?.videoId || null,
        discoveryMarket.countryCode,
        discoveryMarket.languageCode || "en",
        discoveryMarket.seedKeyword,
        discoveryMarket.source || honest.dataOrigin,
        collectedAt
      );
    }

    // T05: Record real timestamped snapshot ONLY for verified observed metrics (never reduce all-null views to 0!)
    if (recordSnapshot && honest.dataOrigin === "observed") {
      const validObservedVideos = honest.videos.filter(
        (v) =>
          typeof v.views === "number" &&
          Number.isFinite(v.views) &&
          v.views >= 0 &&
          v.viewsStatus === "observed" &&
          v.dataOrigin === "observed"
      );

      const hasChannelTotalViews =
        typeof honest.totalViews === "number" &&
        Number.isFinite(honest.totalViews) &&
        honest.totalViewsStatus === "observed";
      const hasObservedSubs =
        typeof honest.subscribers === "number" &&
        Number.isFinite(honest.subscribers) &&
        honest.subscribersStatus === "observed";

      if (hasChannelTotalViews) {
        db.prepare(`
          INSERT INTO metric_snapshots (
            entity_type, entity_id, channel_id, views, subscribers, video_count,
            source, note, scope, cohort_hash, coverage_count, collected_at
          ) VALUES ('channel', ?, ?, ?, ?, ?, 'channel_total_views', 'Channel total views snapshot', 'channel_total_views', 'channel_total', ?, ?)
        `).run(
          honest.id,
          honest.id,
          honest.totalViews,
          hasObservedSubs ? honest.subscribers : null,
          honest.videoCount ?? validObservedVideos.length,
          honest.videoCount ?? validObservedVideos.length,
          collectedAt
        );
      } else if (validObservedVideos.length > 0) {
        const sumObservedVideoViews = validObservedVideos.reduce((acc, v) => acc + v.views, 0);
        const cohortHash = validObservedVideos
          .map((v) => v.videoId)
          .sort()
          .join(",");
        db.prepare(`
          INSERT INTO metric_snapshots (
            entity_type, entity_id, channel_id, views, subscribers, video_count,
            source, note, scope, cohort_hash, coverage_count, collected_at
          ) VALUES ('channel', ?, ?, ?, ?, ?, 'observed_video_subset', ?, 'observed_video_subset', ?, ?, ?)
        `).run(
          honest.id,
          honest.id,
          sumObservedVideoViews,
          hasObservedSubs ? honest.subscribers : null,
          honest.videoCount ?? validObservedVideos.length,
          `Sum of ${validObservedVideos.length} observed videos`,
          cohortHash,
          validObservedVideos.length,
          collectedAt
        );
      } else if (hasObservedSubs) {
        db.prepare(`
          INSERT INTO metric_snapshots (
            entity_type, entity_id, channel_id, views, subscribers, video_count,
            source, note, scope, cohort_hash, coverage_count, collected_at
          ) VALUES ('channel', ?, ?, NULL, ?, ?, 'subscribers_only', 'Subscribers only snapshot', 'subscribers_only', '', 0, ?)
        `).run(
          honest.id,
          honest.id,
          honest.subscribers,
          honest.videoCount ?? 0,
          collectedAt
        );
      }

      // Record per-video observed snapshots so cohort-intersection growth delta works honestly across crawls
      if (validObservedVideos.length > 0) {
        const insertVideoSnap = db.prepare(`
          INSERT INTO metric_snapshots (
            entity_type, entity_id, channel_id, views, subscribers, video_count,
            source, note, scope, cohort_hash, coverage_count, collected_at
          ) VALUES ('video', ?, ?, ?, NULL, NULL, 'video_observed_views', 'Per-video observed views', 'video_observed_views', ?, 1, ?)
        `);
        for (const v of validObservedVideos) {
          insertVideoSnap.run(
            v.videoId,
            honest.id,
            v.views,
            v.videoId,
            v.collectedAt || collectedAt
          );
        }
      }
    }

    return honest;
  });
}

/**
 * T07: Recomputes all channel & video outlier baselines when minOutlierSampleSize changes.
 */
export function recomputeAllChannelOutliers(
  db = getSqliteDb(),
  minOutlierSampleSize = DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
) {
  const effectiveMin = Math.max(
    3,
    Number.isFinite(Number(minOutlierSampleSize))
      ? Math.round(Number(minOutlierSampleSize))
      : DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
  );
  const now = new Date().toISOString();

  return withTransaction(db, () => {
    const channels = db.prepare("SELECT * FROM channels").all();
    const updateChStmt = db.prepare(`
      UPDATE channels SET
        max_outlier_score = ?,
        top_outlier_ratio = ?,
        outlier_status = ?,
        outlier_reason = ?,
        baselines_by_format_json = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const updateVidStmt = db.prepare(`
      UPDATE videos SET
        content_type = ?,
        published_days_ago = ?,
        views_per_day = ?,
        outlier_ratio = ?,
        outlier_score = ?,
        outlier_status = ?,
        outlier_reason = ?,
        baseline_median_views = ?,
        baseline_sample_size = ?,
        age_skew_warning = ?,
        updated_at = ?
      WHERE video_id = ?
    `);

    for (const ch of channels) {
      const videoRows = db
        .prepare("SELECT * FROM videos WHERE channel_id = ?")
        .all(ch.id);
      const rawVideos = videoRows.map((r) => ({
        videoId: r.video_id,
        title: r.title,
        description: r.description,
        thumbnailUrl: r.thumbnail_url,
        canonicalUrl: r.canonical_url,
        contentType: r.content_type !== "unknown" ? r.content_type : null,
        views: r.views,
        viewsStatus: r.views_status,
        viewsIsRounded: Boolean(r.views_is_rounded),
        likes: r.likes,
        comments: r.comments,
        durationSeconds: r.duration_seconds,
        durationMinutes: r.duration_minutes,
        publishedAt: r.published_at,
        publishedDaysAgo: r.published_days_ago,
        publishedStatus: r.published_status,
        dataOrigin: r.data_origin,
        source: r.source,
        collectedAt: r.collected_at
      }));

      const evaluated = evaluateChannelVideosOutliers(rawVideos, {
        minSampleSize: effectiveMin,
        estimatedRpm: ch.estimated_rpm,
        channelOrigin: ch.data_origin
      });

      updateChStmt.run(
        evaluated.maxOutlierScore,
        evaluated.topOutlierRatio,
        evaluated.outlierStatus,
        evaluated.outlierReason,
        JSON.stringify(evaluated.baselinesByFormat || {}),
        now,
        ch.id
      );

      for (const v of evaluated.videos) {
        updateVidStmt.run(
          v.contentType || "unknown",
          v.publishedDaysAgo,
          v.viewsPerDay,
          v.outlierRatio,
          v.outlierScore,
          v.outlierStatus,
          v.outlierReason,
          v.baselineMedianViews,
          v.baselineSampleSize,
          v.ageSkewWarning,
          now,
          v.videoId
        );
      }
    }

    return { recomputedChannels: channels.length, minOutlierSampleSize: effectiveMin };
  });
}

// ============================================================================
// IDEMPOTENT MIGRATION FROM LEGACY JSON TO SQLITE WITH BACKUP & RECONCILIATION
// ============================================================================

export function applyV21ReviewFixesMigration(db) {
  const migrationVersion = "v2.1-review-fixes";
  const alreadyApplied = db
    .prepare("SELECT * FROM schema_migrations WHERE version = ?")
    .get(migrationVersion);
  if (alreadyApplied) return;

  const now = new Date().toISOString();
  withTransaction(db, () => {
    // 1. Clean legacy_unverified & demo channels/videos so they never claim 'derived' outlier status
    db.exec(`
      UPDATE videos SET
        outlier_ratio = NULL,
        outlier_score = NULL,
        outlier_status = 'unverified_source',
        outlier_reason = 'Dữ liệu legacy chưa xác minh nguồn thu thập, không dùng làm baseline outlier.',
        baseline_median_views = NULL,
        baseline_sample_size = 0
      WHERE data_origin = 'legacy_unverified' OR views_status = 'legacy_unverified';

      UPDATE channels SET
        top_outlier_ratio = NULL,
        max_outlier_score = NULL,
        outlier_status = 'unverified_source',
        outlier_reason = 'Kênh từ dữ liệu legacy chưa xác minh nguồn thu thập, không tính outlier.',
        baselines_by_format_json = '{}'
      WHERE data_origin = 'legacy_unverified';

      UPDATE videos SET
        outlier_ratio = NULL,
        outlier_score = NULL,
        outlier_status = 'demo',
        outlier_reason = 'Dữ liệu demo minh họa, không tính vào nghiên cứu thật.',
        baseline_median_views = NULL,
        baseline_sample_size = 0
      WHERE data_origin = 'demo' OR views_status = 'demo';

      UPDATE channels SET
        top_outlier_ratio = NULL,
        max_outlier_score = NULL,
        outlier_status = 'demo',
        outlier_reason = 'Kênh demo minh họa, không tính vào nghiên cứu thật.',
        baselines_by_format_json = '{}'
      WHERE data_origin = 'demo';
    `);

    // 2. Mark seeded demo swipe items as data_origin = 'demo' so they don't pollute real workspace by default
    for (const demoSwipeId of DEMO_SWIPE_IDS) {
      db.prepare(`
        UPDATE swipe_items SET
          data_origin = 'demo',
          metrics_source_status = 'demo'
        WHERE id = ?
      `).run(demoSwipeId);
    }

    // 3. Delete bogus 0-view snapshots created when all video views were null
    db.exec(`
      DELETE FROM metric_snapshots
      WHERE entity_type = 'channel' AND views = 0 AND source = 'observed_videos_sum';
    `);

    // 4. Enforce minOutlierSampleSize >= 3
    const currentMinSample = getAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE);
    if (typeof currentMinSample !== "number" || currentMinSample < 3) {
      setAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE);
    }

    db.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at, reconciliation_json)
      VALUES (?, ?, ?)
    `).run(migrationVersion, now, JSON.stringify({ appliedAt: now }));
  });
}

export function migrateLegacyJsonToSqlite(db = getSqliteDb(), jsonPath = LEGACY_JSON_PATH) {
  const migrationVersion = "v2.0-honest-sqlite";
  const alreadyApplied = db
    .prepare("SELECT * FROM schema_migrations WHERE version = ?")
    .get(migrationVersion);

  if (alreadyApplied) {
    return {
      alreadyMigrated: true,
      version: migrationVersion,
      reconciliation: JSON.parse(alreadyApplied.reconciliation_json || "{}")
    };
  }

  let legacyData = null;
  let backupFilePath = null;

  if (fs.existsSync(jsonPath)) {
    try {
      const raw = fs.readFileSync(jsonPath, "utf8");
      legacyData = JSON.parse(raw);

      // 1. Create safe timestamped backup before migrating
      const backupDir = path.resolve(path.dirname(jsonPath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      backupFilePath = path.resolve(
        backupDir,
        `nexlev-db.backup.${new Date().toISOString().replace(/[:.]/g, "-")}.json`
      );
      fs.writeFileSync(backupFilePath, raw, "utf8");

      // 2. If legacy JSON had API keys in settings, move them into gitignored .secrets.local.json
      // and scrub them from the JSON file on disk so secrets are never committed to Git!
      if (legacyData.settings?.youtubeApiKey || legacyData.settings?.geminiApiKey) {
        updateSecrets({
          youtubeApiKeyAction: legacyData.settings.youtubeApiKey ? "replace" : "keep",
          youtubeApiKey: legacyData.settings.youtubeApiKey || "",
          geminiApiKeyAction: legacyData.settings.geminiApiKey ? "replace" : "keep",
          geminiApiKey: legacyData.settings.geminiApiKey || ""
        });
        legacyData.settings.youtubeApiKey = "";
        legacyData.settings.geminiApiKey = "";
        fs.writeFileSync(jsonPath, JSON.stringify(legacyData, null, 2), "utf8");
      }
    } catch {
      legacyData = null;
    }
  }

  const now = new Date().toISOString();
  let migratedDemoChannels = 0;
  let migratedLegacyChannels = 0;
  let migratedSwipeItems = 0;
  let migratedFolders = 0;
  let migratedTemplates = 0;

  // Migrate channels & videos
  const sourceChannels = legacyData?.channels || SEED_CHANNELS;
  const trackedSet = new Set(legacyData?.trackedChannelIds || []);

  for (const ch of sourceChannels) {
    if (!ch || !ch.id) continue;
    const isDemo = DEMO_CHANNEL_IDS.has(ch.id) || ch.dataOrigin === "demo";
    const origin = isDemo ? "demo" : "legacy_unverified";

    // For legacy_unverified channels, strip fabricated channel-level stats
    // (subscribers, totalViews, videoCount=26, channelAgeMonths=5.5, isMonetized=true, hourly48hSeries)
    const cleanVideos = (ch.videos || []).map((v) => ({
      videoId: v.videoId || v.video_id,
      title: v.title || "",
      thumbnailUrl: v.thumbnailUrl,
      views: typeof v.views === "number" ? v.views : null,
      viewsStatus: isDemo ? "demo" : "legacy_unverified",
      viewsIsRounded: true,
      // Legacy likes/comments were fabricated as 3.9% and 0.26% of views; strip them for legacy_unverified!
      likes: isDemo ? v.likes : null,
      comments: isDemo ? v.comments : null,
      durationMinutes: typeof v.durationMinutes === "number" ? v.durationMinutes : null,
      publishedDaysAgo:
        typeof v.publishedDaysAgo === "number" && v.publishedDaysAgo !== 12 && v.publishedDaysAgo !== 14
          ? v.publishedDaysAgo
          : isDemo
            ? v.publishedDaysAgo
            : null,
      publishedStatus: isDemo ? "demo" : "legacy_unverified",
      dataOrigin: origin,
      source: origin,
      collectedAt: ch.lastUpdatedAt || now
    }));

    upsertChannelAndVideos(db, {
      channelId: ch.id,
      handle: ch.handle || null,
      title: ch.title || "Unknown Channel",
      description: ch.description || "",
      avatarUrl: ch.avatarUrl || null,
      // Only keep channel-level stats if demo fixture (marked as 'demo'); for legacy_unverified set null!
      observedSubscribers: isDemo ? ch.subscribers : null,
      observedTotalViews: isDemo ? ch.totalViews : null,
      observedVideoCount: isDemo ? ch.videoCount : null,
      observedChannelCountry: isDemo ? ch.country : null,
      observedJoinedAt: null,
      observedContentLanguage: isDemo ? ch.language : null,
      isKidsContent: null,
      discoveryMarket: {
        countryCode: ch.country || "US",
        languageCode: ch.language || "en",
        seedKeyword: ch.discoveredViaKeyword || "legacy_seed",
        source: origin
      },
      videos: cleanVideos,
      dataOrigin: origin,
      recordSnapshot: false,
      collectedAt: ch.lastUpdatedAt || now
    });

    if (trackedSet.has(ch.id)) {
      db.prepare("UPDATE channels SET is_tracked = 1 WHERE id = ?").run(ch.id);
    }

    if (isDemo) migratedDemoChannels += 1;
    else migratedLegacyChannels += 1;
  }

  // Migrate Swipe Folders, Swipe Items & Filter Templates inside a single transaction
  withTransaction(db, () => {
    const folders = legacyData?.swipeFolders?.length
      ? legacyData.swipeFolders
      : INITIAL_SWIPE_FOLDERS;
    const folderStmt = db.prepare(`
      INSERT INTO swipe_folders (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description
    `);
    for (const f of folders) {
      folderStmt.run(f.id, f.name, f.description || "", now);
      migratedFolders += 1;
    }

    const swipeItems = legacyData?.swipeItems?.length
      ? legacyData.swipeItems
      : INITIAL_SWIPE_ITEMS;
    const itemStmt = db.prepare(`
      INSERT INTO swipe_items (
        id, folder_id, type, video_id, channel_id, canonical_url,
        title, channel_title, channel_handle, thumbnail_url,
        outlier_ratio, views, estimated_rpm,
        workflow_stage, owner_label, published_video_url, brief_markdown,
        tags_json, notes, source, data_origin, metrics_source_status, saved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        notes = CASE WHEN swipe_items.notes != '' THEN swipe_items.notes ELSE excluded.notes END,
        tags_json = excluded.tags_json,
        data_origin = excluded.data_origin,
        metrics_source_status = excluded.metrics_source_status,
        updated_at = excluded.updated_at
    `);
    for (const item of swipeItems) {
      const isDemoItem =
        DEMO_SWIPE_IDS.has(item.id) ||
        (item.channelId && DEMO_CHANNEL_IDS.has(item.channelId)) ||
        item.dataOrigin === "demo";
      const itemOrigin = isDemoItem ? "demo" : item.dataOrigin || "legacy_unverified";
      itemStmt.run(
        item.id,
        item.folderId || "folder-outliers",
        item.type || "video",
        item.videoId || null,
        item.channelId || null,
        item.canonicalUrl || null,
        item.title || "Untitled",
        item.channelTitle || "",
        item.channelHandle || "",
        item.thumbnailUrl || "",
        isDemoItem ? null : typeof item.outlierRatio === "number" ? item.outlierRatio : null,
        typeof item.views === "number" ? item.views : null,
        typeof item.estimatedRpm === "number" ? item.estimatedRpm : null,
        item.workflowStage || "discovered",
        item.ownerLabel || "",
        item.publishedVideoUrl || "",
        item.briefMarkdown || "",
        JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
        item.notes || "",
        item.source || (isDemoItem ? "demo_seed" : "legacy_migrated"),
        itemOrigin,
        itemOrigin,
        item.savedAt || now,
        now
      );
      migratedSwipeItems += 1;
    }

    const templates = legacyData?.filterTemplates?.length
      ? legacyData.filterTemplates
      : INITIAL_FILTER_TEMPLATES;
    const tplStmt = db.prepare(`
      INSERT INTO filter_templates (id, name, description, filters_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        filters_json = excluded.filters_json
    `);
    for (const tpl of templates) {
      tplStmt.run(
        tpl.id,
        tpl.name,
        tpl.description || "",
        JSON.stringify(tpl.filters || {}),
        now
      );
      migratedTemplates += 1;
    }

    // Default app settings (Demo mode OFF by default so demo channels don't pollute real research!)
    if (getAppSetting(db, "includeDemo") === null) {
      setAppSetting(db, "includeDemo", false);
    }
    if (getAppSetting(db, "minOutlierSampleSize") === null) {
      setAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE);
    }
    if (getAppSetting(db, "crawlerSchedule") === null) {
      setAppSetting(db, "crawlerSchedule", {
        autoScheduleEnabled: false,
        intervalMinutes: 15
      });
    }

    const totalChannelsSqlite = db.prepare("SELECT COUNT(*) AS c FROM channels").get().c;
    const totalVideosSqlite = db.prepare("SELECT COUNT(*) AS c FROM videos").get().c;

    const reconciliation = {
      migratedAt: now,
      backupFilePath,
      migratedDemoChannels,
      migratedLegacyChannels,
      totalChannelsSqlite,
      totalVideosSqlite,
      migratedSwipeItems,
      migratedFolders,
      migratedTemplates
    };

    db.prepare(`
      INSERT INTO schema_migrations (version, applied_at, reconciliation_json)
      VALUES (?, ?, ?)
    `).run(migrationVersion, now, JSON.stringify(reconciliation));

    return {
      alreadyMigrated: false,
      version: migrationVersion,
      reconciliation
    };
  });

  const applied = db
    .prepare("SELECT reconciliation_json FROM schema_migrations WHERE version = ?")
    .get(migrationVersion);
  return {
    alreadyMigrated: false,
    version: migrationVersion,
    reconciliation: JSON.parse(applied?.reconciliation_json || "{}")
  };
}
