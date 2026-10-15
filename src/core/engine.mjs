// Unified Core Service Layer (Batch 1, 2, 3)
// Shared by Web API (src/server.mjs), Crawler (src/core/crawler.mjs), and MCP (mcp-server/index.mjs)

import { Innertube } from "youtubei.js";
import {
  NICHE_CPM_TABLE,
  INITIAL_FILTER_TEMPLATES
} from "./seed-data.mjs";
import {
  computeOutlierTier,
  computeMedian,
  computeTrimmedMean,
  evaluateChannelVideosOutliers,
  classifyChannelHeuristic,
  simulateRpmScenario,
  buildHonestChannelRecord,
  DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
} from "./metrics.mjs";
import {
  parseCountTextStrict,
  parsePublishedTextStrict,
  classifyVideoContentType
} from "./parsers.mjs";
import {
  SQLITE_DB_PATH,
  LEGACY_JSON_PATH,
  getSqliteDb,
  withTransaction,
  loadSecrets,
  updateSecrets,
  maskSecret,
  getAppSetting,
  setAppSetting,
  upsertChannelAndVideos,
  migrateLegacyJsonToSqlite,
  authenticateUser,
  revokeUserSession,
  resolveUserFromToken,
  listTeamUsers,
  createTeamUser,
  updateTeamUser
} from "./sqlite-repo.mjs";
import { scanYouTubeNicheLive } from "./crawler.mjs";

export const DB_PATH = SQLITE_DB_PATH;
export {
  computeOutlierTier,
  computeMedian,
  computeTrimmedMean,
  evaluateChannelVideosOutliers,
  classifyChannelHeuristic,
  simulateRpmScenario,
  buildHonestChannelRecord,
  DEFAULT_MIN_OUTLIER_SAMPLE_SIZE,
  authenticateUser,
  revokeUserSession,
  resolveUserFromToken,
  listTeamUsers,
  createTeamUser,
  updateTeamUser,
  scanYouTubeNicheLive
};

export const SWIPE_WORKFLOW_STAGES = [
  "discovered",
  "approved",
  "briefing",
  "assigned",
  "published",
  "review"
];

export const SWIPE_WORKFLOW_STAGE_LABELS = {
  discovered: "1. Phát hiện",
  approved: "2. Duyệt",
  briefing: "3. Brief",
  assigned: "4. Giao việc",
  published: "5. Đã đăng",
  review: "6. Đánh giá"
};

export function normalizeWorkflowStage(rawStage) {
  const s = String(rawStage || "").trim().toLowerCase();
  if (s === "verified") return "approved";
  if (s === "producing") return "assigned";
  if (SWIPE_WORKFLOW_STAGES.includes(s)) return s;
  return "discovered";
}

let innertubePromise = null;
export async function getInnertube(lang = "en", location = "US") {
  if (lang === "en" && location === "US") {
    if (!innertubePromise) {
      innertubePromise = Innertube.create({
        lang: "en",
        location: "US",
        retrieve_player: false
      }).catch((err) => {
        innertubePromise = null;
        throw err;
      });
    }
    return innertubePromise;
  }
  return Innertube.create({
    lang,
    location,
    retrieve_player: false
  });
}

let migrationChecked = false;
export function ensureDbMigrated(customDb = null) {
  const db = customDb || getSqliteDb();
  if (!migrationChecked || customDb) {
    migrateLegacyJsonToSqlite(db, LEGACY_JSON_PATH);
    if (!customDb) migrationChecked = true;
  }
  return db;
}

// ============================================================================
// HONEST REPLACEMENTS FOR LEGACY FUNCTIONS
// ============================================================================

/**
 * Honest replacement for legacy deriveChannelStatsFromVideos:
 * NEVER fabricates subscribers, totalViews, videoCount, channelAgeMonths, or growthRate30d.
 * Only computes sample statistics (medianViews, avgViews, oldestObservedVideoDays) when videos exist.
 */
export function deriveChannelStatsFromVideos(videos = [], _seedHintIgnored = "", options = {}) {
  const minSampleSize = Number(options.minSampleSize || DEFAULT_MIN_OUTLIER_SAMPLE_SIZE);
  const evalResult = evaluateChannelVideosOutliers(videos, { minSampleSize });
  const validViews = (videos || [])
    .map((v) => (typeof v.views === "number" && Number.isFinite(v.views) && v.views >= 0 ? v.views : null))
    .filter((v) => v !== null);
  const validDays = (videos || [])
    .map((v) =>
      typeof v.publishedDaysAgo === "number" && Number.isFinite(v.publishedDaysAgo) && v.publishedDaysAgo >= 0
        ? v.publishedDaysAgo
        : null
    )
    .filter((d) => d !== null);

  return {
    medianViews: validViews.length >= minSampleSize ? computeMedian(validViews) : null,
    avgViews: validViews.length >= 1 ? computeTrimmedMean(validViews) : null,
    totalViews: null,
    totalViewsStatus: "unknown",
    subscribers: null,
    subscribersStatus: "unknown",
    channelAgeMonths: null,
    channelAgeStatus: "unknown",
    oldestObservedVideoDays: validDays.length > 0 ? Math.max(...validDays) : null,
    uploadFrequencyPerMonth:
      validDays.length >= 2 && Math.max(...validDays) > 0
        ? Number(((videos.length * 30) / Math.max(7, Math.max(...validDays))).toFixed(1))
        : null,
    videoCount: null,
    videoCountStatus: "unknown",
    observedVideoSampleCount: Array.isArray(videos) ? videos.length : 0,
    growthRate30d: null,
    growthStatus: "unknown",
    monthlyViews: null,
    monthlyViewsStatus: "unknown",
    outlierStatus: evalResult.channelOutlierStatus,
    outlierReason: evalResult.channelOutlierReason,
    topOutlierRatio: evalResult.topOutlierRatio,
    maxOutlierScore: evalResult.maxOutlierScore
  };
}

/**
 * Honest wrapper for classifyFacelessAndNiche:
 * Uses classifyChannelHeuristic (returns null/unknown for empty text, no fake 0.94 confidence).
 */
export function classifyFacelessAndNiche(textBlob = "") {
  const h = classifyChannelHeuristic(textBlob);
  return {
    niche: h.niche,
    nicheStatus: h.nicheStatus,
    format: h.format,
    formatStatus: h.formatStatus,
    isFaceless: h.isFaceless,
    facelessLabel: h.facelessLabel,
    facelessStatus: h.facelessStatus,
    facelessReason: h.facelessReason,
    facelessSignals: h.facelessSignals,
    facelessConfidence: null, // Deprecated uncalibrated confidence removed
    isAiContent: h.isAiContent,
    aiLabel: h.aiLabel,
    aiStatus: h.aiStatus,
    aiSignals: h.aiSignals
  };
}

/**
 * Honest wrapper for estimateChannelRpmAndRevenue:
 * Clearly labeled as scenario simulation; never fabricates audience geography breakdown.
 */
export function estimateChannelRpmAndRevenue({
  niche = "Business & Documentaries",
  avgDurationMinutes = null,
  contentType = "long",
  monthlyViews = null,
  marketMultiplier = 1.0
} = {}) {
  const sim = simulateRpmScenario({
    niche,
    avgDurationMinutes,
    contentType,
    monthlyViews,
    marketMultiplier
  });
  return {
    ...sim,
    audienceGeography: null,
    audienceGeographyStatus: "unknown",
    audienceGeographyReason:
      "YouTube không công khai phân bổ quốc gia khán giả của kênh đối thủ. Không gán tỷ lệ cố định."
  };
}

// ============================================================================
// ROW SERIALIZATION (SQLite Row -> Honest API Channel Object)
// ============================================================================

