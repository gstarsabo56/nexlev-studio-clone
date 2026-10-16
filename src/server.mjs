// Internal Company Web API Server (v2.1 Review & Redesign Remediation)
// Loopback-bound by default, CORS allowlist, Strict Session/Token Auth by default (T01),
// Server-Enforced RBAC & Transition Policy (T02), Optimistic Concurrency (T08),
// Honest Cohort Growth & Unclamped Exports (T05, T09), and No Import Side Effects (T19).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureDbMigrated,
  queryChannels,
  queryOutlierVideos,
  getChannelDetail,
  getChannelGrowthTracking,
  toggleChannelWatchlist,
  setChannelWatchlistState,
  getVideoTranscriptLive,
  generateVideoProductionOutline,
  auditThumbnailAndTitle,
  estimateChannelRpmAndRevenue,
  classifyFacelessAndNiche,
  getSwipeData,
  createSwipeItem,
  updateSwipeItem,
  transitionSwipeItem,
  deleteSwipeItem,
  generateSwipeProductionBrief,
  bulkImportTargets,
  getImportTargets,
  exportShortlist,
  getBatchExtensionMetrics,
  getPublicSettings,
  saveSettingsAndSecrets,
  authenticateUser,
  revokeUserSession,
  resolveUserFromToken,
  listTeamUsers,
  createTeamUser,
  updateTeamUser,
  rotateUserApiToken,
  getPersonalApiTokenForUser,
  getUserCapabilities,
  maskApiToken,
  SWIPE_WORKFLOW_STAGES,
  SWIPE_WORKFLOW_STAGE_LABELS,
  WORKFLOW_TRANSITION_POLICY
} from "./core/engine.mjs";
import { NICHE_CPM_TABLE } from "./core/seed-data.mjs";
import {
  GLOBAL_COUNTRIES,
  crawlerState,
  crawlMultiCountryBatch,
  scanYouTubeNicheLive,
  updateCrawlerSchedule,
  cancelCrawlJob,
  getCrawlerHealth,
  recoverInterruptedCrawlJobs,
  syncScheduleFromDb
} from "./core/crawler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
export const PORT = Number(process.env.PORT || 3088);
export const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 1_048_576; // 1 MB limit

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (
    origin === `http://localhost:${PORT}` ||
    origin === `http://127.0.0.1:${PORT}` ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("chrome-extension://")
  ) {
    return origin;
  }
  const extra = (process.env.NEXLEV_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return origin;
  return null;
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  const allowedOrigin = getAllowedOrigin(req);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
    ...extraHeaders
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "Content-Type, Authorization, x-nexlev-token, x-api-key";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

/**
  * Strictly parses JSON request bodies with a 1MB size limit.
  * Malformed JSON throws an error with statusCode = 400 (never silently returns {}).
  */
function readJsonBodyStrict(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let byteCount = 0;

    req.on("data", (chunk) => {
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        const err = new Error("Payload vượt quá giới hạn 1MB.");
        err.statusCode = 413;
        err.code = "PAYLOAD_TOO_LARGE";
        req.destroy();
        reject(err);
        return;
      }
      raw += chunk.toString("utf8");
    });

    req.on("end", () => {
      const trimmed = raw.trim();
      if (!trimmed) return resolve({});
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          const err = new Error("Body JSON phải là một object hợp lệ.");
          err.statusCode = 400;
          err.code = "INVALID_JSON_OBJECT";
          return reject(err);
        }
        resolve(parsed);
      } catch {
        const err = new Error("JSON sai định dạng (Malformed JSON).");
        err.statusCode = 400;
        err.code = "INVALID_JSON";
        reject(err);
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      out[k] = v;
    }
  }
  return out;
}

function extractTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (req.headers["x-nexlev-token"]) {
    return String(req.headers["x-nexlev-token"]).trim();
  }
  if (req.headers["x-api-key"]) {
    return String(req.headers["x-api-key"]).trim();
  }
  const cookies = parseCookies(req);
  if (cookies.nexlev_session) {
    return cookies.nexlev_session;
  }
  return null;
}

