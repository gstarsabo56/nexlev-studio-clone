// Unified Core Service Layer (Batch 1, 2, 3)
// Shared by Web API (src/server.mjs), Crawler (src/core/crawler.mjs), and MCP (mcp-server/index.mjs)

import crypto from "node:crypto";
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
  ensureDbMigrated as repoEnsureDbMigrated,
  withTransaction,
  loadSecrets,
  updateSecrets,
  maskSecret,
  maskApiToken,
  getAppSetting,
  setAppSetting,
  upsertChannelAndVideos,
  recomputeAllChannelOutliers,
  migrateLegacyJsonToSqlite,
  authenticateUser,
  revokeUserSession,
  revokeAllUserSessions,
  rotateUserApiToken,
  getPersonalApiTokenForUser,
  getUserCapabilities,
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
  recomputeAllChannelOutliers,
  maskApiToken,
  authenticateUser,
  revokeUserSession,
  revokeAllUserSessions,
  rotateUserApiToken,
  getPersonalApiTokenForUser,
  getUserCapabilities,
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
  discovered: "Phát hiện",
  approved: "Duyệt",
  briefing: "Brief",
  assigned: "Giao việc",
  published: "Đã đăng",
  review: "Đánh giá"
};

export const WORKFLOW_TRANSITION_POLICY = {
  discovered: {
    approved: ["manager"]
  },
  approved: {
    briefing: ["manager", "member"],
    discovered: ["manager"]
  },
  briefing: {
    assigned: ["manager"],
    approved: ["manager"]
  },
  assigned: {
    published: ["manager", "assignee"],
    briefing: ["manager", "assignee"]
  },
  published: {
    review: ["manager", "assignee"],
    assigned: ["manager"]
  },
  review: {
    published: ["manager"]
  }
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

export function ensureDbMigrated(customDb = null) {
  return repoEnsureDbMigrated(customDb);
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
  const minSampleSize = Math.max(3, Number(options.minSampleSize || DEFAULT_MIN_OUTLIER_SAMPLE_SIZE));
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

  // Dynamically compute channelAgeMonths from channel_joined_at if available
  let dynamicAgeMonths = row.channel_age_months;
  let dynamicAgeStatus = row.channel_age_status || "unknown";
  if (row.channel_joined_at && Number.isFinite(Date.parse(row.channel_joined_at))) {
    dynamicAgeMonths = Number(
      Math.max(0.1, (Date.now() - Date.parse(row.channel_joined_at)) / (86_400_000 * 30.4375)).toFixed(1)
    );
    dynamicAgeStatus = row.data_origin === "demo" ? "demo" : "derived";
  }

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
    channelAgeMonths: dynamicAgeMonths,
    channelAgeStatus: dynamicAgeStatus,
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
    viewsOfObservedRecentUploads: row.monthly_views,
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
    watchlistAddedAt: row.watchlist_added_at || "",
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at,
    lastEnrichedAt: row.last_enriched_at,
    videos
  };
}

export function hydrateVideoRow(v) {
  if (!v) return null;
  // T06: Dynamically compute publishedDaysAgo from published_at when available so video age never goes stale
  let dynamicDaysAgo = v.published_days_ago;
  if (v.published_at && Number.isFinite(Date.parse(v.published_at))) {
    dynamicDaysAgo = Math.max(
      0,
      Number(((Date.now() - Date.parse(v.published_at)) / 86_400_000).toFixed(4))
    );
  }
  const dynamicViewsPerDay =
    typeof v.views === "number" &&
    Number.isFinite(v.views) &&
    typeof dynamicDaysAgo === "number" &&
    dynamicDaysAgo >= 0.04
      ? Math.round(v.views / Math.max(0.25, dynamicDaysAgo))
      : v.views_per_day;

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
    publishedDaysAgo: dynamicDaysAgo,
    publishedStatus: v.published_status || "unknown",
    viewsPerDay: dynamicViewsPerDay,
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
function matchesMin(val, minThreshold, allowUnknown = false) {
  const min = Number(minThreshold);
  if (!Number.isFinite(min) || min <= 0) return true;
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return Boolean(allowUnknown);
  }
  return Number(val) >= min;
}