export function hydrateChannelRow(row, videosRows = null, db = null) {
  if (!row) return null;
  const activeDb = db || ensureDbMigrated();
  const vRows =
    videosRows ||
    activeDb
      .prepare(
        "SELECT * FROM videos WHERE channel_id = ? ORDER BY COALESCE(outlier_ratio, 0) DESC, COALESCE(views, 0) DESC"
      )
      .all(row.id);

  const videos = vRows.map(hydrateVideoRow);

  let facelessSignals = [];
  let aiSignals = [];
  let revenueAssumptions = {};
  let baselinesByFormat = {};
  let provenance = {};
  try {
    facelessSignals = JSON.parse(row.faceless_signals_json || "[]");
  } catch { /* ignore */ }
  try {
    aiSignals = JSON.parse(row.ai_signals_json || "[]");
  } catch { /* ignore */ }
  try {
    revenueAssumptions = JSON.parse(row.revenue_assumptions_json || "{}");
  } catch { /* ignore */ }
  try {
    baselinesByFormat = JSON.parse(row.baselines_by_format_json || "{}");
  } catch { /* ignore */ }
  try {
    provenance = JSON.parse(row.provenance_json || "{}");
  } catch { /* ignore */ }

  return {
    id: row.id,
    handle: row.handle || "@unknown",
    title: row.title,
    description: row.description || "",
    avatarUrl: row.avatar_url || null,
    dataOrigin: row.data_origin || "observed",

    // Explicit separation of discovery market vs channel country vs content language vs audience geography
    discoveryMarket: {
      countryCode: row.discovery_country || null,
      languageCode: row.discovery_lang || null,
      seedKeyword: row.discovery_keyword || null
    },
    channelCountry: row.channel_country,
    channelCountryStatus: row.channel_country_status || "unknown",
    // Keep legacy compatibility field `country` ONLY if observed or demo, otherwise null
    country: row.channel_country,
    discoveryCountry: row.discovery_country || null,
    contentLanguage: row.content_language,
    contentLanguageStatus: row.content_language_status || "unknown",
    language: row.content_language || row.discovery_lang || null,
    audienceGeography: null,
    audienceGeographyStatus: "unknown",

    niche: row.niche || "Unclassified",
    nicheStatus: row.niche_status || "unknown",
    format: row.format || "unknown",
    formatStatus: row.format_status || "unknown",
    contentType: row.content_type || "unknown",

    isFaceless: row.is_faceless === null ? null : Boolean(row.is_faceless),
    facelessLabel: row.faceless_label || "unknown",
    facelessStatus: row.faceless_status || "unknown",
    facelessReason: row.faceless_reason || null,
    facelessSignals,
    facelessConfidence: null,

    isAiContent: row.is_ai_content === null ? null : Boolean(row.is_ai_content),
    aiLabel: row.ai_label || "unknown",
    aiStatus: row.ai_status || "unknown",
    aiSignals,

    isMonetized: row.is_monetized === null ? null : Boolean(row.is_monetized),
    monetizationStatus: row.monetization_status || "unknown",
    monetizationReason:
      row.monetization_reason ||
      "YouTube không công khai trạng thái YPP; không suy ra từ subscribers >= 1000.",
    isKidsContent: row.is_kids_content === null ? null : Boolean(row.is_kids_content),

    subscribers: row.subscribers,
    subscribersStatus: row.subscribers_status || "unknown",
    totalViews: row.total_views,
    totalViewsStatus: row.total_views_status || "unknown",
    videoCount: row.video_count,
    videoCountStatus: row.video_count_status || "unknown",
    observedVideoSampleCount: row.observed_video_sample_count ?? videos.length,

    avgViews: row.avg_views,
    medianViews: row.median_views,
    avgDurationMinutes: row.avg_duration_minutes,
    uploadFrequencyPerMonth: row.upload_frequency_per_month,

    channelJoinedAt: row.channel_joined_at,
    channelAgeMonths: row.channel_age_months,
    channelAgeStatus: row.channel_age_status || "unknown",
    channelAgeReason: row.channel_age_reason || null,
    oldestObservedVideoDays: row.oldest_observed_video_days,

    growthRate30d: null,
    growthStatus: "unknown",
    realtime48hViews: null,
    hourly48hSeries: null,

    estimatedRpm: row.estimated_rpm,
    rpmStatus: row.rpm_status || "estimated",
    monthlyViews: row.monthly_views,
    monthlyViewsStatus: row.monthly_views_status || "unknown",
    monthlyRevenueMin: row.monthly_revenue_min,
    monthlyRevenueMax: row.monthly_revenue_max,
    revenueStatus: row.revenue_status || "unknown",
    revenueAssumptions,

    maxOutlierScore: row.max_outlier_score,
    topOutlierRatio: row.top_outlier_ratio,
    outlierStatus: row.outlier_status || "insufficient_data",
    outlierReason: row.outlier_reason || null,
    baselinesByFormat,
    provenance,

    isTracked: Boolean(row.is_tracked),
    watchlistNote: row.watchlist_note || "",
    watchlistAddedBy: row.watchlist_added_by || "",
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at,
    lastEnrichedAt: row.last_enriched_at,
    videos
  };
}

export function hydrateVideoRow(v) {
  if (!v) return null;
  return {
    videoId: v.video_id,
    channelId: v.channel_id,
    title: v.title,
    description: v.description || "",
    thumbnailUrl: v.thumbnail_url,
    canonicalUrl: v.canonical_url || `https://www.youtube.com/watch?v=${v.video_id}`,
    contentType: v.content_type || "unknown",
    views: v.views,
    viewsStatus: v.views_status || "unknown",
    viewsIsRounded: Boolean(v.views_is_rounded),
    likes: v.likes,
    likesStatus: v.likes !== null && v.likes !== undefined ? "observed" : "unknown",
    comments: v.comments,
    commentsStatus: v.comments !== null && v.comments !== undefined ? "observed" : "unknown",
    durationSeconds: v.duration_seconds,
    durationMinutes: v.duration_minutes,
    publishedAt: v.published_at,
    publishedDaysAgo: v.published_days_ago,
    publishedStatus: v.published_status || "unknown",
    viewsPerDay: v.views_per_day,
    outlierRatio: v.outlier_ratio,
    outlierScore: v.outlier_score,
    outlierStatus: v.outlier_status || "insufficient_data",
    outlierReason: v.outlier_reason || null,
    baselineMedianViews: v.baseline_median_views,
    baselineSampleSize: v.baseline_sample_size || 0,
    ageSkewWarning: v.age_skew_warning || null,
    estimatedRevenue: v.estimated_revenue,
    estimatedRevenueStatus: v.estimated_revenue_status || "estimated",
    dataOrigin: v.data_origin || "observed",
    source: v.source || "observed",
    collectedAt: v.collected_at,
    updatedAt: v.updated_at
  };
}

// ============================================================================
// SERVER-SIDE FILTERING & PAGINATION FOR CHANNELS & OUTLIERS
// ============================================================================

/**
 * Helper to check numeric filter safely without coercing null to 0!
 */
function matchesMin(val, minThreshold) {
  const min = Number(minThreshold);
  if (!Number.isFinite(min) || min <= 0) return true;
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return false;
  return Number(val) >= min;
}

function matchesMax(val, maxThreshold) {
  const max = Number(maxThreshold);
  if (!Number.isFinite(max) || max <= 0) return true;
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return false;
  return Number(val) <= max;
}