function isLoopbackAddress(addr = "") {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr === "localhost"
  );
}

/**
 * Resolves the authenticated user for API requests (T01).
 * Strict authentication is enforced by default on all protected /api/* routes.
 * Unauthenticated requests return 401 AUTH_REQUIRED unless NEXLEV_DEV_AUTH_BYPASS === "true"
 * is explicitly set on a loopback socket.
 */
function authenticateRequest(req, db) {
  const origin = req.headers.origin;
  if (origin && !getAllowedOrigin(req)) {
    const err = new Error("Origin không được phép truy cập API.");
    err.statusCode = 403;
    err.code = "FORBIDDEN_ORIGIN";
    throw err;
  }

  const explicitToken = extractTokenFromRequest(req);
  if (explicitToken) {
    const user = resolveUserFromToken(db, explicitToken);
    if (!user) {
      const err = new Error("Phiên đăng nhập hoặc API token không hợp lệ hoặc đã hết hạn.");
      err.statusCode = 401;
      err.code = "UNAUTHORIZED";
      throw err;
    }
    return user;
  }

  // Strict auth by default (T01): only allow bypass if NEXLEV_DEV_AUTH_BYPASS === "true"
  if (
    process.env.NEXLEV_DEV_AUTH_BYPASS === "true" &&
    process.env.NEXLEV_STRICT_AUTH !== "true" &&
    isLoopbackAddress(req.socket?.remoteAddress)
  ) {
    const defaultAdmin = db
      .prepare(
        "SELECT * FROM users WHERE role = 'manager' AND is_active = 1 ORDER BY created_at ASC LIMIT 1"
      )
      .get();
    if (defaultAdmin) {
      return {
        id: defaultAdmin.id,
        username: defaultAdmin.username,
        displayName: defaultAdmin.display_name,
        role: defaultAdmin.role,
        hasApiToken: Boolean(defaultAdmin.api_token),
        apiTokenPreview: maskApiToken(defaultAdmin.api_token),
        capabilities: getUserCapabilities(defaultAdmin.role)
      };
    }
  }

  const err = new Error("Yêu cầu đăng nhập (Missing authentication token).");
  err.statusCode = 401;
  err.code = "AUTH_REQUIRED";
  throw err;
}