function matchesMax(val, maxThreshold, allowUnknown = false) {
  const max = Number(maxThreshold);
  if (!Number.isFinite(max) || max <= 0) return true;
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return Boolean(allowUnknown);
  }
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
    minOutlierRatio = 0,
    language = "all",
    country = "all",
    discoveryCountry = "all",
    excludeKids = "true",
    trackedOnly = "false",
    includeUnknown = "false",
    // Quality & provenance filters
    dataOrigin = "all", // all | observed | legacy_unverified | demo
    includeDemo = defaultIncludeDemo ? "true" : "false",
    outlierSampleFilter = "all", // all | sufficient | insufficient
    maxFreshnessDays = 0,
    sortBy = "outlier",
    page = 1,
    limit = 50,
    exportAll = false
  } = filters;

  const allowDemo =
    includeDemo === true ||
    includeDemo === "true" ||
    includeDemo === "1" ||
    dataOrigin === "demo";
  const onlyTracked =
    trackedOnly === true || trackedOnly === "true" || trackedOnly === "1";
  const allowUnknown =
    includeUnknown === true || includeUnknown === "true" || includeUnknown === "1";

  // T09: Filter WHERE is_tracked = 1 in SQL before hydrating or slicing
  const rows = onlyTracked
    ? db.prepare("SELECT * FROM channels WHERE is_tracked = 1").all()
    : db.prepare("SELECT * FROM channels").all();

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
    if (!matchesMin(c.subscribers, minSubscribers, allowUnknown)) return false;
    if (!matchesMax(c.subscribers, maxSubscribers, allowUnknown)) return false;
    if (!matchesMin(c.avgViews, minAvgViews, allowUnknown)) return false;
    if (!matchesMax(c.avgViews, maxAvgViews, allowUnknown)) return false;
    if (!matchesMin(c.totalViews, minTotalViews, allowUnknown)) return false;
    if (!matchesMax(c.videoCount ?? c.observedVideoSampleCount, maxVideoCount, allowUnknown)) return false;
    if (!matchesMin(c.avgDurationMinutes, minAvgDurationMinutes, allowUnknown)) return false;
    if (!matchesMin(c.estimatedRpm, minRpm, allowUnknown)) return false;
    if (!matchesMin(c.monthlyRevenueMax, minMonthlyRevenue, allowUnknown)) return false;
    if (
      !matchesMax(
        c.channelAgeMonths ?? (c.oldestObservedVideoDays !== null ? c.oldestObservedVideoDays / 30 : null),
        maxAgeMonths,
        allowUnknown
      )
    ) {
      return false;
    }
    if (!matchesMin(c.uploadFrequencyPerMonth, minUploadFrequency, allowUnknown)) return false;
    if (!matchesMin(c.maxOutlierScore, minOutlierScore, allowUnknown)) return false;
    if (!matchesMin(c.topOutlierRatio, minOutlierRatio, allowUnknown)) return false;
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
    if (sortBy === "medianViews") {
      return numOrNegInf(b.medianViews) - numOrNegInf(a.medianViews);
    }
    if (sortBy === "subscribers") {
      return numOrNegInf(b.subscribers) - numOrNegInf(a.subscribers);
    }
    if (sortBy === "updatedAt") {
      return (Date.parse(b.lastUpdatedAt || "") || 0) - (Date.parse(a.lastUpdatedAt || "") || 0);
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
  const safeLimit = exportAll
    ? Math.max(1, totalCount)
    : Math.min(200, Math.max(1, Number(limit) || 50));
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
    query = "",
    maxDaysAgo = 0,
    maxChannelSubscribers = 0,
    minOutlierRatio = 1.5,
    niche = "all",
    country = "all",
    contentType = "all",
    dataOrigin = "all",
    includeDemo = defaultIncludeDemo ? "true" : "false",
    includeInsufficientSample = "false",
    sortBy = "outlierRatio",
    page = 1,
    limit = 50,
    exportAll = false
  } = filters;

  const allowDemo =
    includeDemo === true || includeDemo === "true" || includeDemo === "1" || dataOrigin === "demo";
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

  const qLower = query && String(query).trim() ? String(query).trim().toLowerCase() : "";
  const outliers = [];
  for (const r of rows) {
    if (!allowDemo && (r.data_origin === "demo" || r.channel_data_origin === "demo")) {
      continue;
    }
    if (dataOrigin !== "all") {
      if (dataOrigin === "observed" || dataOrigin === "verified_only") {
        if (r.data_origin !== "observed") continue;
      } else if (r.data_origin !== dataOrigin) {
        continue;
      }
    }
    if (qLower) {
      const matchText =
        (r.title || "").toLowerCase().includes(qLower) ||
        (r.channel_title || "").toLowerCase().includes(qLower) ||
        (r.channel_handle || "").toLowerCase().includes(qLower) ||
        (r.channel_niche || "").toLowerCase().includes(qLower);
      if (!matchText) continue;
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

    const v = hydrateVideoRow(r);
    if (Number(maxDaysAgo) > 0) {
      if (v.publishedDaysAgo === null || v.publishedDaysAgo === undefined) continue;
      if (v.publishedDaysAgo > Number(maxDaysAgo)) continue;
    }

    if (!allowInsufficient) {
      if (r.outlier_status !== "derived" || r.outlier_ratio === null) continue;
      if (r.outlier_ratio < Number(minOutlierRatio)) continue;
    } else if (Number(minOutlierRatio) > 0 && r.outlier_status === "derived" && r.outlier_ratio !== null) {
      if (r.outlier_ratio < Number(minOutlierRatio)) continue;
    }

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
  const numOrPosInf = (val) => (typeof val === "number" && Number.isFinite(val) ? val : Infinity);
  outliers.sort((a, b) => {
    if (sortBy === "viewsPerDay") return numOrNegInf(b.viewsPerDay) - numOrNegInf(a.viewsPerDay);
    if (sortBy === "views") return numOrNegInf(b.views) - numOrNegInf(a.views);
    if (sortBy === "newest") return numOrPosInf(a.publishedDaysAgo) - numOrPosInf(b.publishedDaysAgo);
    return numOrNegInf(b.outlierRatio) - numOrNegInf(a.outlierRatio);
  });

  const totalCount = outliers.length;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = exportAll
    ? Math.max(1, totalCount)
    : Math.min(200, Math.max(1, Number(limit) || 50));
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
// CHANNEL DETAIL & REAL SNAPSHOT GROWTH TRACKING (T05)
// ============================================================================

export function getChannelGrowthTracking(channelId, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const channelSnapshots = db
    .prepare(
      "SELECT * FROM metric_snapshots WHERE entity_type = 'channel' AND entity_id = ? ORDER BY collected_at ASC, id ASC"
    )
    .all(channelId);

  const videoSnapshots = db
    .prepare(
      "SELECT * FROM metric_snapshots WHERE entity_type = 'video' AND channel_id = ? AND views IS NOT NULL ORDER BY collected_at ASC, id ASC"
    )
    .all(channelId);

  const chVideoCountRow = db
    .prepare(
      "SELECT COUNT(*) AS totalVids, SUM(CASE WHEN views IS NULL THEN 1 ELSE 0 END) AS nullViewVids FROM videos WHERE channel_id = ?"
    )
    .get(channelId);

  // 1. Check if we have >= 2 channel_total_views snapshots with strictly increasing timestamps
  const totalViewsSnaps = channelSnapshots.filter(
    (s) => (s.scope === "channel_total_views" || s.source === "channel_total_views") && s.views !== null
  );
  if (totalViewsSnaps.length >= 2) {
    const first = totalViewsSnaps[0];
    const latest = totalViewsSnaps[totalViewsSnaps.length - 1];
    const t1 = Date.parse(first.collected_at);
    const t2 = Date.parse(latest.collected_at);
    if (Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1) {
      const elapsedDays = (t2 - t1) / 86_400_000;
      const viewsDelta = latest.views - first.views;
      const viewsGrowthPct =
        first.views > 0 ? Number(((viewsDelta / first.views) * 100).toFixed(2)) : null;
      const subscribersDelta =
        latest.subscribers !== null && first.subscribers !== null
          ? latest.subscribers - first.subscribers
          : null;
      const videoCountDelta =
        latest.video_count !== null && first.video_count !== null
          ? latest.video_count - first.video_count
          : null;
      const viewsPerDayVelocity =
        elapsedDays > 0 && viewsDelta >= 0 ? Math.round(viewsDelta / elapsedDays) : null;

      return {
        status: "derived",
        comparable: true,
        scope: "channel_total_views",
        basis: "channel_total_views",
        reason: null,
        snapshotCount: channelSnapshots.length,
        firstSnapshotAt: first.collected_at,
        latestSnapshotAt: latest.collected_at,
        elapsedDays: Number(elapsedDays.toFixed(4)),
        viewsDelta,
        viewsGrowthPct,
        subscribersDelta,
        videoCountDelta,
        viewsPerDayVelocity,
        dailyVelocityDelta: viewsPerDayVelocity,
        anomalyWarning:
          viewsDelta < 0
            ? "Phát hiện tổng lượt xem giảm giữa các snapshot (kênh có thể vừa ẩn hoặc xóa video)."
            : null,
        snapshots: channelSnapshots.slice(-30)
      };
    }
  }

  // 2. Check per-video snapshots over the exact INTERSECTION of video_ids at two distinct timestamps t1 < t2
  const byTimestamp = new Map();
  for (const vs of videoSnapshots) {
    const ts = vs.collected_at;
    if (!byTimestamp.has(ts)) {
      byTimestamp.set(ts, new Map());
    }
    byTimestamp.get(ts).set(vs.entity_id, vs.views);
  }
  const distinctTimestamps = Array.from(byTimestamp.keys()).sort(
    (a, b) => Date.parse(a) - Date.parse(b)
  );

  if (distinctTimestamps.length >= 2) {
    const firstTs = distinctTimestamps[0];
    const latestTs = distinctTimestamps[distinctTimestamps.length - 1];
    const t1 = Date.parse(firstTs);
    const t2 = Date.parse(latestTs);

    if (Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1) {
      const firstMap = byTimestamp.get(firstTs);
      const latestMap = byTimestamp.get(latestTs);
      const commonVideoIds = [];
      for (const vid of firstMap.keys()) {
        if (latestMap.has(vid)) {
          commonVideoIds.push(vid);
        }
      }

      if (commonVideoIds.length > 0) {
        let sumFirst = 0;
        let sumLatest = 0;
        for (const vid of commonVideoIds) {
          sumFirst += firstMap.get(vid);
          sumLatest += latestMap.get(vid);
        }
        const elapsedDays = (t2 - t1) / 86_400_000;
        const viewsDelta = sumLatest - sumFirst;
        const viewsGrowthPct =
          sumFirst > 0 ? Number(((viewsDelta / sumFirst) * 100).toFixed(2)) : null;
        const viewsPerDayVelocity =
          elapsedDays > 0 && viewsDelta >= 0 ? Math.round(viewsDelta / elapsedDays) : null;

        return {
          status: "derived",
          comparable: true,
          scope: "matched_video_cohort",
          basis: "video_cohort_intersection",
          matchedVideoCount: commonVideoIds.length,
          commonVideoCount: commonVideoIds.length,
          reason: `Tính trên tập giao ${commonVideoIds.length} video xuất hiện ở cả hai thời điểm.`,
          snapshotCount: distinctTimestamps.length,
          firstSnapshotAt: firstTs,
          latestSnapshotAt: latestTs,
          elapsedDays: Number(elapsedDays.toFixed(4)),
          viewsDelta,
          viewsGrowthPct,
          subscribersDelta: null,
          videoCountDelta: null,
          viewsPerDayVelocity,
          dailyVelocityDelta: viewsPerDayVelocity,
          anomalyWarning: null,
          snapshots: channelSnapshots.slice(-30)
        };
      }

      return {
        status: "not_comparable",
        comparable: false,
        scope: "disjoint_video_cohort",
        basis: "disjoint_video_cohort",
        reason:
          "Các lần thu thập chưa có tập giao video chung để so sánh tăng trưởng tương đương.",
        snapshotCount: channelSnapshots.length,
        snapshots: channelSnapshots.slice(-30),
        viewsDelta: null,
        viewsGrowthPct: null,
        subscribersDelta: null,
        viewsPerDayVelocity: null,
        dailyVelocityDelta: null,
        anomalyWarning: null
      };
    }
  }

  // 3. Check if channelSnapshots has >= 2 rows with identical non-empty cohort_hash and t2 > t1
  if (channelSnapshots.length >= 2) {
    const first = channelSnapshots[0];
    const latest = channelSnapshots[channelSnapshots.length - 1];
    const t1 = Date.parse(first.collected_at);
    const t2 = Date.parse(latest.collected_at);
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 <= t1) {
      return {
        status: "insufficient_snapshots",
        reason: "Hai snapshot có cùng thời điểm thu thập (t2 <= t1), chưa đủ khoảng thời gian tính tốc độ.",
        snapshotCount: channelSnapshots.length,
        snapshots: channelSnapshots.slice(-30),
        viewsDelta: null,
        viewsGrowthPct: null,
        subscribersDelta: null,
        viewsPerDayVelocity: null,
        dailyVelocityDelta: null,
        anomalyWarning: null
      };
    }
    if (first.cohort_hash !== latest.cohort_hash || first.views === null || latest.views === null) {
      return {
        status: "not_comparable",
        reason: "Tập mẫu video giữa hai lần thu thập không đồng nhất, không cộng dồn lệch mẫu.",
        snapshotCount: channelSnapshots.length,
        snapshots: channelSnapshots.slice(-30),
        viewsDelta: null,
        viewsGrowthPct: null,
        subscribersDelta: null,
        viewsPerDayVelocity: null,
        dailyVelocityDelta: null,
        anomalyWarning: null
      };
    }
  }

  // If channel has videos with null views alongside a later crawl so cohorts couldn't be compared
  if (
    channelSnapshots.length === 1 &&
    chVideoCountRow &&
    chVideoCountRow.totalVids >= 2 &&
    chVideoCountRow.nullViewVids >= 1
  ) {
    return {
      status: "not_comparable",
      reason:
        "Lần thu thập trước thiếu lượt xem thực tế (views = null), không so sánh chênh lệch với video mới.",
      snapshotCount: channelSnapshots.length,
      snapshots: channelSnapshots,
      viewsDelta: null,
      viewsGrowthPct: null,
      subscribersDelta: null,
      viewsPerDayVelocity: null,
      dailyVelocityDelta: null,
      anomalyWarning: null
    };
  }

  return {
    status: "insufficient_snapshots",
    reason: `Đang tích lũy dữ liệu lịch sử (hiện có ${channelSnapshots.length}/2 snapshot tối thiểu ở hai thời điểm khác nhau).`,
    snapshotCount: channelSnapshots.length,
    snapshots: channelSnapshots,
    viewsDelta: null,
    viewsGrowthPct: null,
    subscribersDelta: null,
    viewsPerDayVelocity: null,
    dailyVelocityDelta: null,
    anomalyWarning: null
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
      visualCue: "B-roll đối lập tốc độ cao + hiệu ứng âm thanh trầm (sub-drop) + tiêu đề nổi bật.",
      directive: "B-roll đối lập tốc độ cao + hiệu ứng âm thanh trầm (sub-drop) + tiêu đề nổi bật."
    },
    {
      phase: "Context & Stakes (0:40 - 3:00)",
      objective: `Đặt bối cảnh ngách ${niche} và giải thích vì sao cách hiểu thông thường bị sai lệch.`,
      visualCue: "Bản đồ/biểu đồ hoặc timeline 3D, đổi góc nhìn mỗi 35-45 giây.",
      directive: "Bản đồ/biểu đồ hoặc timeline 3D, đổi góc nhìn mỗi 35-45 giây."
    },
    {
      phase: "Core Investigation (3:00 - 9:30)",
      objective: "Đi sâu vào 3 bằng chứng hoặc bước ngoặt chính có nguồn kiểm chứng.",
      visualCue: "Tài liệu lưu trữ, số liệu cụ thể trên màn hình, giữ nhịp để mở khóa mid-roll (>8 phút).",
      directive: "Tài liệu lưu trữ, số liệu cụ thể trên màn hình, giữ nhịp để mở khóa mid-roll (>8 phút)."
    },
    {
      phase: "Climax & Retention Bridge (9:30 - End)",
      objective: "Giải đáp câu hỏi mở ở phần Thumbnail/Title và dẫn trực tiếp sang video tiếp theo cùng chủ đề.",
      visualCue: "End-screen định hướng 1 video duy nhất có tỷ lệ giữ chân cao.",
      directive: "End-screen định hướng 1 video duy nhất có tỷ lệ giữ chân cao."
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
            checks: checklist,
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
    checks: checklist,
    suggestedTitles,
    aiCritique: `Điểm Title Readiness đạt ${titleScore}/100 cho ngách ${niche}. Lưu ý: Điểm này chỉ chấm cấu trúc tiêu đề, chưa chấm bố cục ảnh thumbnail.`,
    aiPowered: false
  };
}

// ============================================================================
// TEAM WORKFLOW: SWIPE ITEMS, 6 STAGES & PRODUCTION BRIEF GENERATOR
// ============================================================================

export function setChannelWatchlistState(
  channelId,
  { tracked = undefined, isTracked = undefined, note = undefined, actorUsername = "" } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  const existing = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
  if (!existing) {
    const err = new Error(`Không tìm thấy kênh "${channelId}".`);
    err.statusCode = 404;
    err.code = "CHANNEL_NOT_FOUND";
    throw err;
  }

  const now = new Date().toISOString();
  const desiredBool =
    typeof isTracked === "boolean"
      ? isTracked
      : typeof tracked === "boolean"
        ? tracked
        : true;
  const nextTracked = desiredBool ? 1 : 0;
  const nextNote = note !== undefined ? String(note) : existing.watchlist_note || "";
  const nextAddedBy = nextTracked ? actorUsername || existing.watchlist_added_by || "" : "";
  const nextAddedAt = nextTracked ? existing.watchlist_added_at || now : "";

  db.prepare(`
    UPDATE channels SET
      is_tracked = ?,
      watchlist_note = ?,
      watchlist_added_by = ?,
      watchlist_added_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(nextTracked, nextNote, nextAddedBy, nextAddedAt, now, channelId);

  const trackedChannelIds = db
    .prepare("SELECT id FROM channels WHERE is_tracked = 1")
    .all()
    .map((r) => r.id);

  return {
    ok: true,
    channelId,
    tracked: Boolean(nextTracked),
    isTracked: Boolean(nextTracked),
    notes: nextNote,
    watchlistNote: nextNote,
    watchlistAddedBy: nextAddedBy,
    watchlistAddedAt: nextAddedAt,
    trackedChannelIds
  };
}

export function toggleChannelWatchlist(
  channelId,
  { tracked = undefined, isTracked = undefined, note = undefined, actorUsername = "" } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  const existing = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
  if (!existing) {
    const err = new Error(`Không tìm thấy kênh "${channelId}".`);
    err.statusCode = 404;
    err.code = "CHANNEL_NOT_FOUND";
    throw err;
  }

  const explicitBool =
    typeof isTracked === "boolean"
      ? isTracked
      : typeof tracked === "boolean"
        ? tracked
        : undefined;
  const desiredTracked =
    typeof explicitBool === "boolean" ? explicitBool : !Boolean(existing.is_tracked);
  return setChannelWatchlistState(
    channelId,
    { tracked: desiredTracked, isTracked: desiredTracked, note, actorUsername },
    db
  );
}

export function getWorkActivity(swipeItemId, customDb = null) {
  const db = ensureDbMigrated(customDb);
  return db
    .prepare("SELECT * FROM work_activity WHERE swipe_item_id = ? ORDER BY created_at DESC, id DESC LIMIT 50")
    .all(String(swipeItemId || ""))
    .map((r) => {
      const before = r.before_json ? JSON.parse(r.before_json) : null;
      const after = r.after_json ? JSON.parse(r.after_json) : null;
      return {
        id: r.id,
        swipeItemId: r.swipe_item_id,
        actorUserId: r.actor_user_id || null,
        actorUsername: r.actor_username,
        actorRole: r.actor_username === "admin" ? "manager" : "member",
        action: r.action,
        fromStage: before?.workflowStage || null,
        toStage: after?.workflowStage || null,
        before,
        after,
        note: r.note || "",
        createdAt: r.created_at
      };
    });
}

export function getBriefRevisions(swipeItemId, customDb = null) {
  const db = ensureDbMigrated(customDb);
  return db
    .prepare(
      "SELECT * FROM brief_revisions WHERE swipe_item_id = ? ORDER BY revision_number DESC, id DESC LIMIT 30"
    )
    .all(String(swipeItemId || ""))
    .map((r) => ({
      id: r.id,
      swipeItemId: r.swipe_item_id,
      revisionNumber: r.revision_number,
      source: r.source,
      status: r.status,
      briefMarkdown: r.brief_markdown,
      createdBy: r.created_by,
      createdAt: r.created_at
    }));
}

function hydrateSwipeRow(r, db) {
  let tags = [];
  try {
    tags = JSON.parse(r.tags_json || "[]");
  } catch { /* ignore */ }
  const normStage = normalizeWorkflowStage(r.workflow_stage);
  const resultUrl = validateHttpUrl(r.result_url || r.published_video_url) || "";
  const activityList = db ? getWorkActivity(r.id, db) : [];
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
    briefStatus: r.brief_status || (r.brief_markdown ? "user_edited" : "empty"),
    tags,
    notes: r.notes || "",
    source: r.source || "manual",
    dataOrigin: r.data_origin || "observed",
    metricsSourceStatus: r.metrics_source_status || "unknown",
    metricsAsOf: r.metrics_as_of || null,
    revision: Number(r.revision || 1),
    archivedAt: r.archived_at || null,
    approvedBy: r.approved_by || "",
    approvedAt: r.approved_at || "",
    createdBy: r.created_by || "",
    updatedBy: r.updated_by || "",
    savedAt: r.saved_at,
    updatedAt: r.updated_at,
    briefRevisions: db ? getBriefRevisions(r.id, db) : [],
    activity: activityList,
    activityLog: activityList
  };
}

export function getSwipeItemById(id, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const row = db.prepare("SELECT * FROM swipe_items WHERE id = ?").get(String(id || ""));
  if (!row) return null;
  return hydrateSwipeRow(row, db);
}

export function getSwipeData(
  {
    folderId = "all",
    stage = "all",
    assignee = "all",
    includeDemo = undefined,
    includeArchived = false
  } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  const defaultIncludeDemo = Boolean(getAppSetting(db, "includeDemo", false));
  const allowDemo =
    includeDemo === undefined
      ? defaultIncludeDemo
      : includeDemo === true || includeDemo === "true" || includeDemo === "1";

  const folders = db
    .prepare("SELECT * FROM swipe_folders ORDER BY created_at ASC")
    .all();

  let sql = "SELECT * FROM swipe_items WHERE 1=1";
  const params = [];
  if (!includeArchived) {
    sql += " AND archived_at IS NULL";
  }
  if (!allowDemo) {
    sql += " AND COALESCE(data_origin, 'observed') != 'demo'";
  }
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
  const items = rows.map((r) => hydrateSwipeRow(r, db));

  return {
    folders,
    items,
    workflowStages: SWIPE_WORKFLOW_STAGES,
    workflowStageLabels: SWIPE_WORKFLOW_STAGE_LABELS
  };
}

function resolveAssigneeFields(db, rawAssigneeId, rawOwnerLabel) {
  let assigneeId = String(rawAssigneeId || "").trim();
  let ownerLabel = String(rawOwnerLabel || "").trim();

  if (assigneeId) {
    const userRow = db
      .prepare(
        "SELECT id, username, display_name FROM users WHERE (id = ? OR LOWER(username) = ?) AND is_active = 1"
      )
      .get(assigneeId, assigneeId.toLowerCase());
    if (userRow) {
      assigneeId = userRow.id;
      if (!ownerLabel) ownerLabel = userRow.display_name || userRow.username;
    }
  } else if (ownerLabel) {
    const userRow = db
      .prepare(
        "SELECT id, username, display_name FROM users WHERE (LOWER(username) = ? OR LOWER(display_name) = ?) AND is_active = 1"
      )
      .get(ownerLabel.toLowerCase(), ownerLabel.toLowerCase());
    if (userRow) {
      assigneeId = userRow.id;
      ownerLabel = userRow.display_name || userRow.username;
    }
  }

  return { assigneeId, ownerLabel };
}

export function createSwipeItem(payload = {}, customDb = null, actor = null) {
  const db = ensureDbMigrated(customDb);
  const title = String(payload.title || "").trim();
  if (!title) {
    const err = new Error("Tiêu đề (title) không được để trống khi lưu vào thư viện ý tưởng.");
    err.statusCode = 400;
    err.code = "MISSING_TITLE";
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

  // T02: Creating a new item ALWAYS starts at 'discovered'! Never jump straight to 'published' or 'approved'.
  const stage = "discovered";
  const resultUrl = validateHttpUrl(payload.resultUrl || payload.publishedVideoUrl) || "";

  // Derive honest metrics & dataOrigin from DB if video/channel exists
  const dbVideo = videoId
    ? db.prepare("SELECT * FROM videos WHERE video_id = ?").get(videoId)
    : null;
  const dbChannel =
    channelId
      ? db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId)
      : dbVideo?.channel_id
        ? db.prepare("SELECT * FROM channels WHERE id = ?").get(dbVideo.channel_id)
        : null;

  let itemDataOrigin = "observed";
  if (
    payload.dataOrigin === "demo" ||
    dbVideo?.data_origin === "demo" ||
    dbChannel?.data_origin === "demo"
  ) {
    itemDataOrigin = "demo";
  } else if (
    payload.dataOrigin === "legacy_unverified" ||
    dbVideo?.data_origin === "legacy_unverified" ||
    dbChannel?.data_origin === "legacy_unverified"
  ) {
    itemDataOrigin = "legacy_unverified";
  }

  // T04: Only store outlierRatio as 'derived' if backed by DB derived baseline; otherwise mark as 'user_supplied' or null
  let resolvedOutlierRatio = null;
  let metricsSourceStatus = "unknown";
  if (dbVideo && dbVideo.outlier_status === "derived" && typeof dbVideo.outlier_ratio === "number") {
    resolvedOutlierRatio = dbVideo.outlier_ratio;
    metricsSourceStatus = "derived";
  } else if (typeof payload.outlierRatio === "number" && Number.isFinite(payload.outlierRatio)) {
    resolvedOutlierRatio = payload.outlierRatio;
    metricsSourceStatus = "user_supplied";
  }

  const resolvedViews =
    dbVideo && typeof dbVideo.views === "number"
      ? dbVideo.views
      : typeof payload.views === "number" && Number.isFinite(payload.views)
        ? Math.round(payload.views)
        : null;

  const resolvedRpm =
    dbChannel && typeof dbChannel.estimated_rpm === "number"
      ? dbChannel.estimated_rpm
      : typeof payload.estimatedRpm === "number" && Number.isFinite(payload.estimatedRpm)
        ? payload.estimatedRpm
        : null;

  const tags = Array.isArray(payload.tags)
    ? payload.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(payload.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

  // Only managers can assign someone else on creation; if member creates, keep assignee empty unless self
  const isManager = !actor || actor.role === "manager";
  const resolvedAssignee = isManager
    ? resolveAssigneeFields(db, payload.assigneeId, payload.ownerLabel || payload.assigneeName)
    : { assigneeId: "", ownerLabel: "" };

  const actorUsername = actor?.username || String(payload.createdBy || "system");
  const briefMarkdown = String(payload.briefMarkdown || "");
  const briefStatus = briefMarkdown.trim() ? "user_edited" : "empty";

  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO swipe_items (
        id, folder_id, type, video_id, channel_id, canonical_url,
        title, channel_title, channel_handle, thumbnail_url,
        outlier_ratio, views, estimated_rpm,
        workflow_stage, assignee_id, owner_label, deadline, result_url, published_video_url,
        brief_markdown, brief_status, tags_json, notes, source,
        data_origin, metrics_source_status, metrics_as_of,
        revision, created_by, updated_by, saved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id,
      payload.folderId || "folder-outliers",
      payload.type || "video",
      videoId,
      channelId || dbVideo?.channel_id || null,
      canonicalUrl,
      title,
      String(payload.channelTitle || dbChannel?.title || "").trim(),
      String(payload.channelHandle || dbChannel?.handle || "").trim(),
      thumbnailUrl,
      resolvedOutlierRatio,
      resolvedViews,
      resolvedRpm,
      stage,
      resolvedAssignee.assigneeId,
      resolvedAssignee.ownerLabel,
      isManager ? String(payload.deadline || "").trim() : "",
      resultUrl,
      resultUrl,
      briefMarkdown,
      briefStatus,
      JSON.stringify(tags),
      String(payload.notes || ""),
      String(payload.source || "manual"),
      itemDataOrigin,
      metricsSourceStatus,
      dbVideo?.collected_at || now,
      actorUsername,
      actorUsername,
      now,
      now
    );

    if (briefMarkdown.trim()) {
      db.prepare(`
        INSERT INTO brief_revisions (
          swipe_item_id, revision_number, source, status, brief_markdown, created_by, created_at
        ) VALUES (?, 1, 'user_edit', 'user_edited', ?, ?, ?)
      `).run(id, briefMarkdown, actorUsername, now);
    }

    db.prepare(`
      INSERT INTO work_activity (
        swipe_item_id, actor_user_id, actor_username, action, before_json, after_json, note, created_at
      ) VALUES (?, ?, ?, 'created', NULL, ?, ?, ?)
    `).run(
      id,
      actor?.id || null,
      actorUsername,
      JSON.stringify({ workflowStage: stage, title }),
      "Lưu ý tưởng mới vào thư viện",
      now
    );
  });

  return getSwipeItemById(id, db);
}

function isActorAssigneeOrCreator(existing, actor) {
  if (!actor) return true;
  if (actor.role === "manager") return true;
  const uId = String(actor.id || "");
  const uName = String(actor.username || "").toLowerCase();
  const uDisplay = String(actor.displayName || "").toLowerCase();

  if (existing.assignee_id && existing.assignee_id === uId) return true;
  if (
    existing.owner_label &&
    (existing.owner_label.toLowerCase() === uName ||
      existing.owner_label.toLowerCase() === uDisplay)
  ) {
    return true;
  }
  if (existing.created_by && existing.created_by.toLowerCase() === uName) {
    return true;
  }
  return false;
}

export function updateSwipeItem(id, patch = {}, customDb = null, actor = null) {
  const db = ensureDbMigrated(customDb);
  const existing = db.prepare("SELECT * FROM swipe_items WHERE id = ?").get(id);
  if (!existing) {
    const err = new Error(`Không tìm thấy ý tưởng/công việc "${id}".`);
    err.statusCode = 404;
    err.code = "SWIPE_ITEM_NOT_FOUND";
    throw err;
  }

  // T08: Optimistic Concurrency Check (expectedRevision)
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== null) {
    const expectedRev = Number(patch.expectedRevision);
    const currentRev = Number(existing.revision || 1);
    if (Number.isFinite(expectedRev) && expectedRev !== currentRev) {
      const latestItem = getSwipeItemById(id, db);
      const err = new Error(
        `Công việc này vừa được cập nhật bởi thành viên khác (revision hiện tại: ${currentRev}, revision gửi lên: ${expectedRev}).`
      );
      err.statusCode = 409;
      err.code = "REVISION_CONFLICT";
      err.currentItem = latestItem;
      err.serverItem = latestItem;
      throw err;
    }
  }

  const fromStage = normalizeWorkflowStage(existing.workflow_stage);
  const toStage =
    patch.workflowStage !== undefined
      ? normalizeWorkflowStage(patch.workflowStage)
      : fromStage;

  const isManager = !actor || actor.role === "manager";
  const isAssigneeOrOwner = isActorAssigneeOrCreator(existing, actor);

  // T02: Server-enforced RBAC on stage transitions & protected fields (never rely on body.enforceRoleCheck!)
  if (actor) {
    // 1. Check stage transition policy
    if (toStage !== fromStage) {
      if (toStage === "approved" && !isManager) {
        const err = new Error("Chỉ Quản lý (Manager) mới có quyền duyệt ý tưởng sang trạng thái Duyệt.");
        err.statusCode = 403;
        err.code = "FORBIDDEN_STAGE_TRANSITION";
        throw err;
      }
      if (toStage === "assigned" && !isManager) {
        const err = new Error("Chỉ Quản lý (Manager) mới có quyền giao việc sản xuất.");
        err.statusCode = 403;
        err.code = "FORBIDDEN_STAGE_TRANSITION";
        throw err;
      }

      if (!isManager) {
        const allowedRoles = WORKFLOW_TRANSITION_POLICY[fromStage]?.[toStage] || [];
        const canMemberTransition =
          allowedRoles.includes("member") ||
          (allowedRoles.includes("assignee") && isAssigneeOrOwner);
        if (!canMemberTransition) {
          const err = new Error(
            `Nhân viên không có quyền chuyển trạng thái từ "${SWIPE_WORKFLOW_STAGE_LABELS[fromStage]}" sang "${SWIPE_WORKFLOW_STAGE_LABELS[toStage]}".`
          );
          err.statusCode = 403;
          err.code = "FORBIDDEN_STAGE_TRANSITION";
          throw err;
        }
      }
    }

    // 2. Check protected assignment fields (assigneeId, ownerLabel, deadline)
    const changingAssignee =
      (patch.assigneeId !== undefined &&
        String(patch.assigneeId).trim() !== String(existing.assignee_id || "")) ||
      (patch.ownerLabel !== undefined &&
        String(patch.ownerLabel).trim() !== String(existing.owner_label || ""));
    const changingDeadline =
      patch.deadline !== undefined &&
      String(patch.deadline).trim() !== String(existing.deadline || "");

    if (!isManager && (changingAssignee || changingDeadline)) {
      const err = new Error(
        "Chỉ Quản lý (Manager) mới có quyền phân công người phụ trách hoặc thay đổi deadline."
      );
      err.statusCode = 403;
      err.code = "FORBIDDEN_FIELD_ASSIGNMENT";
      throw err;
    }

    // 3. In assigned/published/review stages, member can only edit items assigned to them (or created by them)
    if (
      !isManager &&
      ["assigned", "published", "review"].includes(fromStage) &&
      !isAssigneeOrOwner
    ) {
      const err = new Error("Nhân viên chỉ được phép cập nhật công việc được giao cho mình.");
      err.statusCode = 403;
      err.code = "FORBIDDEN_ROLE";
      throw err;
    }
  }

  // Validate resultUrl if provided or if transitioning to 'published'
  const rawResultInput =
    patch.resultUrl !== undefined
      ? patch.resultUrl
      : patch.publishedVideoUrl !== undefined
        ? patch.publishedVideoUrl
        : undefined;

  if (
    rawResultInput !== undefined &&
    String(rawResultInput).trim() !== "" &&
    !validateHttpUrl(rawResultInput)
  ) {
    const err = new Error("Link kết quả (resultUrl) phải là URL http:// hoặc https:// hợp lệ.");
    err.statusCode = 400;
    err.code = "INVALID_RESULT_URL";
    throw err;
  }

  const nextResultUrl =
    rawResultInput !== undefined
      ? validateHttpUrl(rawResultInput) || ""
      : existing.result_url || existing.published_video_url || "";

  // T02: Transitioning to 'published' strictly requires a valid HTTP/HTTPS resultUrl
  if (toStage === "published" && !nextResultUrl) {
    const err = new Error(
      "Bắt buộc phải nhập Link kết quả hợp lệ (http/https) trước khi chuyển sang trạng thái Đã đăng."
    );
    err.statusCode = 400;
    err.code = "MISSING_RESULT_URL";
    throw err;
  }

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

  const resolvedAssignee =
    patch.assigneeId !== undefined || patch.ownerLabel !== undefined
      ? resolveAssigneeFields(
          db,
          patch.assigneeId !== undefined ? patch.assigneeId : existing.assignee_id,
          patch.ownerLabel !== undefined ? patch.ownerLabel : existing.owner_label
        )
      : {
          assigneeId: existing.assignee_id || "",
          ownerLabel: existing.owner_label || ""
        };

  const nextBriefMarkdown =
    patch.briefMarkdown !== undefined ? String(patch.briefMarkdown) : existing.brief_markdown || "";
  const briefChanged =
    patch.briefMarkdown !== undefined && nextBriefMarkdown !== (existing.brief_markdown || "");
  const nextBriefStatus = briefChanged
    ? patch.briefStatus || (nextBriefMarkdown.trim() ? "user_edited" : "empty")
    : existing.brief_status || (nextBriefMarkdown.trim() ? "user_edited" : "empty");

  const nextRevision = Number(existing.revision || 1) + 1;
  const actorUsername = actor?.username || patch.updatedBy || existing.updated_by || "system";
  const now = new Date().toISOString();

  const nextApprovedBy =
    toStage === "approved" && fromStage !== "approved"
      ? actorUsername
      : existing.approved_by || "";
  const nextApprovedAt =
    toStage === "approved" && fromStage !== "approved"
      ? now
      : existing.approved_at || "";

  withTransaction(db, () => {
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
        brief_status = ?,
        tags_json = ?,
        notes = ?,
        revision = ?,
        approved_by = ?,
        approved_at = ?,
        updated_by = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.folderId || existing.folder_id,
      patch.title !== undefined ? String(patch.title).trim() : existing.title,
      toStage,
      resolvedAssignee.assigneeId,
      resolvedAssignee.ownerLabel,
      patch.deadline !== undefined ? String(patch.deadline).trim() : existing.deadline || "",
      nextResultUrl,
      nextResultUrl,
      nextBriefMarkdown,
      nextBriefStatus,
      nextTags,
      patch.notes !== undefined ? String(patch.notes) : existing.notes,
      nextRevision,
      nextApprovedBy,
      nextApprovedAt,
      actorUsername,
      now,
      id
    );

    if (briefChanged && nextBriefMarkdown.trim()) {
      const revRow = db
        .prepare(
          "SELECT COALESCE(MAX(revision_number), 0) AS maxRev FROM brief_revisions WHERE swipe_item_id = ?"
        )
        .get(id);
      const nextBriefRevNum = (revRow?.maxRev || 0) + 1;
      db.prepare(`
        INSERT INTO brief_revisions (
          swipe_item_id, revision_number, source, status, brief_markdown, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        nextBriefRevNum,
        patch.briefSource || "user_edit",
        nextBriefStatus,
        nextBriefMarkdown,
        actorUsername,
        now
      );
    }

    const actionType =
      toStage !== fromStage
        ? "stage_transition"
        : briefChanged
          ? "brief_updated"
          : "updated";

    db.prepare(`
      INSERT INTO work_activity (
        swipe_item_id, actor_user_id, actor_username, action, before_json, after_json, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      actor?.id || null,
      actorUsername,
      actionType,
      JSON.stringify({
        workflowStage: fromStage,
        assigneeId: existing.assignee_id,
        ownerLabel: existing.owner_label,
        deadline: existing.deadline,
        resultUrl: existing.result_url,
        revision: existing.revision || 1
      }),
      JSON.stringify({
        workflowStage: toStage,
        assigneeId: resolvedAssignee.assigneeId,
        ownerLabel: resolvedAssignee.ownerLabel,
        deadline: patch.deadline !== undefined ? patch.deadline : existing.deadline,
        resultUrl: nextResultUrl,
        revision: nextRevision
      }),
      String(patch.transitionNote || ""),
      now
    );
  });

  return getSwipeItemById(id, db);
}

export function transitionSwipeItem(
  id,
  {
    toStage,
    note = "",
    resultUrl = undefined,
    expectedRevision = undefined,
    ownerLabel = undefined,
    assigneeId = undefined,
    deadline = undefined
  } = {},
  customDb = null,
  actor = null
) {
  if (!toStage) {
    const err = new Error("Thiếu trạng thái đích (toStage).");
    err.statusCode = 400;
    err.code = "MISSING_TARGET_STAGE";
    throw err;
  }
  return updateSwipeItem(
    id,
    {
      workflowStage: toStage,
      transitionNote: note,
      ...(resultUrl !== undefined ? { resultUrl } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(ownerLabel !== undefined ? { ownerLabel } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(deadline !== undefined ? { deadline } : {})
    },
    customDb,
    actor
  );
}

export function deleteSwipeItem(id, customDb = null, actor = null) {
  const db = ensureDbMigrated(customDb);
  const existing = db.prepare("SELECT * FROM swipe_items WHERE id = ?").get(id);
  if (!existing) {
    return { deleted: false, deletedId: id };
  }

  if (actor && actor.role !== "manager") {
    const isOwnDiscovered =
      normalizeWorkflowStage(existing.workflow_stage) === "discovered" &&
      existing.created_by &&
      existing.created_by.toLowerCase() === String(actor.username || "").toLowerCase();
    if (!isOwnDiscovered) {
      const err = new Error(
        "Chỉ Quản lý (Manager) mới có quyền xóa ý tưởng của người khác hoặc công việc đã vào luồng sản xuất."
      );
      err.statusCode = 403;
      err.code = "FORBIDDEN_ROLE";
      throw err;
    }
  }

  const info = db.prepare("DELETE FROM swipe_items WHERE id = ?").run(id);
  return { deleted: info.changes > 0, deletedId: id };
}

/**
 * T08: Generates a template production brief (status = 'template_draft').
 * Preserves existing user-edited briefs in brief_revisions and does NOT overwrite active brief_markdown
 * unless the active brief is empty OR `overwrite === true` is explicitly passed!
 */
export function generateSwipeProductionBrief(
  id,
  optionsOrDb = {},
  maybeDbOrOptions = null,
  actor = null
) {
  const isSecondArgDb =
    optionsOrDb && typeof optionsOrDb.prepare === "function";
  const options = isSecondArgDb
    ? maybeDbOrOptions && typeof maybeDbOrOptions === "object" && typeof maybeDbOrOptions.prepare !== "function"
      ? maybeDbOrOptions
      : {}
    : optionsOrDb || {};
  const customDb = isSecondArgDb ? optionsOrDb : maybeDbOrOptions;
  const resolvedActor = actor || options.actor || null;
  const db = ensureDbMigrated(customDb);

  const item = getSwipeItemById(id, db);
  if (!item) {
    const err = new Error(`Không tìm thấy ý tưởng/công việc "${id}".`);
    err.statusCode = 404;
    err.code = "SWIPE_ITEM_NOT_FOUND";
    throw err;
  }

  const generatedBriefMarkdown = `# Production Brief: ${item.title}

> **Trạng thái tài liệu**: \`template_draft\` (Bản nháp tạo từ khung mẫu metadata — cần biên tập viên kiểm chứng trước khi sản xuất)

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

  const hasExistingBrief = Boolean(item.briefMarkdown && item.briefMarkdown.trim().length > 0);
  const shouldOverwrite = !hasExistingBrief || options.overwrite === true;
  const actorUsername = resolvedActor?.username || "system";
  const now = new Date().toISOString();

  if (!shouldOverwrite) {
    // Save generated template as a new revision in brief_revisions without overwriting active brief_markdown!
    const revRow = db
      .prepare(
        "SELECT COALESCE(MAX(revision_number), 0) AS maxRev FROM brief_revisions WHERE swipe_item_id = ?"
      )
      .get(id);
    const nextRevNum = (revRow?.maxRev || 0) + 1;
    db.prepare(`
      INSERT INTO brief_revisions (
        swipe_item_id, revision_number, source, status, brief_markdown, created_by, created_at
      ) VALUES (?, ?, 'template_generator', 'template_draft', ?, ?, ?)
    `).run(id, nextRevNum, generatedBriefMarkdown, actorUsername, now);

    const updatedItem = getSwipeItemById(id, db);
    return {
      ...updatedItem,
      briefPreserved: true,
      overwriteRequired: true,
      generatedDraftMarkdown: generatedBriefMarkdown,
      generatedDraftStatus: "template_draft"
    };
  }

  const nextStage =
    item.workflowStage === "discovered" || item.workflowStage === "approved"
      ? "briefing"
      : item.workflowStage;

  return updateSwipeItem(
    id,
    {
      briefMarkdown: generatedBriefMarkdown,
      briefStatus: "template_draft",
      briefSource: "template_generator",
      workflowStage: nextStage,
      transitionNote: "Tạo bản nháp Brief từ mẫu (template_draft)"
    },
    db,
    resolvedActor
  );
}

// ============================================================================
// TEAM WORKFLOW: BULK IMPORT & SHORTLIST EXPORT (CSV / JSON)
// ============================================================================

const VALID_YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com"
]);
const VALID_YOUTU_BE_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

export function parseImportLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return { valid: false, reason: "empty" };

  // Check URL patterns with strict exact hostname allowlist (T10: rejects notyoutube.com!)
  if (/^https?:\/\//i.test(line)) {
    try {
      const u = new URL(line);
      const rawHost = u.hostname.toLowerCase();
      if (VALID_YOUTU_BE_HOSTS.has(rawHost)) {
        const vid = u.pathname.replace(/^\//, "").split("/")[0];
        if (/^[a-zA-Z0-9_-]{6,15}$/.test(vid)) {
          return {
            valid: true,
            type: "video",
            id: vid,
            canonicalUrl: `https://www.youtube.com/watch?v=${vid}`,
            normalizedKey: `video:${vid}`,
            raw: line
          };
        }
      }
      if (VALID_YOUTUBE_HOSTS.has(rawHost)) {
        const vParam = u.searchParams.get("v");
        if (vParam && /^[a-zA-Z0-9_-]{6,15}$/.test(vParam)) {
          return {
            valid: true,
            type: "video",
            id: vParam,
            canonicalUrl: `https://www.youtube.com/watch?v=${vParam}`,
            normalizedKey: `video:${vParam}`,
            raw: line
          };
        }
        const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{6,15})/);
        if (shortsMatch) {
          return {
            valid: true,
            type: "video",
            id: shortsMatch[1],
            canonicalUrl: `https://www.youtube.com/shorts/${shortsMatch[1]}`,
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
            canonicalUrl: `https://www.youtube.com/channel/${channelMatch[1]}`,
            normalizedKey: `channel:${channelMatch[1]}`,
            raw: line
          };
        }
        const handleMatch = u.pathname.match(/^\/(@[a-zA-Z0-9_.-]{2,})/);
        if (handleMatch) {
          const h = handleMatch[1].toLowerCase();
          return {
            valid: true,
            type: "handle",
            id: h,
            canonicalUrl: `https://www.youtube.com/${h}`,
            normalizedKey: `handle:${h}`,
            raw: line
          };
        }
      }
      return { valid: false, reason: "URL không thuộc tên miền YouTube hợp lệ", raw: line };
    } catch {
      return { valid: false, reason: "URL sai định dạng", raw: line };
    }
  }

  // Direct handle @...
  if (/^@[a-zA-Z0-9_.-]{2,50}$/.test(line)) {
    const h = line.toLowerCase();
    return {
      valid: true,
      type: "handle",
      id: h,
      canonicalUrl: `https://www.youtube.com/${h}`,
      normalizedKey: `handle:${h}`,
      raw: line
    };
  }

  // Direct channel ID UC...
  if (/^UC[a-zA-Z0-9_-]{10,40}$/.test(line)) {
    return {
      valid: true,
      type: "channel_id",
      id: line,
      canonicalUrl: `https://www.youtube.com/channel/${line}`,
      normalizedKey: `channel:${line}`,
      raw: line
    };
  }

  // Direct 11-char videoId
  if (/^[a-zA-Z0-9_-]{11}$/.test(line)) {
    return {
      valid: true,
      type: "video",
      id: line,
      canonicalUrl: `https://www.youtube.com/watch?v=${line}`,
      normalizedKey: `video:${line}`,
      raw: line
    };
  }

  return {
    valid: false,
    reason: "Không nhận diện được định dạng (@handle, UC... channelId, hoặc URL YouTube)",
    raw: line
  };
}