export function queryChannels(filters = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const defaultIncludeDemo = Boolean(getAppSetting(db, "includeDemo", false));

  const {
    query = "",
    niche = "all",
    format = "all",
    contentType = "all",
    monetizedOnly = "all",
    isFaceless = "all",
    aiContent = "all",
    minSubscribers = 0,
    maxSubscribers = 0,
    minAvgViews = 0,
    maxAvgViews = 0,
    minTotalViews = 0,
    maxVideoCount = 0,
    minAvgDurationMinutes = 0,
    minRpm = 0,
    minMonthlyRevenue = 0,
    maxAgeMonths = 0,
    minUploadFrequency = 0,
    minOutlierScore = 0,
    language = "all",
    country = "all",
    discoveryCountry = "all",
    excludeKids = "true",
    // Quality & provenance filters
    dataOrigin = "all", // all | observed | legacy_unverified | demo
    includeDemo = defaultIncludeDemo ? "true" : "false",
    outlierSampleFilter = "all", // all | sufficient | insufficient
    maxFreshnessDays = 0,
    sortBy = "outlier",
    page = 1,
    limit = 50
  } = filters;

  const allowDemo =
    includeDemo === true ||
    includeDemo === "true" ||
    includeDemo === "1" ||
    dataOrigin === "demo";

  const rows = db.prepare("SELECT * FROM channels").all();
  const allVideosRows = db
    .prepare(
      "SELECT * FROM videos ORDER BY COALESCE(outlier_ratio, 0) DESC, COALESCE(views, 0) DESC"
    )
    .all();

  const videosByChannel = new Map();
  for (const v of allVideosRows) {
    if (!videosByChannel.has(v.channel_id)) {
      videosByChannel.set(v.channel_id, []);
    }
    videosByChannel.get(v.channel_id).push(v);
  }

  let list = rows.map((r) => hydrateChannelRow(r, videosByChannel.get(r.id) || [], db));

  // 1. Demo separation filter
  if (!allowDemo) {
    list = list.filter((c) => c.dataOrigin !== "demo");
  }
  if (dataOrigin !== "all") {
    if (dataOrigin === "verified_only" || dataOrigin === "observed") {
      list = list.filter((c) => c.dataOrigin === "observed");
    } else {
      list = list.filter((c) => c.dataOrigin === dataOrigin);
    }
  }

  // 2. Outlier sample quality filter
  if (outlierSampleFilter === "sufficient") {
    list = list.filter((c) => c.outlierStatus === "derived" && c.topOutlierRatio !== null);
  } else if (outlierSampleFilter === "insufficient") {
    list = list.filter((c) => c.outlierStatus === "insufficient_data");
  }

  // 3. Freshness filter
  if (Number(maxFreshnessDays) > 0) {
    const cutoffMs = Date.now() - Number(maxFreshnessDays) * 86_400_000;
    list = list.filter((c) => {
      const ts = Date.parse(c.lastUpdatedAt || c.createdAt || "");
      return !Number.isNaN(ts) && ts >= cutoffMs;
    });
  }

  // 4. Text search
  if (query && String(query).trim()) {
    const q = String(query).trim().toLowerCase();
    list = list.filter(
      (c) =>
        (c.title || "").toLowerCase().includes(q) ||
        (c.handle || "").toLowerCase().includes(q) ||
        (c.niche || "").toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q) ||
        (c.discoveryMarket?.seedKeyword || "").toLowerCase().includes(q) ||
        (c.videos || []).some((v) => (v.title || "").toLowerCase().includes(q))
    );
  }

  // 5. Categorical filters
  if (niche !== "all") list = list.filter((c) => c.niche === niche);
  if (format !== "all") {
    list = list.filter((c) => (c.format || "").toLowerCase() === String(format).toLowerCase());
  }
  if (contentType !== "all") list = list.filter((c) => c.contentType === contentType);
  if (monetizedOnly === "true") list = list.filter((c) => c.isMonetized === true);
  if (monetizedOnly === "false") list = list.filter((c) => c.isMonetized === false);
  if (isFaceless === "true") list = list.filter((c) => c.isFaceless === true);
  if (isFaceless === "false") list = list.filter((c) => c.isFaceless === false);
  if (aiContent === "ai") list = list.filter((c) => c.isAiContent === true);
  if (aiContent === "human") list = list.filter((c) => c.isAiContent === false);

  // 6. Numeric filters (strictly distinguishing null from 0)
  list = list.filter((c) => {
    if (!matchesMin(c.subscribers, minSubscribers)) return false;
    if (!matchesMax(c.subscribers, maxSubscribers)) return false;
    if (!matchesMin(c.avgViews, minAvgViews)) return false;
    if (!matchesMax(c.avgViews, maxAvgViews)) return false;
    if (!matchesMin(c.totalViews, minTotalViews)) return false;
    if (!matchesMax(c.videoCount ?? c.observedVideoSampleCount, maxVideoCount)) return false;
    if (!matchesMin(c.avgDurationMinutes, minAvgDurationMinutes)) return false;
    if (!matchesMin(c.estimatedRpm, minRpm)) return false;
    if (!matchesMin(c.monthlyRevenueMax, minMonthlyRevenue)) return false;
    if (!matchesMax(c.channelAgeMonths ?? (c.oldestObservedVideoDays !== null ? c.oldestObservedVideoDays / 30 : null), maxAgeMonths)) {
      return false;
    }
    if (!matchesMin(c.uploadFrequencyPerMonth, minUploadFrequency)) return false;
    if (!matchesMin(c.maxOutlierScore, minOutlierScore)) return false;
    return true;
  });

  if (language !== "all") {
    list = list.filter(
      (c) => c.contentLanguage === language || c.discoveryMarket?.languageCode === language
    );
  }
  if (country !== "all") {
    list = list.filter(
      (c) => c.channelCountry === country || c.discoveryMarket?.countryCode === country
    );
  }
  if (discoveryCountry !== "all") {
    list = list.filter((c) => c.discoveryMarket?.countryCode === discoveryCountry);
  }
  if (excludeKids === "true") {
    list = list.filter((c) => c.isKidsContent !== true);
  }

  // 7. Sorting (nulls always sorted last!)
  const numOrNegInf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : -Infinity);
  const numOrPosInf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Infinity);

  list.sort((a, b) => {
    if (sortBy === "revenue") {
      return numOrNegInf(b.monthlyRevenueMax) - numOrNegInf(a.monthlyRevenueMax);
    }
    if (sortBy === "rpm") {
      return numOrNegInf(b.estimatedRpm) - numOrNegInf(a.estimatedRpm);
    }
    if (sortBy === "avgViews") {
      return numOrNegInf(b.avgViews) - numOrNegInf(a.avgViews);
    }
    if (sortBy === "subscribers") {
      return numOrNegInf(b.subscribers) - numOrNegInf(a.subscribers);
    }
    if (sortBy === "newest") {
      const ageA = a.channelAgeMonths ?? (a.oldestObservedVideoDays !== null ? a.oldestObservedVideoDays / 30 : null);
      const ageB = b.channelAgeMonths ?? (b.oldestObservedVideoDays !== null ? b.oldestObservedVideoDays / 30 : null);
      return numOrPosInf(ageA) - numOrPosInf(ageB);
    }
    if (sortBy === "viewSubRatio") {
      const ratioA = a.avgViews !== null && a.subscribers ? a.avgViews / a.subscribers : -Infinity;
      const ratioB = b.avgViews !== null && b.subscribers ? b.avgViews / b.subscribers : -Infinity;
      return ratioB - ratioA;
    }
    // Default: sort by topOutlierRatio (channels with sufficient sample first, then by avgViews)
    const outA = numOrNegInf(a.topOutlierRatio);
    const outB = numOrNegInf(b.topOutlierRatio);
    if (outB !== outA) return outB - outA;
    return numOrNegInf(b.avgViews) - numOrNegInf(a.avgViews);
  });

  const totalCount = list.length;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const totalPages = Math.max(1, Math.ceil(totalCount / safeLimit));
  const offset = (safePage - 1) * safeLimit;
  const pagedChannels = list.slice(offset, offset + safeLimit);

  return {
    totalCount,
    count: pagedChannels.length,
    page: safePage,
    limit: safeLimit,
    totalPages,
    hasMore: safePage < totalPages,
    nextCursor: safePage < totalPages ? String(safePage + 1) : null,
    channels: pagedChannels
  };
}

/**
 * Backward-compatible array helper
 */
export function filterChannels(filters = {}, customDb = null) {
  return queryChannels({ ...filters, limit: filters.limit || 200 }, customDb).channels;
}

export function queryOutlierVideos(filters = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const defaultIncludeDemo = Boolean(getAppSetting(db, "includeDemo", false));

  const {
    maxDaysAgo = 0,
    maxChannelSubscribers = 0,
    minOutlierRatio = 1.5,
    niche = "all",
    country = "all",
    contentType = "all",
    includeDemo = defaultIncludeDemo ? "true" : "false",
    includeInsufficientSample = "false",
    sortBy = "outlierRatio",
    page = 1,
    limit = 50
  } = filters;

  const allowDemo =
    includeDemo === true || includeDemo === "true" || includeDemo === "1";
  const allowInsufficient =
    includeInsufficientSample === true || includeInsufficientSample === "true";

  const rows = db.prepare(`
    SELECT
      v.*,
      c.title AS channel_title,
      c.handle AS channel_handle,
      c.subscribers AS channel_subscribers,
      c.subscribers_status AS channel_subscribers_status,
      c.channel_country,
      c.discovery_country,
      c.niche AS channel_niche,
      c.format AS channel_format,
      c.is_faceless AS channel_is_faceless,
      c.faceless_label AS channel_faceless_label,
      c.estimated_rpm AS channel_estimated_rpm,
      c.data_origin AS channel_data_origin
    FROM videos v
    JOIN channels c ON c.id = v.channel_id
  `).all();

  const outliers = [];
  for (const r of rows) {
    if (!allowDemo && (r.data_origin === "demo" || r.channel_data_origin === "demo")) {
      continue;
    }
    if (niche !== "all" && r.channel_niche !== niche) continue;
    if (
      country !== "all" &&
      r.channel_country !== country &&
      r.discovery_country !== country
    ) {
      continue;
    }
    if (contentType !== "all" && r.content_type !== contentType) continue;

    if (Number(maxChannelSubscribers) > 0) {
      if (r.channel_subscribers === null || r.channel_subscribers === undefined) continue;
      if (r.channel_subscribers > Number(maxChannelSubscribers)) continue;
    }

    if (Number(maxDaysAgo) > 0) {
      if (r.published_days_ago === null || r.published_days_ago === undefined) continue;
      if (r.published_days_ago > Number(maxDaysAgo)) continue;
    }

    if (!allowInsufficient) {
      if (r.outlier_status !== "derived" || r.outlier_ratio === null) continue;
      if (r.outlier_ratio < Number(minOutlierRatio)) continue;
    }

    const v = hydrateVideoRow(r);
    outliers.push({
      ...v,
      channelId: r.channel_id,
      channelTitle: r.channel_title,
      channelHandle: r.channel_handle,
      channelSubscribers: r.channel_subscribers,
      channelSubscribersStatus: r.channel_subscribers_status,
      channelCountry: r.channel_country,
      discoveryCountry: r.discovery_country,
      country: r.channel_country || r.discovery_country || null,
      niche: r.channel_niche,
      format: r.channel_format,
      isFaceless: r.channel_is_faceless === null ? null : Boolean(r.channel_is_faceless),
      facelessLabel: r.channel_faceless_label,
      estimatedRpm: r.channel_estimated_rpm,
      viewToSubRatio:
        v.views !== null && r.channel_subscribers
          ? Number((v.views / Math.max(1, r.channel_subscribers)).toFixed(2))
          : null
    });
  }

  const numOrNegInf = (val) => (typeof val === "number" && Number.isFinite(val) ? val : -Infinity);
  outliers.sort((a, b) => {
    if (sortBy === "viewsPerDay") return numOrNegInf(b.viewsPerDay) - numOrNegInf(a.viewsPerDay);
    if (sortBy === "views") return numOrNegInf(b.views) - numOrNegInf(a.views);
    return numOrNegInf(b.outlierRatio) - numOrNegInf(a.outlierRatio);
  });

  const totalCount = outliers.length;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const totalPages = Math.max(1, Math.ceil(totalCount / safeLimit));
  const offset = (safePage - 1) * safeLimit;
  const paged = outliers.slice(offset, offset + safeLimit);

  return {
    totalCount,
    count: paged.length,
    page: safePage,
    limit: safeLimit,
    totalPages,
    hasMore: safePage < totalPages,
    nextCursor: safePage < totalPages ? String(safePage + 1) : null,
    outliers: paged
  };
}