function requireManagerRole(user) {
  if (!user || user.role !== "manager") {
    const err = new Error(
      "Quyền truy cập bị từ chối: Thao tác này yêu cầu quyền Quản lý (Manager)."
    );
    err.statusCode = 403;
    err.code = "FORBIDDEN_ROLE";
    throw err;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export async function handleHttpRequest(req, res, customDb = null) {
  if (req.method === "OPTIONS") {
    if (req.headers.origin && !getAllowedOrigin(req)) {
      return sendJson(req, res, 403, { error: "Origin not allowed" });
    }
    return sendJson(req, res, 200, { ok: true });
  }

  const urlObj = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams.entries());
  const db = ensureDbMigrated(customDb);

  try {
    // ========================================================================
    // PUBLIC HEALTH & AUTHENTICATION ENDPOINTS
    // ========================================================================

    if ((pathname === "/api/v1/health" || pathname === "/api/health") && req.method === "GET") {
      return sendJson(req, res, 200, {
        ok: true,
        status: "healthy",
        version: "2.1.0",
        sqliteMode: "WAL"
      });
    }

    if (pathname === "/api/v1/auth/login" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const authResult = authenticateUser(db, body.username, body.password);
      if (!authResult) {
        return sendJson(req, res, 401, {
          ok: false,
          error: "Sai tên đăng nhập hoặc mật khẩu.",
          code: "INVALID_CREDENTIALS"
        });
      }
      const cookieHeader = `nexlev_session=${encodeURIComponent(
        authResult.sessionToken
      )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}`;
      return sendJson(
        req,
        res,
        200,
        {
          ok: true,
          sessionToken: authResult.sessionToken,
          expiresAt: authResult.expiresAt,
          user: authResult.user
        },
        { "Set-Cookie": cookieHeader }
      );
    }

    if (pathname === "/api/v1/auth/logout" && req.method === "POST") {
      const token = extractTokenFromRequest(req);
      if (token) revokeUserSession(db, token);
      return sendJson(
        req,
        res,
        200,
        { ok: true },
        { "Set-Cookie": "nexlev_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" }
      );
    }

    // All other /api/* routes require valid authentication (T01)
    let currentUser = null;
    if (pathname.startsWith("/api/")) {
      currentUser = authenticateRequest(req, db);
    }

    // ========================================================================
    // AUTHENTICATED SESSION, PERSONAL TOKEN & TEAM USER MANAGEMENT (T01, T13)
    // ========================================================================

    if (pathname === "/api/v1/auth/me" && req.method === "GET") {
      return sendJson(req, res, 200, {
        ok: true,
        user: currentUser,
        teamUsers: listTeamUsers(db)
      });
    }

    if (pathname === "/api/v1/auth/bootstrap" && req.method === "GET") {
      // Never leak raw apiTokens for team accounts (T01)
      return sendJson(req, res, 200, {
        ok: true,
        user: currentUser,
        teamUsers: listTeamUsers(db)
      });
    }

    if (pathname === "/api/v1/auth/token" && req.method === "GET") {
      const personalToken = getPersonalApiTokenForUser(db, currentUser.id);
      return sendJson(req, res, 200, {
        ok: true,
        apiToken: personalToken,
        apiTokenPreview: maskApiToken(personalToken)
      });
    }

    if (pathname === "/api/v1/auth/token/rotate" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const targetUserId =
        body.userId && currentUser.role === "manager" ? String(body.userId) : currentUser.id;
      if (targetUserId !== currentUser.id) {
        requireManagerRole(currentUser);
      }
      const rotated = rotateUserApiToken(db, targetUserId);
      return sendJson(req, res, 200, {
        ok: true,
        ...rotated
      });
    }

    if (pathname === "/api/v1/users" && req.method === "GET") {
      return sendJson(req, res, 200, {
        users: listTeamUsers(db)
      });
    }

    if (pathname === "/api/v1/users" && req.method === "POST") {
      requireManagerRole(currentUser);
      const body = await readJsonBodyStrict(req);
      const created = createTeamUser(db, body);
      return sendJson(req, res, 201, { ok: true, user: created });
    }

    if (pathname.startsWith("/api/v1/users/") && req.method === "PUT") {
      requireManagerRole(currentUser);
      const targetUserId = decodeURIComponent(pathname.replace("/api/v1/users/", ""));
      const body = await readJsonBodyStrict(req);
      const updated = updateTeamUser(db, targetUserId, body);
      return sendJson(req, res, 200, { ok: true, user: updated });
    }

    // ========================================================================
    // 1. SUMMARY & SYSTEM METADATA
    // ========================================================================

    if (pathname === "/api/v1/meta" && req.method === "GET") {
      const settings = getPublicSettings(db);
      const includeDemo =
        query.includeDemo !== undefined
          ? query.includeDemo === "true"
          : settings.includeDemo;

      const originCounts = db
        .prepare("SELECT data_origin, COUNT(*) AS c FROM channels GROUP BY data_origin")
        .all();
      const countsByOrigin = { observed: 0, legacy_unverified: 0, demo: 0 };
      for (const r of originCounts) {
        countsByOrigin[r.data_origin] = r.c;
      }

      const activeChannelCount = includeDemo
        ? countsByOrigin.observed + countsByOrigin.legacy_unverified + countsByOrigin.demo
        : countsByOrigin.observed + countsByOrigin.legacy_unverified;

      const marketCountsRows = db
        .prepare(
          `SELECT COALESCE(channel_country, discovery_country, 'US') AS code, COUNT(*) AS c
           FROM channels
           WHERE (? = 1 OR data_origin != 'demo')
           GROUP BY COALESCE(channel_country, discovery_country, 'US')`
        )
        .all(includeDemo ? 1 : 0);
      const countryCounts = {};
      for (const r of marketCountsRows) {
        countryCounts[r.code] = r.c;
      }

      const outlierRes = queryOutlierVideos(
        { includeDemo: includeDemo ? "true" : "false", limit: 1 },
        db
      );
      const trackedCount = db
        .prepare(
          "SELECT COUNT(*) AS c FROM channels WHERE is_tracked = 1 AND (? = 1 OR data_origin != 'demo')"
        )
        .get(includeDemo ? 1 : 0).c;
      const swipeCount = db.prepare("SELECT COUNT(*) AS c FROM swipe_items").get().c;
      const pendingApprovalCount = db
        .prepare("SELECT COUNT(*) AS c FROM swipe_items WHERE workflow_stage = 'discovered'")
        .get().c;
      const activeProductionCount = db
        .prepare(
          "SELECT COUNT(*) AS c FROM swipe_items WHERE workflow_stage IN ('briefing', 'assigned', 'published', 'review')"
        )
        .get().c;

      const filterTemplates = db
        .prepare("SELECT * FROM filter_templates ORDER BY created_at ASC")
        .all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          filters: JSON.parse(r.filters_json || "{}")
        }));

      return sendJson(req, res, 200, {
        totalChannels: activeChannelCount,
        countsByOrigin,
        totalOutliers: outlierRes.totalCount,
        trackedCount,
        swipeCount,
        pendingApprovalCount,
        activeProductionCount,
        includeDemo,
        minOutlierSampleSize: settings.minOutlierSampleSize,
        currentUser,
        teamUsers: listTeamUsers(db),
        workflowStages: SWIPE_WORKFLOW_STAGES,
        workflowStageLabels: SWIPE_WORKFLOW_STAGE_LABELS,
        workflowPolicy: WORKFLOW_TRANSITION_POLICY,
        niches: Object.entries(NICHE_CPM_TABLE).map(([name, meta]) => ({
          name,
          ...meta
        })),
        countries: GLOBAL_COUNTRIES.map((c) => ({
          ...c,
          channelCount: countryCounts[c.code] || 0
        })),
        crawlerState,
        filterTemplates,
        hasYoutubeApiKey: settings.hasYoutubeApiKey,
        hasGeminiApiKey: settings.hasGeminiApiKey
      });
    }

    // ========================================================================
    // 2. CRAWLER HEALTH, JOBS & SCHEDULE
    // ========================================================================

    if (pathname === "/api/v1/crawler/status" && req.method === "GET") {
      return sendJson(req, res, 200, getCrawlerHealth(db));
    }

    if (pathname === "/api/v1/crawler/run" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const countries =
        Array.isArray(body.countries) && body.countries.length
          ? body.countries
          : body.country && body.country !== "ALL"
            ? [body.country]
            : ["ALL"];
      const summary = await crawlMultiCountryBatch(
        {
          countries,
          keywordsPerCountry: Math.min(10, Math.max(1, Number(body.keywordsPerCountry || 2))),
          maxChannelsPerKeyword: Math.min(20, Math.max(1, Number(body.maxChannelsPerKeyword || 5))),
          customKeyword: String(body.customKeyword || "").trim()
        },
        db
      );
      return sendJson(req, res, 200, { ok: true, summary, crawlerState });
    }

    if (pathname === "/api/v1/crawler/cancel" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const result = cancelCrawlJob(body.jobId || null, db);
      return sendJson(req, res, 200, { ok: true, ...result, crawlerState });
    }

    if (pathname === "/api/v1/crawler/schedule" && req.method === "POST") {
      requireManagerRole(currentUser);
      const body = await readJsonBodyStrict(req);
      const nextState = updateCrawlerSchedule(
        {
          autoScheduleEnabled: body.autoScheduleEnabled,
          intervalMinutes: body.intervalMinutes
        },
        db
      );
      return sendJson(req, res, 200, { ok: true, crawlerState: nextState });
    }

    // ========================================================================
    // 3. CHANNELS & NICHE FINDER (Server-Side Filtered & Paginated)
    // ========================================================================

    if (pathname === "/api/v1/channels" && req.method === "GET") {
      const result = queryChannels(query, db);
      return sendJson(req, res, 200, result);
    }

    if (pathname === "/api/v1/niche/scan-live" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const keyword = String(body.keyword || query.keyword || "").trim();
      if (!keyword) {
        return sendJson(req, res, 400, {
          error: "Vui lòng nhập từ khóa (keyword) để quét ngách.",
          code: "MISSING_KEYWORD"
        });
      }
      const country = String(body.country || "US").trim();
      const limit = Math.min(25, Math.max(1, Number(body.limit || 10)));

      if (country === "ALL") {
        const summary = await crawlMultiCountryBatch(
          {
            countries: ["US", "GB", "DE", "JP", "KR", "VN", "ES"],
            keywordsPerCountry: 1,
            maxChannelsPerKeyword: limit,
            customKeyword: keyword
          },
          db
        );
        return sendJson(req, res, 200, {
          jobId: summary.jobId,
          source: "youtube-innertube-multi-country",
          keyword,
          discoveredCount: (summary.newChannelsCount || 0) + (summary.updatedChannelsCount || 0),
          summary
        });
      }

      const scanRes = await scanYouTubeNicheLive(keyword, limit, { country }, db);
      return sendJson(req, res, 200, scanRes);
    }

    if (
      pathname.startsWith("/api/v1/channels/") &&
      pathname.endsWith("/watchlist") &&
      (req.method === "PUT" || req.method === "POST")
    ) {
      const channelId = decodeURIComponent(
        pathname.replace("/api/v1/channels/", "").replace(/\/watchlist$/, "")
      );
      const body = await readJsonBodyStrict(req);
      const result = setChannelWatchlistState(
        channelId,
        {
          isTracked: body.isTracked,
          note: body.note,
          actorUsername: currentUser?.username || "admin"
        },
        db
      );
      return sendJson(req, res, 200, { ok: true, ...result });
    }

    if (pathname.startsWith("/api/v1/channels/") && req.method === "GET") {
      const channelId = decodeURIComponent(pathname.replace("/api/v1/channels/", ""));
      const detail = getChannelDetail(channelId, db);
      if (detail.ambiguous) {
        return sendJson(req, res, 409, detail);
      }
      if (!detail.found) {
        return sendJson(req, res, 404, { error: detail.message || "Channel not found" });
      }
      return sendJson(req, res, 200, detail);
    }

    // ========================================================================
    // 4. OUTLIER VIDEOS RADAR
    // ========================================================================

    if (pathname === "/api/v1/outliers" && req.method === "GET") {
      const result = queryOutlierVideos(query, db);
      return sendJson(req, res, 200, result);
    }

    // ========================================================================
    // 5. SHARED COMPANY WATCHLIST & SNAPSHOT GROWTH TRACKER (T05, T09)
    // ========================================================================

    if (pathname === "/api/v1/tracker" && req.method === "GET") {
      const { channels, totalCount } = queryChannels(
        {
          ...query,
          includeDemo: query.includeDemo || "false",
          trackedOnly: true,
          limit: query.limit || 200
        },
        db
      );
      const tracked = channels.map((c) => ({
        ...c,
        growthTracking: getChannelGrowthTracking(c.id, db)
      }));
      return sendJson(req, res, 200, {
        count: tracked.length,
        totalCount,
        channels: tracked
      });
    }

    if (pathname === "/api/v1/tracker/toggle" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      if (!body.channelId) {
        return sendJson(req, res, 400, { error: "Thiếu channelId", code: "MISSING_CHANNEL_ID" });
      }
      const resToggle = toggleChannelWatchlist(
        body.channelId,
        {
          isTracked: body.isTracked,
          note: body.note,
          actorUsername: currentUser?.username || "admin"
        },
        db
      );
      return sendJson(req, res, 200, resToggle);
    }

    // ========================================================================
    // 6. SHARED IDEA LIBRARY & 6-STAGE TEAM WORKFLOW (T02, T08)
    // ========================================================================

    if (pathname === "/api/v1/swipe" && req.method === "GET") {
      const data = getSwipeData(
        {
          folderId: query.folderId || "all",
          stage: query.stage || "all",
          assignee: query.assignee || "all",
          query: query.query || ""
        },
        db
      );
      return sendJson(req, res, 200, data);
    }

    if (pathname === "/api/v1/swipe" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const item = createSwipeItem(
        {
          ...body,
          createdBy: currentUser?.username || "admin",
          updatedBy: currentUser?.username || "admin"
        },
        db,
        currentUser
      );
      return sendJson(req, res, 201, { ok: true, item });
    }

    if (
      pathname.startsWith("/api/v1/swipe/") &&
      pathname.endsWith("/transition") &&
      req.method === "POST"
    ) {
      const id = decodeURIComponent(
        pathname.replace("/api/v1/swipe/", "").replace(/\/transition$/, "")
      );
      const body = await readJsonBodyStrict(req);
      const updated = transitionSwipeItem(id, body, db, currentUser);
      return sendJson(req, res, 200, { ok: true, item: updated });
    }

    if (
      pathname.startsWith("/api/v1/swipe/") &&
      (pathname.endsWith("/brief") || pathname.endsWith("/generate-brief")) &&
      req.method === "POST"
    ) {
      const id = decodeURIComponent(
        pathname
          .replace("/api/v1/swipe/", "")
          .replace(/\/(generate-)?brief$/, "")
      );
      const body = await readJsonBodyStrict(req);
      const updated = generateSwipeProductionBrief(id, db, {
        overwrite: Boolean(body.overwrite),
        actor: currentUser
      });
      return sendJson(req, res, 200, { ok: true, item: updated });
    }

    if (
      pathname.startsWith("/api/v1/swipe/") &&
      (req.method === "PUT" || req.method === "PATCH")
    ) {
      const id = decodeURIComponent(pathname.replace("/api/v1/swipe/", ""));
      const body = await readJsonBodyStrict(req);
      const updated = updateSwipeItem(
        id,
        {
          ...body,
          updatedBy: currentUser?.username || "admin"
        },
        db,
        currentUser
      );
      return sendJson(req, res, 200, { ok: true, item: updated });
    }

    if (pathname.startsWith("/api/v1/swipe/") && req.method === "DELETE") {
      const id = decodeURIComponent(pathname.replace("/api/v1/swipe/", ""));
      const result = deleteSwipeItem(id, db, currentUser);
      return sendJson(req, res, 200, { ok: true, ...result });
    }

    // ========================================================================
    // 7. BULK IMPORT, SHORTLIST EXPORT & CHROME EXTENSION BATCH METRICS (T09, T10)
    // ========================================================================

    if (pathname === "/api/v1/import/bulk" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const result = bulkImportTargets(body.lines || body.input || [], db, currentUser);
      return sendJson(req, res, 200, { ok: true, ...result });
    }

    if (pathname === "/api/v1/import/targets" && req.method === "GET") {
      const targets = getImportTargets(db, {
        status: query.status || "all",
        limit: Number(query.limit || 100)
      });
      return sendJson(req, res, 200, { ok: true, targets });
    }

    if (pathname === "/api/v1/export" && req.method === "GET") {
      const format = query.format === "csv" ? "csv" : "json";
      const validTargets = ["channels", "videos", "watchlist", "swipe", "ideas", "production"];
      const target = validTargets.includes(query.target) ? query.target : "channels";
      const exported = exportShortlist({ format, target, filters: query }, db);
      res.writeHead(200, {
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename="${exported.filename}"`
      });
      return res.end(exported.body);
    }

    if (pathname === "/api/v1/extension/batch-metrics" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const metrics = getBatchExtensionMetrics(body, db);
      return sendJson(req, res, 200, { ok: true, ...metrics });
    }

    // ========================================================================
    // 8. VIDEO TRANSCRIPT & SEPARATE PRODUCTION OUTLINE
    // ========================================================================

    if (
      pathname.startsWith("/api/v1/videos/") &&
      pathname.endsWith("/transcript") &&
      req.method === "GET"
    ) {
      const videoId = decodeURIComponent(
        pathname.replace("/api/v1/videos/", "").replace(/\/transcript$/, "")
      );
      const transcript = await getVideoTranscriptLive(videoId, {
        offset: Number(query.offset || 0),
        limit: Number(query.limit || 120),
        full: query.full === "true",
        lang: query.lang || null
      });
      return sendJson(req, res, 200, transcript);
    }

    if (
      pathname.startsWith("/api/v1/videos/") &&
      pathname.endsWith("/outline") &&
      req.method === "POST"
    ) {
      const videoId = decodeURIComponent(
        pathname.replace("/api/v1/videos/", "").replace(/\/outline$/, "")
      );
      const outline = generateVideoProductionOutline(videoId, db);
      return sendJson(req, res, 200, outline);
    }

    // ========================================================================
    // 9. THUMBNAIL & TITLE AUDITOR + SETTINGS
    // ========================================================================

    if (pathname === "/api/v1/thumbnail-lab/audit" && req.method === "POST") {
      const body = await readJsonBodyStrict(req);
      const result = await auditThumbnailAndTitle(body);
      return sendJson(req, res, 200, result);
    }

    if (pathname === "/api/v1/settings" && req.method === "GET") {
      return sendJson(req, res, 200, getPublicSettings(db));
    }

    if (pathname === "/api/v1/settings" && req.method === "POST") {
      requireManagerRole(currentUser);
      const body = await readJsonBodyStrict(req);
      const updated = saveSettingsAndSecrets(body, db);
      return sendJson(req, res, 200, {
        ok: true,
        ...updated
      });
    }

    // ========================================================================
    // 10. EXTERNAL / COMPATIBILITY ENDPOINTS
    // ========================================================================

    if (pathname === "/api/external/channels/outliers" && req.method === "GET") {
      const { outliers } = queryOutlierVideos(
        {
          minOutlierRatio: Number(query.outlierScore || 1) * 1.5,
          limit: Number(query.limit || 50)
        },
        db
      );
      return sendJson(req, res, 200, { data: outliers });
    }

    if (pathname === "/api/external/videos/rpm" && req.method === "GET") {
      const cls = classifyFacelessAndNiche(query.title || query.niche || "");
      const rpm = estimateChannelRpmAndRevenue({
        niche: cls.niche,
        avgDurationMinutes: query.durationMinutes ? Number(query.durationMinutes) : null,
        monthlyViews: query.views ? Number(query.views) : null
      });
      return sendJson(req, res, 200, { data: { ...cls, ...rpm } });
    }

    // CRITICAL: Any unmatched /api/* route MUST return 404 JSON, never index.html 200!
    if (pathname.startsWith("/api/")) {
      return sendJson(req, res, 404, {
        error: `API route not found: ${req.method} ${pathname}`,
        code: "API_NOT_FOUND",
        path: pathname
      });
    }

    // ========================================================================
    // 11. STATIC FRONTEND FILES (Single-Page App)
    // ========================================================================

    const safeRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(PUBLIC_DIR, safeRel);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(req, res, 403, { error: "Forbidden" });
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    const indexHtml = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
      });
      return fs.createReadStream(indexHtml).pipe(res);
    }

    return sendJson(req, res, 404, { error: "Not found" });
  } catch (err) {
    const status = Number(err?.statusCode) || 500;
    const payload = {
      error: err?.message || "Internal server error",
      code: err?.code || "INTERNAL_ERROR"
    };
    if (err?.serverItem) {
      payload.serverItem = err.serverItem;
    }
    return sendJson(req, res, status, payload);
  }
}

export function createNexlevServer(options = {}) {
  const customDb = options.db || null;
  return http.createServer((req, res) => handleHttpRequest(req, res, customDb));
}

// Start server if executed directly as main script (T19: no side effects on import)
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  ensureDbMigrated();
  recoverInterruptedCrawlJobs();
  syncScheduleFromDb();
  const server = createNexlevServer();
  server.listen(PORT, HOST, () => {
    console.log(`Nexlev Internal Team Studio running at http://${HOST}:${PORT}`);
  });
}