export function getImportTargets(customDb = null, { status = "all", limit = 100 } = {}) {
  const db = ensureDbMigrated(customDb);
  const safeLimit = Math.min(500, Math.max(1, Number(limit || 100)));
  const rows =
    status && status !== "all"
      ? db
          .prepare("SELECT * FROM import_targets WHERE status = ? ORDER BY created_at DESC LIMIT ?")
          .all(status, safeLimit)
      : db
          .prepare("SELECT * FROM import_targets ORDER BY created_at DESC LIMIT ?")
          .all(safeLimit);
  return rows.map((r) => ({
    id: r.id,
    rawInput: r.raw_input,
    normalizedValue: r.canonical_url || r.raw_input,
    kind: r.target_type,
    targetType: r.target_type,
    canonicalUrl: r.canonical_url,
    resolvedChannelId: r.resolved_channel_id,
    resolvedVideoId: r.resolved_video_id,
    status: r.status,
    reason: r.reason,
    requestedBy: r.requested_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at
  }));
}

/**
 * T10: Bulk Import with internal UUIDs (`imp_<uuid>`) in `import_targets`.
 * NEVER fabricates `UC_IMPORT_...` channels with `data_origin = 'observed'`!
 */
export function bulkImportTargets(rawLinesInput, customDb = null, actor = null) {
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
  let resolvedCount = 0;
  let queuedCount = 0;
  const now = new Date().toISOString();
  const requestedBy = actor?.username || "system";

  const insertImportTarget = db.prepare(`
    INSERT INTO import_targets (
      id, raw_input, target_type, canonical_url, resolved_channel_id, resolved_video_id,
      status, reason, requested_by, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of validItems) {
    const impId = `imp_${crypto.randomUUID()}`;
    if (item.type === "channel_id" || item.type === "handle") {
      // Check exact match only (do not fuzzy-match unrelated channels)
      const exactRow =
        item.type === "channel_id"
          ? db.prepare("SELECT * FROM channels WHERE id = ?").get(item.id)
          : db.prepare("SELECT * FROM channels WHERE LOWER(handle) = ?").get(item.id.toLowerCase());

      if (exactRow) {
        resolvedCount += 1;
        setChannelWatchlistState(
          exactRow.id,
          { tracked: true, actorUsername: requestedBy },
          db
        );
        insertImportTarget.run(
          impId,
          item.raw,
          item.type,
          item.canonicalUrl,
          exactRow.id,
          null,
          "resolved",
          "Đã khớp kênh trong cơ sở dữ liệu và thêm vào Watchlist.",
          requestedBy,
          now,
          now
        );
        importedResults.push({
          importTargetId: impId,
          input: item.raw,
          type: item.type,
          status: "matched_existing_and_tracked",
          importStatus: "resolved",
          channelId: exactRow.id,
          title: exactRow.title
        });
      } else {
        queuedCount += 1;
        // T10: Queue in import_targets with status='queued' instead of fabricating UC_IMPORT_... as 'observed'!
        insertImportTarget.run(
          impId,
          item.raw,
          item.type,
          item.canonicalUrl,
          item.type === "channel_id" ? item.id : null,
          null,
          "queued",
          "Đang chờ phân giải metadata thực tế từ YouTube (không tạo UC_IMPORT giả).",
          requestedBy,
          now,
          null
        );
        importedResults.push({
          importTargetId: impId,
          input: item.raw,
          type: item.type,
          status: "queued_for_resolution",
          importStatus: "queued",
          channelId: item.type === "channel_id" ? item.id : null,
          title: item.id
        });
      }
    } else if (item.type === "video") {
      const existingVid = db
        .prepare("SELECT * FROM videos WHERE video_id = ?")
        .get(item.id);
      if (existingVid) resolvedCount += 1;
      else queuedCount += 1;

      const swipeItem = createSwipeItem(
        {
          folderId: "folder-outliers",
          type: "video",
          videoId: item.id,
          channelId: existingVid?.channel_id || null,
          canonicalUrl: item.canonicalUrl || `https://www.youtube.com/watch?v=${item.id}`,
          title: existingVid?.title || `YouTube Video (${item.id})`,
          thumbnailUrl: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          outlierRatio:
            existingVid?.outlier_status === "derived" ? existingVid.outlier_ratio : null,
          views: existingVid?.views ?? null,
          workflowStage: "discovered",
          source: "bulk_import"
        },
        db,
        actor
      );
      insertImportTarget.run(
        impId,
        item.raw,
        "video",
        item.canonicalUrl,
        existingVid?.channel_id || null,
        item.id,
        existingVid ? "resolved" : "queued",
        existingVid
          ? "Đã lưu video vào hộp chờ Ý tưởng."
          : "Đã lưu video vào hộp chờ Ý tưởng (đang chờ thu thập thêm metadata).",
        requestedBy,
        now,
        existingVid ? now : null
      );
      importedResults.push({
        importTargetId: impId,
        input: item.raw,
        type: "video",
        status: existingVid ? "saved_existing_video_to_swipe" : "saved_new_video_to_swipe",
        importStatus: existingVid ? "resolved" : "queued",
        videoId: item.id,
        swipeItemId: swipeItem.id
      });
    }
  }

  return {
    totalLines: rawLines.length,
    totalSubmitted: rawLines.length,
    validCount: validItems.length,
    duplicateCount,
    invalidCount: invalidLines.length,
    rejectedCount: invalidLines.length,
    resolvedCount,
    queuedCount,
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

export function exportShortlist(
  { format = "json", target = "channels", filters = {} } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);

  if (target === "swipe" || target === "ideas" || target === "production") {
    const { items } = getSwipeData(filters, db);
    if (format === "csv") {
      const headers = [
        "id",
        "workflowStage",
        "ownerLabel",
        "deadline",
        "title",
        "videoId",
        "channelId",
        "channelTitle",
        "canonicalUrl",
        "views",
        "outlierRatio",
        "metricsSourceStatus",
        "resultUrl",
        "notes",
        "savedAt"
      ];
      const lines = [
        headers.join(","),
        ...items.map((item) => headers.map((h) => escapeCsvCell(item[h])).join(","))
      ];
      return {
        contentType: "text/csv; charset=utf-8",
        filename: "nexlev-swipe-shortlist.csv",
        body: lines.join("\n")
      };
    }
    return {
      contentType: "application/json; charset=utf-8",
      filename: "nexlev-swipe-shortlist.json",
      body: JSON.stringify(
        { exportedAt: new Date().toISOString(), count: items.length, items },
        null,
        2
      )
    };
  }

  if (target === "videos" || target === "outliers") {
    const { outliers } = queryOutlierVideos({ ...filters, exportAll: true }, db);
    if (format === "csv") {
      const headers = [
        "videoId",
        "title",
        "channelId",
        "channelTitle",
        "contentType",
        "views",
        "viewsStatus",
        "outlierRatio",
        "outlierStatus",
        "baselineMedianViews",
        "baselineSampleSize",
        "publishedDaysAgo",
        "dataOrigin",
        "canonicalUrl"
      ];
      const lines = [
        headers.join(","),
        ...outliers.map((v) => headers.map((h) => escapeCsvCell(v[h])).join(","))
      ];
      return {
        contentType: "text/csv; charset=utf-8",
        filename: "nexlev-videos-shortlist.csv",
        body: lines.join("\n")
      };
    }
    return {
      contentType: "application/json; charset=utf-8",
      filename: "nexlev-videos-shortlist.json",
      body: JSON.stringify(
        { exportedAt: new Date().toISOString(), count: outliers.length, videos: outliers },
        null,
        2
      )
    };
  }

  const effectiveChannelFilters =
    target === "watchlist"
      ? { ...filters, trackedOnly: true, exportAll: true }
      : { ...filters, exportAll: true };
  const { channels } = queryChannels(effectiveChannelFilters, db);
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
      "isTracked",
      "watchlistNote",
      "lastUpdatedAt"
    ];
    const lines = [
      headers.join(","),
      ...channels.map((ch) => headers.map((h) => escapeCsvCell(ch[h])).join(","))
    ];
    return {
      contentType: "text/csv; charset=utf-8",
      filename:
        target === "watchlist" ? "nexlev-watchlist.csv" : "nexlev-channels-shortlist.csv",
      body: lines.join("\n")
    };
  }

  return {
    contentType: "application/json; charset=utf-8",
    filename:
      target === "watchlist" ? "nexlev-watchlist.json" : "nexlev-channels-shortlist.json",
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

export function getBatchExtensionMetrics(
  { videoIds = [], channelIds = [], handles = [] } = {},
  customDb = null
) {
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
        outlierRatio: vRow.outlier_status === "derived" ? vRow.outlier_ratio : null,
        outlierScore: vRow.outlier_status === "derived" ? vRow.outlier_score : null,
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
        topOutlierRatio: ch.outlierStatus === "derived" ? ch.topOutlierRatio : null,
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
    minOutlierSampleSize: Math.max(
      3,
      Number(getAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE)) ||
        DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
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
 * T07: Enforces minOutlierSampleSize >= 3 and recomputes stored channel/video outlier ratios when changed.
 */
export function saveSettingsAndSecrets(body = {}, customDb = null) {
  const db = ensureDbMigrated(customDb);

  if (body.minOutlierSampleSize !== undefined && body.minOutlierSampleSize !== null) {
    const requestedMin = Number(body.minOutlierSampleSize);
    if (!Number.isFinite(requestedMin) || requestedMin < 3) {
      const err = new Error(
        "Ngưỡng mẫu tối thiểu tính Outlier (minOutlierSampleSize) phải từ 3 video trở lên."
      );
      err.statusCode = 400;
      err.code = "INVALID_MIN_SAMPLE_SIZE";
      throw err;
    }
  }

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
  if (body.minOutlierSampleSize !== undefined && Number(body.minOutlierSampleSize) >= 3) {
    const prevMin = Number(
      getAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE)
    );
    const nextMin = Math.round(Number(body.minOutlierSampleSize));
    setAppSetting(db, "minOutlierSampleSize", nextMin);
    if (nextMin !== prevMin) {
      recomputeAllChannelOutliers(db, nextMin);
    }
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
  const { folders: swipeFolders, items: swipeItems } = getSwipeData({ includeDemo: "true" }, db);
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