export function getViralOutlierVideos(filters = {}, customDb = null) {
  return queryOutlierVideos({ ...filters, limit: filters.limit || 200 }, customDb).outliers;
}

// ============================================================================
// CHANNEL DETAIL & REAL SNAPSHOT GROWTH TRACKING
// ============================================================================

export function getChannelGrowthTracking(channelId, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const snapshots = db
    .prepare(
      "SELECT * FROM metric_snapshots WHERE entity_type = 'channel' AND entity_id = ? ORDER BY collected_at ASC, id ASC"
    )
    .all(channelId);

  if (snapshots.length < 2) {
    return {
      status: "accumulating_snapshots",
      reason: `Đang tích lũy dữ liệu lịch sử (hiện có ${snapshots.length}/2 snapshot tối thiểu). Cần ít nhất 2 lần thu thập ở các thời điểm khác nhau để tính tốc độ tăng trưởng thực tế.`,
      snapshotCount: snapshots.length,
      snapshots,
      viewsDelta: null,
      subscribersDelta: null,
      viewsPerDayVelocity: null,
      anomalyWarning: null
    };
  }

  const first = snapshots[0];
  const latest = snapshots[snapshots.length - 1];
  const t1 = Date.parse(first.collected_at);
  const t2 = Date.parse(latest.collected_at);
  const elapsedDays = Math.max(1 / 24, (t2 - t1) / 86_400_000);

  const viewsDelta =
    latest.views !== null && first.views !== null ? latest.views - first.views : null;
  const subscribersDelta =
    latest.subscribers !== null && first.subscribers !== null
      ? latest.subscribers - first.subscribers
      : null;
  const videoCountDelta =
    latest.video_count !== null && first.video_count !== null
      ? latest.video_count - first.video_count
      : null;

  let anomalyWarning = null;
  if ((viewsDelta !== null && viewsDelta < 0) || (videoCountDelta !== null && videoCountDelta < 0)) {
    anomalyWarning =
      "Phát hiện tổng lượt xem hoặc số lượng video giảm giữa các snapshot (kênh có thể vừa ẩn hoặc xóa video).";
  }

  const viewsPerDayVelocity =
    viewsDelta !== null && viewsDelta >= 0 ? Math.round(viewsDelta / elapsedDays) : null;

  return {
    status: "derived",
    reason: null,
    snapshotCount: snapshots.length,
    firstSnapshotAt: first.collected_at,
    latestSnapshotAt: latest.collected_at,
    elapsedDays: Number(elapsedDays.toFixed(2)),
    viewsDelta,
    subscribersDelta,
    videoCountDelta,
    viewsPerDayVelocity,
    anomalyWarning,
    snapshots: snapshots.slice(-30)
  };
}

export function getChannelDetail(idOrHandle, customDb = null) {
  const clean = String(idOrHandle || "").trim();
  if (!clean) {
    const err = new Error("Thiếu tham số định danh kênh (channelId hoặc @handle).");
    err.code = "MISSING_IDENTIFIER";
    err.statusCode = 400;
    throw err;
  }

  const db = ensureDbMigrated(customDb);
  // 1. Exact ID match
  let row = db.prepare("SELECT * FROM channels WHERE id = ?").get(clean);

  // 2. Exact handle match (case-insensitive)
  if (!row) {
    const handleLookup = clean.startsWith("@") ? clean.toLowerCase() : `@${clean.toLowerCase()}`;
    const handleMatches = db
      .prepare("SELECT * FROM channels WHERE LOWER(handle) = ?")
      .all(handleLookup);
    if (handleMatches.length === 1) {
      row = handleMatches[0];
    } else if (handleMatches.length > 1) {
      return {
        found: false,
        ambiguous: true,
        message: `Có ${handleMatches.length} kênh trùng handle "${clean}". Vui lòng chọn theo channelId cụ thể.`,
        candidates: handleMatches.map((m) => ({
          id: m.id,
          handle: m.handle,
          title: m.title,
          niche: m.niche,
          dataOrigin: m.data_origin
        }))
      };
    }
  }

  // 3. Title or partial handle match
  if (!row) {
    const q = `%${clean.toLowerCase()}%`;
    const candidates = db
      .prepare("SELECT * FROM channels WHERE LOWER(title) LIKE ? OR LOWER(handle) LIKE ? LIMIT 10")
      .all(q, q);
    if (candidates.length === 1) {
      row = candidates[0];
    } else if (candidates.length > 1) {
      return {
        found: false,
        ambiguous: true,
        message: `Tìm thấy ${candidates.length} kênh khớp với "${clean}". Vui lòng chỉ định rõ channelId.`,
        candidates: candidates.map((m) => ({
          id: m.id,
          handle: m.handle,
          title: m.title,
          niche: m.niche,
          dataOrigin: m.data_origin
        }))
      };
    }
  }

  if (!row) {
    return {
      found: false,
      ambiguous: false,
      message: `Không tìm thấy kênh "${clean}" trong cơ sở dữ liệu.`
    };
  }

  const channel = hydrateChannelRow(row, null, db);
  const similarRows = db
    .prepare(
      "SELECT * FROM channels WHERE id != ? AND data_origin != 'demo' AND (niche = ? OR format = ?) ORDER BY COALESCE(top_outlier_ratio, 0) DESC LIMIT 4"
    )
    .all(channel.id, channel.niche, channel.format);
  const similarChannels = similarRows.map((r) => hydrateChannelRow(r, null, db));

  // Compute real Shorts vs Long split from observed videos
  const totalVids = channel.videos.length;
  let shortVsLongSplit = {
    status: "unknown",
    shortsCount: 0,
    longCount: 0,
    liveCount: 0,
    shortsShare: null,
    longFormShare: null
  };
  if (totalVids > 0) {
    const shortsCount = channel.videos.filter((v) => v.contentType === "shorts").length;
    const longCount = channel.videos.filter((v) => v.contentType === "long").length;
    const liveCount = channel.videos.filter((v) => v.contentType === "live").length;
    shortVsLongSplit = {
      status: "derived",
      sampleSize: totalVids,
      shortsCount,
      longCount,
      liveCount,
      shortsShare: Number((shortsCount / totalVids).toFixed(2)),
      longFormShare: Number((longCount / totalVids).toFixed(2))
    };
  }

  const growthTracking = getChannelGrowthTracking(channel.id, db);
  const discoveryHistory = db
    .prepare("SELECT * FROM discovery_records WHERE channel_id = ? ORDER BY discovered_at DESC")
    .all(channel.id);

  return {
    found: true,
    ambiguous: false,
    channel,
    similarChannels,
    shortVsLongSplit,
    growthTracking,
    discoveryHistory
  };
}

// ============================================================================
// TRANSCRIPT EXTRACTOR & SEPARATE PRODUCTION OUTLINE GENERATOR
// ============================================================================

/**
 * Extracts real YouTube video transcript via InnerTube.
 * NEVER returns a synthetic outline when captions are missing!
 */
export async function getVideoTranscriptLive(
  videoId,
  { offset = 0, limit = 120, full = false, lang = null } = {}
) {
  const cleanId = String(videoId || "").trim();
  if (!cleanId) {
    return {
      videoId: cleanId,
      available: false,
      status: "unavailable",
      source: null,
      reason: "Thiếu videoId hợp lệ.",
      segmentCount: 0,
      totalSegments: 0,
      fullText: null,
      segments: []
    };
  }

  try {
    const yt = await getInnertube(lang || "en", "US");
    const info = await yt.getInfo(cleanId);
    const transcriptData = await info.getTranscript();
    const rawSegments =
      transcriptData?.transcript?.content?.body?.initial_segments || [];

    const allSegments = rawSegments
      .map((seg) => ({
        startMs: Number(seg.start_ms || 0),
        endMs: Number(seg.end_ms || seg.start_ms || 0),
        timestamp: seg.start_time_text?.text || "0:00",
        text: (seg.snippet?.text || "").trim()
      }))
      .filter((s) => s.text.length > 0);

    if (allSegments.length > 0) {
      const safeOffset = Math.max(0, Number(offset) || 0);
      const safeLimit = full ? allSegments.length : Math.min(500, Math.max(1, Number(limit) || 120));
      const sliced = allSegments.slice(safeOffset, safeOffset + safeLimit);

      return {
        videoId: cleanId,
        available: true,
        status: "observed",
        source: "youtube-innertube-captions",
        language:
          transcriptData?.transcript?.content?.footer?.language_menu?.sub_menu_items?.find(
            (i) => i.selected
          )?.title ||
          lang ||
          "auto",
        isTranslated: false,
        reason: null,
        totalSegments: allSegments.length,
        segmentCount: sliced.length,
        offset: safeOffset,
        limit: safeLimit,
        hasMore: safeOffset + safeLimit < allSegments.length,
        fullText: allSegments.map((s) => s.text).join(" "),
        segments: sliced
      };
    }

    return {
      videoId: cleanId,
      available: false,
      status: "unavailable",
      source: null,
      reason: "Video này không có phụ đề/captions công khai trên YouTube.",
      totalSegments: 0,
      segmentCount: 0,
      fullText: null,
      segments: []
    };
  } catch (err) {
    return {
      videoId: cleanId,
      available: false,
      status: "unavailable",
      source: null,
      reason: `Không thể lấy transcript thực tế từ YouTube (${err?.message || "captions_disabled_or_unavailable"}).`,
      totalSegments: 0,
      segmentCount: 0,
      fullText: null,
      segments: []
    };
  }
}

/**
 * Separate explicit action to generate a structured production outline from video metadata.
 * Never conflated with real video transcripts!
 */
export function generateVideoProductionOutline(videoId, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const vRow = db
    .prepare(
      `SELECT v.*, c.title AS channel_title, c.niche AS channel_niche, c.format AS channel_format
       FROM videos v
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE v.video_id = ?`
    )
    .get(String(videoId || "").trim());

  const title = vRow?.title || `Video (${videoId})`;
  const niche = vRow?.channel_niche || "Documentary & Explainer";
  const sections = [
    {
      phase: "Hook & Curiosity Gap (0:00 - 0:40)",
      objective: `Mở đầu bằng nghịch lý hoặc câu hỏi lớn xoay quanh "${title}". Không giới thiệu tên kênh rườm rà.`,
      visualCue: "B-roll đối lập tốc độ cao + hiệu ứng âm thanh trầm (sub-drop) + tiêu đề nổi bật."
    },
    {
      phase: "Context & Stakes (0:40 - 3:00)",
      objective: `Đặt bối cảnh ngách ${niche} và giải thích vì sao cách hiểu thông thường bị sai lệch.`,
      visualCue: "Bản đồ/biểu đồ hoặc timeline 3D, đổi góc nhìn mỗi 35-45 giây."
    },
    {
      phase: "Core Investigation (3:00 - 9:30)",
      objective: "Đi sâu vào 3 bằng chứng hoặc bước ngoặt chính có nguồn kiểm chứng.",
      visualCue: "Tài liệu lưu trữ, số liệu cụ thể trên màn hình, giữ nhịp để mở khóa mid-roll (>8 phút)."
    },
    {
      phase: "Climax & Retention Bridge (9:30 - End)",
      objective: "Giải đáp câu hỏi mở ở phần Thumbnail/Title và dẫn trực tiếp sang video tiếp theo cùng chủ đề.",
      visualCue: "End-screen định hướng 1 video duy nhất có tỷ lệ giữ chân cao."
    }
  ];

  return {
    videoId,
    title,
    channelTitle: vRow?.channel_title || null,
    status: "derived",
    source: "production_outline_generator",
    note: "Đây là khung kịch bản gợi ý (Production Outline) dựa trên cấu trúc giữ chân người xem, KHÔNG phải transcript lời thoại gốc của video.",
    sections
  };
}

// ============================================================================
// HONEST THUMBNAIL & TITLE READINESS AUDITOR
// ============================================================================

export function validateHttpUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export async function auditThumbnailAndTitle({
  title = "",
  thumbnailUrl = "",
  niche = "History & Civilizations",
  channelTitle = "Research Channel"
} = {}) {
  const cleanTitle = String(title || "").trim();
  const safeThumbnailUrl = validateHttpUrl(thumbnailUrl);
  const wordCount = cleanTitle ? cleanTitle.split(/\s+/).length : 0;
  const charCount = cleanTitle.length;

  const hasNumber = /\d/.test(cleanTitle);
  const hasCuriosityTrigger =
    /why|how|secret|nobody|quietly|actually|warning|never|inside|truth|happened|tai sao|bí ẩn|sự thật|\?/i.test(
      cleanTitle
    );
  const optimalLength = charCount >= 38 && charCount <= 68;
  const avoidAllCapsSpam =
    cleanTitle.length > 0 &&
    cleanTitle.replace(/[^A-Z]/g, "").length / Math.max(1, cleanTitle.length) < 0.6;

  // Score ONLY measures Title Heuristics unless a real vision model analyzes the image.
  // Never add +4 points just for passing any non-empty URL string!
  let titleScore = 50;
  if (hasNumber) titleScore += 14;
  if (hasCuriosityTrigger) titleScore += 18;
  if (optimalLength) titleScore += 12;
  if (avoidAllCapsSpam && charCount > 0) titleScore += 6;
  if (charCount === 0) titleScore = 0;
  titleScore = Math.min(100, titleScore);

  const checklist = [
    {
      label: "Độ dài tiêu đề tối ưu trên Desktop & Mobile (38–68 ký tự)",
      passed: optimalLength,
      detail: `${charCount} ký tự (${wordCount} từ) — ${
        optimalLength
          ? "Không bị cắt dấu '...' trên trang chủ YouTube"
          : "Nên giữ trong khoảng 38–68 ký tự"
      }`
    },
    {
      label: "Curiosity Gap (Khoảng trống tò mò / Câu hỏi mở)",
      passed: hasCuriosityTrigger,
      detail: hasCuriosityTrigger
        ? "Có từ khóa kích thích tò mò (Why / How / Quietly / Actually / Bí ẩn...)"
        : "Nên thêm từ khóa mở khoảng trống tò mò (Why, How, Quietly, The Untold Story...)"
    },
    {
      label: "Con số cụ thể / Neo dữ liệu (Data Anchor)",
      passed: hasNumber,
      detail: hasNumber
        ? "Có con số cụ thể giúp tăng độ tin cậy và thu hút mắt nhìn"
        : "Thêm con số cụ thể (ví dụ: '48 Hours', '1972', '$80B') giúp neo sự chú ý tốt hơn"
    },
    {
      label: "Phân tích hình ảnh Thumbnail (Vision Analysis)",
      passed: false,
      status: "not_analyzed",
      detail: safeThumbnailUrl
        ? "URL ảnh hợp lệ để hiển thị preview, nhưng hệ thống chưa phân tích điểm thị giác (màu sắc/bố cục) nên không cộng điểm ảo vào điểm CTR."
        : "Chưa cung cấp URL ảnh hợp lệ (chỉ chấp nhận http/https)."
    }
  ];

  const suggestedTitles = [
    `Why Nobody Talks About ${cleanTitle || "This Forgotten Event"} (Full Breakdown)`,
    `How One Hidden Decision Changed ${cleanTitle || "Everything"} in 48 Hours`,
    `The Untold Story of ${cleanTitle || "an Unsolved Mystery"} Explained`
  ];

  const secrets = loadSecrets();
  if (secrets.geminiApiKey && cleanTitle) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
          secrets.geminiApiKey
        )}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Đánh giá tiêu đề YouTube "${cleanTitle}" cho ngách "${niche}" và gợi ý 3 phương án tiêu đề tối ưu CTR. Trả lời ngắn gọn dưới 120 từ.`
                  }
                ]
              }
            ]
          })
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (aiText) {
          return {
            ctrScore: titleScore,
            titleReadinessScore: titleScore,
            scoreStatus: "heuristic_title_only",
            imageAnalysisStatus: "not_analyzed",
            safeThumbnailUrl,
            niche,
            channelTitle,
            checklist,
            suggestedTitles,
            aiCritique: aiText,
            aiPowered: true
          };
        }
      }
    } catch {
      // Fallback to deterministic heuristic critique
    }
  }

  return {
    ctrScore: titleScore,
    titleReadinessScore: titleScore,
    scoreStatus: "heuristic_title_only",
    imageAnalysisStatus: "not_analyzed",
    imageAnalysisReason:
      "Điểm số chỉ đánh giá cấu trúc văn bản tiêu đề (Title Readiness). Không cộng điểm cho URL ảnh khi chưa phân tích thị giác.",
    safeThumbnailUrl,
    niche,
    channelTitle,
    checklist,
    suggestedTitles,
    aiCritique: `Điểm Title Readiness đạt ${titleScore}/100 cho ngách ${niche}. Lưu ý: Điểm này chỉ chấm cấu trúc tiêu đề, chưa chấm bố cục ảnh thumbnail.`,
    aiPowered: false
  };
}

// ============================================================================
// TEAM WORKFLOW: SWIPE ITEMS, 6 STAGES & PRODUCTION BRIEF GENERATOR
// ============================================================================

export function toggleChannelWatchlist(
  channelId,
  { note = undefined, actorUsername = "" } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  const existing = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
  if (!existing) {
    const err = new Error(`Không tìm thấy kênh "${channelId}".`);
    err.statusCode = 404;
    throw err;
  }

  const nextTracked = existing.is_tracked ? 0 : 1;
  const nextNote = note !== undefined ? String(note) : existing.watchlist_note || "";
  const nextAddedBy = nextTracked ? actorUsername || existing.watchlist_added_by || "" : "";

  db.prepare(`
    UPDATE channels SET
      is_tracked = ?,
      watchlist_note = ?,
      watchlist_added_by = ?,
      updated_at = ?
    WHERE id = ?
  `).run(nextTracked, nextNote, nextAddedBy, new Date().toISOString(), channelId);

  const trackedChannelIds = db
    .prepare("SELECT id FROM channels WHERE is_tracked = 1")
    .all()
    .map((r) => r.id);

  return {
    ok: true,
    channelId,
    tracked: Boolean(nextTracked),
    watchlistNote: nextNote,
    watchlistAddedBy: nextAddedBy,
    trackedChannelIds
  };
}

export function getSwipeData({ folderId = "all", stage = "all", assignee = "all" } = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const folders = db
    .prepare("SELECT * FROM swipe_folders ORDER BY created_at ASC")
    .all();

  let sql = "SELECT * FROM swipe_items WHERE 1=1";
  const params = [];
  if (folderId && folderId !== "all") {
    sql += " AND folder_id = ?";
    params.push(folderId);
  }
  if (stage && stage !== "all") {
    const normStage = normalizeWorkflowStage(stage);
    sql += " AND workflow_stage = ?";
    params.push(normStage);
  }
  if (assignee && assignee !== "all") {
    sql += " AND (LOWER(owner_label) = ? OR LOWER(assignee_id) = ?)";
    params.push(String(assignee).toLowerCase(), String(assignee).toLowerCase());
  }
  sql += " ORDER BY saved_at DESC";

  const rows = db.prepare(sql).all(...params);
  const items = rows.map((r) => {
    let tags = [];
    try {
      tags = JSON.parse(r.tags_json || "[]");
    } catch { /* ignore */ }
    const normStage = normalizeWorkflowStage(r.workflow_stage);
    const resultUrl = validateHttpUrl(r.result_url || r.published_video_url) || "";
    return {
      id: r.id,
      folderId: r.folder_id,
      type: r.type,
      videoId: r.video_id,
      channelId: r.channel_id,
      canonicalUrl:
        r.canonical_url ||
        (r.video_id ? `https://www.youtube.com/watch?v=${r.video_id}` : null),
      title: r.title,
      channelTitle: r.channel_title,
      channelHandle: r.channel_handle,
      thumbnailUrl: validateHttpUrl(r.thumbnail_url) || "",
      outlierRatio: r.outlier_ratio,
      views: r.views,
      estimatedRpm: r.estimated_rpm,
      workflowStage: normStage,
      workflowStageLabel: SWIPE_WORKFLOW_STAGE_LABELS[normStage] || normStage,
      assigneeId: r.assignee_id || "",
      ownerLabel: r.owner_label || "",
      deadline: r.deadline || "",
      resultUrl,
      publishedVideoUrl: resultUrl,
      briefMarkdown: r.brief_markdown || "",
      tags,
      notes: r.notes || "",
      source: r.source || "manual",
      createdBy: r.created_by || "",
      updatedBy: r.updated_by || "",
      savedAt: r.saved_at,
      updatedAt: r.updated_at
    };
  });

  return {
    folders,
    items,
    workflowStages: SWIPE_WORKFLOW_STAGES,
    workflowStageLabels: SWIPE_WORKFLOW_STAGE_LABELS
  };
}

export function createSwipeItem(payload = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const title = String(payload.title || "").trim();
  if (!title) {
    const err = new Error("Tiêu đề (title) không được để trống khi lưu vào thư viện ý tưởng.");
    err.statusCode = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const id = payload.id || `swipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const videoId = payload.videoId ? String(payload.videoId).trim() : null;
  const channelId = payload.channelId ? String(payload.channelId).trim() : null;
  const canonicalUrl =
    validateHttpUrl(payload.canonicalUrl) ||
    (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
  const thumbnailUrl =
    validateHttpUrl(payload.thumbnailUrl) ||
    (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "");

  const stage = normalizeWorkflowStage(payload.workflowStage);
  const resultUrl = validateHttpUrl(payload.resultUrl || payload.publishedVideoUrl) || "";

  const tags = Array.isArray(payload.tags)
    ? payload.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(payload.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

  db.prepare(`
    INSERT INTO swipe_items (
      id, folder_id, type, video_id, channel_id, canonical_url,
      title, channel_title, channel_handle, thumbnail_url,
      outlier_ratio, views, estimated_rpm,
      workflow_stage, assignee_id, owner_label, deadline, result_url, published_video_url,
      brief_markdown, tags_json, notes, source, created_by, updated_by, saved_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    payload.folderId || "folder-outliers",
    payload.type || "video",
    videoId,
    channelId,
    canonicalUrl,
    title,
    String(payload.channelTitle || "").trim(),
    String(payload.channelHandle || "").trim(),
    thumbnailUrl,
    typeof payload.outlierRatio === "number" && Number.isFinite(payload.outlierRatio)
      ? payload.outlierRatio
      : null,
    typeof payload.views === "number" && Number.isFinite(payload.views)
      ? Math.round(payload.views)
      : null,
    typeof payload.estimatedRpm === "number" && Number.isFinite(payload.estimatedRpm)
      ? payload.estimatedRpm
      : null,
    stage,
    String(payload.assigneeId || "").trim(),
    String(payload.ownerLabel || payload.assigneeName || "").trim(),
    String(payload.deadline || "").trim(),
    resultUrl,
    resultUrl,
    String(payload.briefMarkdown || ""),
    JSON.stringify(tags),
    String(payload.notes || ""),
    String(payload.source || "manual"),
    String(payload.createdBy || ""),
    String(payload.updatedBy || payload.createdBy || ""),
    now,
    now
  );

  return getSwipeData({}, db).items.find((i) => i.id === id);
}

export function updateSwipeItem(id, patch = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const existing = db.prepare("SELECT * FROM swipe_items WHERE id = ?").get(id);
  if (!existing) {
    const err = new Error(`Không tìm thấy ý tưởng/công việc "${id}".`);
    err.statusCode = 404;
    throw err;
  }

  const nextStage =
    patch.workflowStage !== undefined
      ? normalizeWorkflowStage(patch.workflowStage)
      : normalizeWorkflowStage(existing.workflow_stage);

  const nextTags =
    patch.tags !== undefined
      ? JSON.stringify(
          Array.isArray(patch.tags)
            ? patch.tags.map((t) => String(t).trim()).filter(Boolean)
            : String(patch.tags)
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
        )
      : existing.tags_json;

  const nextResultUrl =
    patch.resultUrl !== undefined || patch.publishedVideoUrl !== undefined
      ? validateHttpUrl(patch.resultUrl ?? patch.publishedVideoUrl) || ""
      : existing.result_url || existing.published_video_url || "";

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE swipe_items SET
      folder_id = ?,
      title = ?,
      workflow_stage = ?,
      assignee_id = ?,
      owner_label = ?,
      deadline = ?,
      result_url = ?,
      published_video_url = ?,
      brief_markdown = ?,
      tags_json = ?,
      notes = ?,
      updated_by = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    patch.folderId || existing.folder_id,
    patch.title !== undefined ? String(patch.title).trim() : existing.title,
    nextStage,
    patch.assigneeId !== undefined ? String(patch.assigneeId).trim() : existing.assignee_id || "",
    patch.ownerLabel !== undefined ? String(patch.ownerLabel).trim() : existing.owner_label || "",
    patch.deadline !== undefined ? String(patch.deadline).trim() : existing.deadline || "",
    nextResultUrl,
    nextResultUrl,
    patch.briefMarkdown !== undefined ? String(patch.briefMarkdown) : existing.brief_markdown,
    nextTags,
    patch.notes !== undefined ? String(patch.notes) : existing.notes,
    patch.updatedBy !== undefined ? String(patch.updatedBy) : existing.updated_by || "",
    now,
    id
  );

  return getSwipeData({}, db).items.find((i) => i.id === id);
}

export function deleteSwipeItem(id, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const info = db.prepare("DELETE FROM swipe_items WHERE id = ?").run(id);
  return { deleted: info.changes > 0, deletedId: id };
}

export function generateSwipeProductionBrief(id, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const items = getSwipeData({}, db).items;
  const item = items.find((i) => i.id === id);
  if (!item) {
    const err = new Error(`Không tìm thấy ý tưởng/công việc "${id}".`);
    err.statusCode = 404;
    throw err;
  }

  const briefMarkdown = `# Production Brief: ${item.title}

- **Nguồn tham chiếu**: ${item.canonicalUrl || "Chưa gắn URL"}
- **Kênh đối thủ**: ${item.channelTitle || "Unknown"} (${item.channelHandle || "N/A"})
- **Chỉ số quan sát**: Views: ${item.views !== null ? item.views.toLocaleString() : "unknown"} | Outlier Ratio: ${item.outlierRatio !== null ? `${item.outlierRatio}x` : "insufficient_data"}
- **Trạng thái quy trình**: \`${item.workflowStageLabel}\`
- **Người phụ trách**: ${item.ownerLabel || "Chưa phân công"} | **Deadline**: ${item.deadline || "Chưa đặt"}
- **Link kết quả**: ${item.resultUrl || "Chưa có"}

## 1. Góc tiếp cận & Lý do chọn (Angle & Outlier Hypothesis)
- Video gốc khai thác khoảng trống tò mò (Curiosity Gap) rõ rệt trong tiêu đề.
- Mục tiêu sản xuất: Giữ cấu trúc câu hỏi mở của chủ đề nhưng làm sâu hơn bằng dữ liệu/bằng chứng thực tế.

## 2. Phương án Tiêu đề & Thumbnail (3 Variants)
1. **Variant A (Curiosity Gap)**: Why Nobody Talks About ${item.title}
2. **Variant B (Mechanism/Timeline)**: How ${item.title} Actually Happened (Step-by-Step)
3. **Variant C (Data Anchor)**: Inside the Untold Story of ${item.title}
- **Concept Thumbnail**: Tối đa 3 từ chữ lớn, độ tương phản cao, tập trung vào 1 chủ thể trung tâm.

## 3. Khung Kịch bản Giữ chân (Retention Outline)
- **0:00 - 0:35 (Hook)**: Đặt ngay nghịch lý lớn nhất từ tiêu đề + bằng chứng thị giác đầu tiên.
- **0:35 - 3:00 (Setup)**: Giải thích bối cảnh và tại sao giả thuyết phổ biến lại sai.
- **3:00 - 8:30 (Core Evidence)**: 3 bước ngoặt chính, chuyển cảnh/B-roll mỗi 40 giây.
- **8:30+ (Climax & Bridge)**: Giải quyết trọn vẹn câu hỏi mở và dẫn thẳng sang video liên quan.

## 4. Ghi chú của Team
${item.notes || "_Chưa có ghi chú bổ sung._"}
`;

  const nextStage =
    item.workflowStage === "discovered" || item.workflowStage === "approved"
      ? "briefing"
      : item.workflowStage;

  return updateSwipeItem(
    id,
    {
      briefMarkdown,
      workflowStage: nextStage
    },
    db
  );
}

// ============================================================================
// TEAM WORKFLOW: BULK IMPORT & SHORTLIST EXPORT (CSV / JSON)
// ============================================================================

export function parseImportLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return { valid: false, reason: "empty" };

  // Check URL patterns
  if (/^https?:\/\//i.test(line)) {
    try {
      const u = new URL(line);
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "youtu.be") {
        const vid = u.pathname.replace(/^\//, "").split("/")[0];
        if (/^[a-zA-Z0-9_-]{6,15}$/.test(vid)) {
          return { valid: true, type: "video", id: vid, normalizedKey: `video:${vid}`, raw: line };
        }
      }
      if (host.endsWith("youtube.com")) {
        const vParam = u.searchParams.get("v");
        if (vParam && /^[a-zA-Z0-9_-]{6,15}$/.test(vParam)) {
          return { valid: true, type: "video", id: vParam, normalizedKey: `video:${vParam}`, raw: line };
        }
        const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{6,15})/);
        if (shortsMatch) {
          return {
            valid: true,
            type: "video",
            id: shortsMatch[1],
            normalizedKey: `video:${shortsMatch[1]}`,
            raw: line
          };
        }
        const channelMatch = u.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]{10,})/);
        if (channelMatch) {
          return {
            valid: true,
            type: "channel_id",
            id: channelMatch[1],
            normalizedKey: `channel:${channelMatch[1]}`,
            raw: line
          };
        }
        const handleMatch = u.pathname.match(/^\/(@[a-zA-Z0-9_.-]{2,})/);
        if (handleMatch) {
          const h = handleMatch[1].toLowerCase();
          return { valid: true, type: "handle", id: h, normalizedKey: `handle:${h}`, raw: line };
        }
      }
      return { valid: false, reason: "URL không phải kênh hoặc video YouTube hợp lệ", raw: line };
    } catch {
      return { valid: false, reason: "URL sai định dạng", raw: line };
    }
  }

  // Direct handle @...
  if (/^@[a-zA-Z0-9_.-]{2,50}$/.test(line)) {
    const h = line.toLowerCase();
    return { valid: true, type: "handle", id: h, normalizedKey: `handle:${h}`, raw: line };
  }

  // Direct channel ID UC...
  if (/^UC[a-zA-Z0-9_-]{10,40}$/.test(line)) {
    return { valid: true, type: "channel_id", id: line, normalizedKey: `channel:${line}`, raw: line };
  }

  // Direct 11-char videoId
  if (/^[a-zA-Z0-9_-]{11}$/.test(line)) {
    return { valid: true, type: "video", id: line, normalizedKey: `video:${line}`, raw: line };
  }

  return {
    valid: false,
    reason: "Không nhận diện được định dạng (@handle, UC... channelId, hoặc URL YouTube)",
    raw: line
  };
}

export function bulkImportTargets(rawLinesInput, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const rawLines = Array.isArray(rawLinesInput)
    ? rawLinesInput
    : String(rawLinesInput || "")
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  const seenKeys = new Set();
  const validItems = [];
  const invalidLines = [];
  let duplicateCount = 0;

  for (const raw of rawLines) {
    const parsed = parseImportLine(raw);
    if (!parsed.valid) {
      if (parsed.reason !== "empty") {
        invalidLines.push({ input: raw, reason: parsed.reason });
      }
      continue;
    }
    if (seenKeys.has(parsed.normalizedKey)) {
      duplicateCount += 1;
      continue;
    }
    seenKeys.add(parsed.normalizedKey);
    validItems.push(parsed);
  }

  const importedResults = [];
  const now = new Date().toISOString();

  for (const item of validItems) {
    if (item.type === "channel_id" || item.type === "handle") {
      const detail = getChannelDetail(item.id, db);
      if (detail.found && detail.channel) {
        db.prepare("UPDATE channels SET is_tracked = 1 WHERE id = ?").run(detail.channel.id);
        importedResults.push({
          input: item.raw,
          type: item.type,
          status: "matched_existing_and_tracked",
          channelId: detail.channel.id,
          title: detail.channel.title
        });
      } else {
        const newChannelId =
          item.type === "channel_id"
            ? item.id
            : `UC_IMPORT_${item.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 14)}`;
        const record = upsertChannelAndVideos(db, {
          channelId: newChannelId,
          handle: item.type === "handle" ? item.id : `@${item.id.slice(0, 12)}`,
          title: item.type === "handle" ? item.id : `Imported Channel ${item.id}`,
          description: `Imported manually via Bulk Import (${item.raw})`,
          videos: [],
          dataOrigin: "observed",
          collectedAt: now
        });
        db.prepare("UPDATE channels SET is_tracked = 1 WHERE id = ?").run(record.id);
        importedResults.push({
          input: item.raw,
          type: item.type,
          status: "created_placeholder_pending_enrichment",
          channelId: record.id,
          title: record.title
        });
      }
    } else if (item.type === "video") {
      const existingVid = db
        .prepare("SELECT * FROM videos WHERE video_id = ?")
        .get(item.id);
      const swipeItem = createSwipeItem(
        {
          folderId: "folder-outliers",
          type: "video",
          videoId: item.id,
          channelId: existingVid?.channel_id || null,
          canonicalUrl: `https://www.youtube.com/watch?v=${item.id}`,
          title: existingVid?.title || `Imported YouTube Video (${item.id})`,
          thumbnailUrl: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          outlierRatio: existingVid?.outlier_ratio ?? null,
          views: existingVid?.views ?? null,
          workflowStage: "discovered",
          source: "bulk_import"
        },
        db
      );
      importedResults.push({
        input: item.raw,
        type: "video",
        status: existingVid ? "saved_existing_video_to_swipe" : "saved_new_video_to_swipe",
        videoId: item.id,
        swipeItemId: swipeItem.id
      });
    }
  }

  return {
    totalSubmitted: rawLines.length,
    validCount: validItems.length,
    duplicateCount,
    invalidCount: invalidLines.length,
    importedCount: importedResults.length,
    invalidLines,
    items: importedResults
  };
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportShortlist({ format = "json", target = "channels", filters = {} } = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);

  if (target === "swipe") {
    const { items } = getSwipeData(filters, db);
    if (format === "csv") {
      const headers = [
        "id",
        "workflowStage",
        "ownerLabel",
        "title",
        "videoId",
        "channelId",
        "channelTitle",
        "canonicalUrl",
        "views",
        "outlierRatio",
        "publishedVideoUrl",
        "notes",
        "savedAt"
      ];
      const lines = [
        headers.join(","),
        ...items.map((item) => headers.map((h) => escapeCsvCell(item[h])).join(","))
      ];
      return { contentType: "text/csv; charset=utf-8", filename: "nexlev-swipe-shortlist.csv", body: lines.join("\n") };
    }
    return {
      contentType: "application/json; charset=utf-8",
      filename: "nexlev-swipe-shortlist.json",
      body: JSON.stringify({ exportedAt: new Date().toISOString(), count: items.length, items }, null, 2)
    };
  }

  const { channels } = queryChannels({ ...filters, limit: 500 }, db);
  if (format === "csv") {
    const headers = [
      "id",
      "handle",
      "title",
      "dataOrigin",
      "niche",
      "format",
      "facelessLabel",
      "facelessStatus",
      "subscribers",
      "subscribersStatus",
      "avgViews",
      "medianViews",
      "observedVideoSampleCount",
      "topOutlierRatio",
      "outlierStatus",
      "estimatedRpm",
      "rpmStatus",
      "channelCountry",
      "channelCountryStatus",
      "discoveryCountry",
      "lastUpdatedAt"
    ];
    const lines = [
      headers.join(","),
      ...channels.map((ch) => headers.map((h) => escapeCsvCell(ch[h])).join(","))
    ];
    return { contentType: "text/csv; charset=utf-8", filename: "nexlev-channels-shortlist.csv", body: lines.join("\n") };
  }

  return {
    contentType: "application/json; charset=utf-8",
    filename: "nexlev-channels-shortlist.json",
    body: JSON.stringify(
      { exportedAt: new Date().toISOString(), count: channels.length, channels },
      null,
      2
    )
  };
}

// ============================================================================
// EXTENSION BATCH METRICS LOOKUP (Consistent with Backend Baseline!)
// ============================================================================

export function getBatchExtensionMetrics({ videoIds = [], channelIds = [], handles = [] } = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const videosResult = {};
  const channelsResult = {};

  for (const rawVid of (videoIds || []).slice(0, 100)) {
    const vid = String(rawVid || "").trim();
    if (!vid) continue;
    const vRow = db.prepare("SELECT * FROM videos WHERE video_id = ?").get(vid);
    if (vRow) {
      const chRow = db.prepare("SELECT * FROM channels WHERE id = ?").get(vRow.channel_id);
      videosResult[vid] = {
        known: true,
        videoId: vid,
        channelId: vRow.channel_id,
        channelTitle: chRow?.title || null,
        channelHandle: chRow?.handle || null,
        outlierRatio: vRow.outlier_ratio,
        outlierScore: vRow.outlier_score,
        outlierStatus: vRow.outlier_status,
        outlierReason: vRow.outlier_reason,
        baselineMedianViews: vRow.baseline_median_views,
        baselineSampleSize: vRow.baseline_sample_size,
        estimatedRpm: chRow?.estimated_rpm ?? null,
        rpmStatus: chRow?.rpm_status || "estimated",
        dataOrigin: vRow.data_origin
      };
    } else {
      videosResult[vid] = {
        known: false,
        videoId: vid,
        outlierRatio: null,
        outlierStatus: "insufficient_data",
        outlierReason: "Video chưa có đủ mẫu baseline kênh trong SQLite."
      };
    }
  }

  for (const rawCh of [...(channelIds || []), ...(handles || [])].slice(0, 100)) {
    const key = String(rawCh || "").trim();
    if (!key) continue;
    const detail = getChannelDetail(key, db);
    if (detail.found && detail.channel) {
      const ch = detail.channel;
      channelsResult[key] = {
        known: true,
        channelId: ch.id,
        handle: ch.handle,
        title: ch.title,
        medianViews: ch.medianViews,
        observedVideoSampleCount: ch.observedVideoSampleCount,
        topOutlierRatio: ch.topOutlierRatio,
        outlierStatus: ch.outlierStatus,
        outlierReason: ch.outlierReason,
        estimatedRpm: ch.estimatedRpm,
        rpmStatus: ch.rpmStatus,
        baselinesByFormat: ch.baselinesByFormat
      };
    } else {
      channelsResult[key] = {
        known: false,
        outlierStatus: "insufficient_data",
        outlierReason: "Kênh chưa có mẫu video trong cơ sở dữ liệu."
      };
    }
  }

  return {
    videos: videosResult,
    channels: channelsResult
  };
}

// ============================================================================
// SETTINGS & SECRETS API HELPERS
// ============================================================================

export function getPublicSettings(customDb = null) {
  const db = ensureDbMigrated(customDb);
  const secrets = loadSecrets();
  return {
    youtubeApiKeyMasked: maskSecret(secrets.youtubeApiKey),
    geminiApiKeyMasked: maskSecret(secrets.geminiApiKey),
    hasYoutubeApiKey: Boolean(secrets.youtubeApiKey),
    hasGeminiApiKey: Boolean(secrets.geminiApiKey),
    includeDemo: Boolean(getAppSetting(db, "includeDemo", false)),
    minOutlierSampleSize: Number(
      getAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE)
    ),
    defaultCurrency: getAppSetting(db, "defaultCurrency", "USD"),
    crawlerSchedule: getAppSetting(db, "crawlerSchedule", {
      autoScheduleEnabled: false,
      intervalMinutes: 15
    })
  };
}

/**
 * Safely updates settings and secrets.
 * Submitting an empty string for youtubeApiKey or geminiApiKey without explicit action='clear'
 * NEVER deletes an existing secret!
 */
export function saveSettingsAndSecrets(body = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);

  const ytAction =
    body.clearYoutubeApiKey === true || body.youtubeApiKeyAction === "clear"
      ? "clear"
      : typeof body.youtubeApiKey === "string" && body.youtubeApiKey.trim().length > 0
        ? "replace"
        : "keep";

  const geminiAction =
    body.clearGeminiApiKey === true || body.geminiApiKeyAction === "clear"
      ? "clear"
      : typeof body.geminiApiKey === "string" && body.geminiApiKey.trim().length > 0
        ? "replace"
        : "keep";

  updateSecrets({
    youtubeApiKeyAction: ytAction,
    youtubeApiKey: body.youtubeApiKey || "",
    geminiApiKeyAction: geminiAction,
    geminiApiKey: body.geminiApiKey || ""
  });

  if (typeof body.includeDemo === "boolean") {
    setAppSetting(db, "includeDemo", body.includeDemo);
  }
  if (Number(body.minOutlierSampleSize) >= 2) {
    setAppSetting(db, "minOutlierSampleSize", Math.round(Number(body.minOutlierSampleSize)));
  }
  if (typeof body.defaultCurrency === "string" && body.defaultCurrency.trim()) {
    setAppSetting(db, "defaultCurrency", body.defaultCurrency.trim());
  }

  return getPublicSettings(db);
}

// ============================================================================
// LEGACY COMPATIBILITY SHIMS (loadDb / saveDb)
// ============================================================================

export function loadDb(customDb = null) {
  const db = ensureDbMigrated(customDb);
  const { channels } = queryChannels({ includeDemo: "true", limit: 1000 }, db);
  const { folders: swipeFolders, items: swipeItems } = getSwipeData({}, db);
  const filterTemplates = db
    .prepare("SELECT * FROM filter_templates ORDER BY created_at ASC")
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      filters: JSON.parse(r.filters_json || "{}")
    }));

  const trackedChannelIds = db
    .prepare("SELECT id FROM channels WHERE is_tracked = 1")
    .all()
    .map((r) => r.id);

  return {
    settings: getPublicSettings(db),
    channels,
    filterTemplates: filterTemplates.length ? filterTemplates : INITIAL_FILTER_TEMPLATES,
    swipeFolders,
    swipeItems,
    trackedChannelIds
  };
}

export function saveDb(_legacyObj) {
  // No-op shim: All writes now go through transactional SQLite repository functions.
  return loadDb();
}
