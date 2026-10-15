// Honest Multi-Market YouTube Discovery & Channel Enrichment Crawler (Batch 3)
// Separates Discovery Provider (Keyword Search) from Channel Enrichment Provider (Channel Videos + Metadata)
// Persists seed state (crawl_seeds), job lifecycle (crawl_jobs), and schedule in SQLite.

import crypto from "node:crypto";
import { Innertube } from "youtubei.js";
import {
  ensureDbMigrated,
  getAppSetting,
  setAppSetting,
  loadSecrets,
  upsertChannelAndVideos,
  DEFAULT_MIN_OUTLIER_SAMPLE_SIZE
} from "./sqlite-repo.mjs";
import {
  parseCountTextStrict,
  parsePublishedTextStrict,
  parseDurationSecondsStrict,
  classifyVideoContentType
} from "./parsers.mjs";

export const GLOBAL_COUNTRIES = [
  {
    code: "US",
    name: "🇺🇸 United States",
    lang: "en",
    cpmMultiplier: 1.25,
    seeds: [
      "boring history for sleep",
      "3d crime documentary",
      "aviation disaster breakdown",
      "unsolved internet mysteries documentary",
      "carl jung shadow work essay",
      "private equity documentary explained",
      "megaprojects engineering documentary",
      "james webb space documentary",
      "stoicism philosophy for life",
      "cold war espionage documentary",
      "billionaire rise and fall documentary",
      "deep sea creatures documentary",
      "fbi interrogation analysis",
      "medieval peasant daily life",
      "forgotten civilizations documentary",
      "wall street crash documentary"
    ]
  },
  {
    code: "GB",
    name: "🇬🇧 United Kingdom",
    lang: "en",
    cpmMultiplier: 1.05,
    seeds: [
      "british history documentary sleep",
      "financial crisis documentary explained",
      "maritime disaster animation",
      "ancient civilizations documentary",
      "victorian london history documentary",
      "engineering disasters explained"
    ]
  },
  {
    code: "CA",
    name: "🇨🇦 Canada",
    lang: "en",
    cpmMultiplier: 0.98,
    seeds: [
      "geopolitics animated map documentary",
      "true crime forensic 3d",
      "stoicism philosophy essay",
      "arctic expedition disaster documentary",
      "macroeconomics explained simply"
    ]
  },
  {
    code: "AU",
    name: "🇦🇺 Australia",
    lang: "en",
    cpmMultiplier: 1.08,
    seeds: [
      "deep sea mystery documentary",
      "military logistics explained",
      "billionaire empire documentary",
      "aviation black box animation",
      "outback mystery documentary"
    ]
  },
  {
    code: "DE",
    name: "🇩🇪 Germany",
    lang: "de",
    cpmMultiplier: 0.92,
    seeds: [
      "geschichte zum einschlafen doku",
      "kriminalfälle doku 3d",
      "wirtschaft erklärt doku",
      "universum dokumentation deutsch",
      "mittelalter alltag dokumentation",
      "geopolitik karte erklärt"
    ]
  },
  {
    code: "FR",
    name: "🇫🇷 France",
    lang: "fr",
    cpmMultiplier: 0.82,
    seeds: [
      "histoire pour dormir documentaire",
      "affaires criminelles documentaire",
      "géopolitique cartes explicatives",
      "mystères non résolus documentaire",
      "astronomie documentaire espace"
    ]
  },
  {
    code: "ES",
    name: "🇪🇸 Spain & LatAm",
    lang: "es",
    cpmMultiplier: 0.52,
    seeds: [
      "historia para dormir documental",
      "misterios sin resolver documental",
      "geopolitica mapas explicacion",
      "casos criminales 3d documental",
      "astronomia universo documental"
    ]
  },
  {
    code: "IT",
    name: "🇮🇹 Italy",
    lang: "it",
    cpmMultiplier: 0.72,
    seeds: [
      "storia per dormire documentario",
      "misteri irrisolti documentario",
      "geopolitica spiegata mappe",
      "impero romano vita quotidiana"
    ]
  },
  {
    code: "NL",
    name: "🇳🇱 Netherlands",
    lang: "nl",
    cpmMultiplier: 0.95,
    seeds: [
      "geschiedenis documentaire",
      "economie uitgelegd",
      "megaprojects engineering"
    ]
  },
  {
    code: "SE",
    name: "🇸🇪 Sweden & Nordics",
    lang: "en",
    cpmMultiplier: 0.96,
    seeds: [
      "nordic history documentary",
      "scandinavian crime documentary",
      "global finance documentary"
    ]
  },
  {
    code: "CH",
    name: "🇨🇭 Switzerland",
    lang: "de",
    cpmMultiplier: 1.35,
    seeds: [
      "finanzsystem erklärt doku",
      "banken geschichte dokumentation",
      "weltwirtschaft analyse"
    ]
  },
  {
    code: "JP",
    name: "🇯🇵 Japan",
    lang: "ja",
    cpmMultiplier: 0.88,
    seeds: [
      "睡眠用 歴史 解説",
      "未解決事件 解説 ゆっくり",
      "宇宙 科学 ドキュメンタリー",
      "世界経済 地政学 解説",
      "航空事故 解説 アニメーション"
    ]
  },
  {
    code: "KR",
    name: "🇰🇷 South Korea",
    lang: "ko",
    cpmMultiplier: 0.78,
    seeds: [
      "수면용 역사 다큐",
      "미스터리 사건 요약",
      "세계 경제 지정학 분석",
      "우주 과학 다큐멘터리",
      "항공 사고 원인 분석"
    ]
  },
  {
    code: "TW",
    name: "🇹🇼 Taiwan & HK",
    lang: "zh",
    cpmMultiplier: 0.64,
    seeds: [
      "歷史故事 睡眠",
      "懸案 紀錄片",
      "財經 商業解密",
      "地緣政治 分析"
    ]
  },
  {
    code: "VN",
    name: "🇻🇳 Vietnam",
    lang: "vi",
    cpmMultiplier: 0.28,
    seeds: [
      "tóm tắt lịch sử thế giới",
      "hồ sơ vụ án bí ẩn",
      "tài chính vĩ mô giải thích",
      "khám phá vũ trụ khoa học",
      "địa chính trị thế giới",
      "tai nạn hàng không phân tích"
    ]
  },
  {
    code: "BR",
    name: "🇧🇷 Brazil",
    lang: "pt",
    cpmMultiplier: 0.42,
    seeds: [
      "historia para dormir documentario",
      "misterios documentario 3d",
      "geopolitica explicada",
      "desastres aereos documentario",
      "astronomia universo documentario"
    ]
  },
  {
    code: "MX",
    name: "🇲🇽 Mexico",
    lang: "es",
    cpmMultiplier: 0.45,
    seeds: [
      "civilizaciones antiguas documental",
      "finanzas y economia explicada",
      "enigmas de la historia para dormir"
    ]
  },
  {
    code: "IN",
    name: "🇮🇳 India",
    lang: "en",
    cpmMultiplier: 0.32,
    seeds: [
      "geopolitics case study documentary",
      "ancient history documentary",
      "business case study explained",
      "space mission documentary"
    ]
  }
];

const clientCache = new Map();

export async function getCountryInnertube(lang = "en", location = "US") {
  const key = `${lang}_${location}`;
  if (!clientCache.has(key)) {
    const p = Innertube.create({
      lang,
      location,
      retrieve_player: false
    }).catch((err) => {
      clientCache.delete(key);
      throw err;
    });
    clientCache.set(key, p);
  }
  return clientCache.get(key);
}

/**
 * Multilingual Snowball Phrase Extractor
 * Supports Latin, CJK, and Vietnamese characters via Unicode property escapes.
 */
export function extractSnowballPhrase(title = "", lang = "en") {
  const clean = String(title || "")
    .replace(/\[.*?\]|\(.*?\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!clean) return null;

  const stop = new Set([
    "the", "and", "for", "that", "this", "with", "from", "what", "why", "how",
    "was", "were", "are", "you", "your", "about", "into", "over", "after", "before",
    "para", "como", "por", "una", "del", "las", "los", "pour", "dans", "avec",
    "und", "der", "die", "das", "mit", "von", "của", "những", "trong", "được"
  ]);

  const words = clean.split(" ").filter((w) => w.length >= 2 && !stop.has(w));
  if (words.length < 2) return null;

  const suffixByLang = {
    en: "documentary",
    de: "doku",
    fr: "documentaire",
    es: "documental",
    pt: "documentario",
    it: "documentario",
    nl: "documentaire",
    ja: "解説",
    ko: "다큐",
    zh: "紀錄片",
    vi: "phân tích"
  };
  const suffix = suffixByLang[lang] || "documentary";
  return `${words.slice(0, 3).join(" ")} ${suffix}`.trim();
}

// ============================================================================
// SEED SELECTION & PERSISTENCE (SQLite crawl_seeds)
// ============================================================================

export function ensureStaticSeedsRegistered(db, countriesList = GLOBAL_COUNTRIES) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO crawl_seeds (
      seed_key, market_code, language_code, keyword, origin, status, created_at
    ) VALUES (?, ?, ?, ?, 'static', 'pending', ?)
  `);
  for (const c of countriesList) {
    for (const kw of c.seeds || []) {
      stmt.run(`${c.code}:${kw}`, c.code, c.lang, kw, now);
    }
  }
}

/**
 * Selects up to `limit` seeds for a market:
 * 1. Unseen seeds first (`last_success_at IS NULL`), ordered by `attempt_count ASC, created_at ASC`.
 * 2. When all seeds have been crawled (`unseen` exhausted), selects the OLDEST crawled seeds
 *    (`ORDER BY last_success_at ASC, seed_key ASC`) — NEVER repeats the beginning of the array!
 */
export function selectSeedsForMarket(db, marketCode, limit = 3, customKeyword = "") {
  const cleanCustom = String(customKeyword || "").trim();
  if (cleanCustom) {
    const countryMeta = GLOBAL_COUNTRIES.find((c) => c.code === marketCode) || {
      code: marketCode,
      lang: "en"
    };
    const now = new Date().toISOString();
    const seedKey = `${marketCode}:${cleanCustom}`;
    db.prepare(`
      INSERT OR IGNORE INTO crawl_seeds (
        seed_key, market_code, language_code, keyword, origin, status, created_at
      ) VALUES (?, ?, ?, ?, 'custom', 'pending', ?)
    `).run(seedKey, marketCode, countryMeta.lang, cleanCustom, now);

    return db.prepare("SELECT * FROM crawl_seeds WHERE seed_key = ?").all(seedKey);
  }

  ensureStaticSeedsRegistered(db);

  // 1. Unseen seeds (never succeeded yet)
  const unseen = db
    .prepare(
      `SELECT * FROM crawl_seeds
       WHERE market_code = ? AND last_success_at IS NULL
       ORDER BY attempt_count ASC, created_at ASC, seed_key ASC
       LIMIT ?`
    )
    .all(marketCode, limit);

  if (unseen.length >= limit) {
    return unseen;
  }

  // 2. Fill remaining slots with OLDEST successfully crawled seeds
  const remaining = limit - unseen.length;
  const unseenKeys = new Set(unseen.map((s) => s.seed_key));
  const oldestSeen = db
    .prepare(
      `SELECT * FROM crawl_seeds
       WHERE market_code = ? AND last_success_at IS NOT NULL
       ORDER BY last_success_at ASC, seed_key ASC
       LIMIT ?`
    )
    .all(marketCode, remaining + unseen.length)
    .filter((s) => !unseenKeys.has(s.seed_key))
    .slice(0, remaining);

  return [...unseen, ...oldestSeen];
}

export function markSeedAttemptStart(db, seedKey, timestamp = new Date().toISOString()) {
  db.prepare(`
    UPDATE crawl_seeds SET
      status = 'running',
      attempt_count = attempt_count + 1,
      last_attempt_at = ?
    WHERE seed_key = ?
  `).run(timestamp, seedKey);
}

export function markSeedSuccess(
  db,
  seedKey,
  discoveredCount = 0,
  timestamp = new Date().toISOString()
) {
  db.prepare(`
    UPDATE crawl_seeds SET
      status = 'succeeded',
      last_success_at = ?,
      last_error = NULL,
      discovered_channels_count = discovered_channels_count + ?
    WHERE seed_key = ?
  `).run(timestamp, discoveredCount, seedKey);
}

/**
 * When a seed fails, NEVER set last_success_at! Keep last_success_at unchanged so it will be retried.
 */
export function markSeedFailure(
  db,
  seedKey,
  errorMessage = "crawl_failed",
  timestamp = new Date().toISOString()
) {
  db.prepare(`
    UPDATE crawl_seeds SET
      status = 'failed',
      last_attempt_at = ?,
      last_error = ?
    WHERE seed_key = ?
  `).run(timestamp, String(errorMessage || "crawl_failed"), seedKey);
}

// ============================================================================
// PROVIDERS: YOUTUBE DATA API v3 ENRICher + INNERTUBE DISCOVERY/ENRICHER
// ============================================================================

/**
 * Optional Official YouTube Data API v3 Enricher (used automatically when youtubeApiKey is configured)
 */
export async function enrichChannelViaYouTubeDataApi(
  channelId,
  apiKey,
  fetchImpl = globalThis.fetch
) {
  if (!apiKey || !channelId || !channelId.startsWith("UC")) return null;

  try {
    const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${encodeURIComponent(
      channelId
    )}&key=${encodeURIComponent(apiKey)}`;
    const chResp = await fetchImpl(chUrl);
    if (!chResp.ok) return null;
    const chData = await chResp.json();
    const item = chData?.items?.[0];
    if (!item) return null;

    const stats = item.statistics || {};
    const snippet = item.snippet || {};
    const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;

    const observedSubscribers =
      stats.hiddenSubscriberCount || stats.subscriberCount === undefined
        ? null
        : Number(stats.subscriberCount);
    const observedTotalViews =
      stats.viewCount !== undefined ? Number(stats.viewCount) : null;
    const observedVideoCount =
      stats.videoCount !== undefined ? Number(stats.videoCount) : null;
    const observedChannelCountry = snippet.country || null;
    const observedJoinedAt = snippet.publishedAt || null;

    const enrichedVideos = [];
    if (uploadsPlaylistId) {
      const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(
        uploadsPlaylistId
      )}&maxResults=12&key=${encodeURIComponent(apiKey)}`;
      const plResp = await fetchImpl(plUrl);
      if (plResp.ok) {
        const plData = await plResp.json();
        const videoIds = (plData?.items || [])
          .map((x) => x.contentDetails?.videoId)
          .filter(Boolean);

        if (videoIds.length > 0) {
          const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(
            videoIds.join(",")
          )}&key=${encodeURIComponent(apiKey)}`;
          const vResp = await fetchImpl(vUrl);
          if (vResp.ok) {
            const vData = await vResp.json();
            const nowMs = Date.now();
            for (const vItem of vData?.items || []) {
              const vStats = vItem.statistics || {};
              const vSnip = vItem.snippet || {};
              const durParsed = parseDurationSecondsStrict(
                vItem.contentDetails?.duration || ""
              );
              const pubAt = vSnip.publishedAt || null;
              const pubDays = pubAt
                ? Number(Math.max(0.04, (nowMs - Date.parse(pubAt)) / 86_400_000).toFixed(2))
                : null;
              const cType = classifyVideoContentType({
                durationSeconds: durParsed.seconds,
                title: vSnip.title || ""
              });

              enrichedVideos.push({
                videoId: vItem.id,
                title: vSnip.title || "",
                description: vSnip.description || "",
                thumbnailUrl:
                  vSnip.thumbnails?.high?.url ||
                  vSnip.thumbnails?.medium?.url ||
                  `https://i.ytimg.com/vi/${vItem.id}/hqdefault.jpg`,
                canonicalUrl: `https://www.youtube.com/watch?v=${vItem.id}`,
                contentType: typeof cType === "string" ? cType : cType?.contentType || "unknown",
                views:
                  vStats.viewCount !== undefined ? Number(vStats.viewCount) : null,
                viewsStatus: vStats.viewCount !== undefined ? "observed" : "unknown",
                viewsIsRounded: false,
                likes:
                  vStats.likeCount !== undefined ? Number(vStats.likeCount) : null,
                comments:
                  vStats.commentCount !== undefined ? Number(vStats.commentCount) : null,
                durationSeconds: durParsed.seconds,
                durationMinutes: durParsed.minutes,
                publishedAt: pubAt,
                publishedDaysAgo: pubDays,
                publishedStatus: pubDays !== null ? "observed" : "unknown",
                dataOrigin: "observed",
                source: "youtube_data_api_v3"
              });
            }
          }
        }
      }
    }

    return {
      source: "youtube_data_api_v3",
      title: snippet.title || null,
      handle: snippet.customUrl || null,
      description: snippet.description || "",
      avatarUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null,
      observedSubscribers,
      observedTotalViews,
      observedVideoCount,
      observedChannelCountry,
      observedJoinedAt,
      observedContentLanguage: snippet.defaultAudioLanguage || snippet.defaultLanguage || null,
      videos: enrichedVideos
    };
  } catch {
    return null;
  }
}

/**
 * Converts a raw InnerTube search item into an honest video & author observation.
 * NEVER fabricates views=95000, duration=1080, or publishedDaysAgo=12!
 */
export function parseInnerTubeSearchItem(item, localeHint = "en", collectedAt = new Date().toISOString()) {
  const videoId = item?.id || item?.video_id;
  const title = item?.title?.text || item?.title?.toString?.() || "";
  if (!videoId || !title) return null;

  const authorId = item?.author?.id || null;
  const authorName = item?.author?.name || null;
  const authorHandle = item?.author?.handle || null;
  if (!authorId) return null; // Do not invent fake channel IDs for unattributed items

  const rawViewText =
    item?.view_count?.text ||
    item?.short_view_count?.text ||
    (typeof item?.view_count === "number" ? item.view_count : "");
  const parsedViews = parseCountTextStrict(rawViewText, localeHint);

  const rawDuration =
    typeof item?.duration?.seconds === "number" && item.duration.seconds > 0
      ? item.duration.seconds
      : item?.duration?.text || "";
  const parsedDuration = parseDurationSecondsStrict(rawDuration);

  const rawPubText = item?.published?.text || "";
  const parsedPub = parsePublishedTextStrict(rawPubText, collectedAt);

  const cType = classifyVideoContentType({
    durationSeconds: parsedDuration.seconds,
    title,
    url: item?.endpoint?.metadata?.url || "",
    isLive: Boolean(item?.is_live)
  });

  const thumb =
    item?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    channelId: authorId,
    channelTitle: authorName || "Unknown Channel",
    channelHandle: authorHandle || null,
    avatarUrl: item?.author?.thumbnails?.[0]?.url || thumb,
    video: {
      videoId,
      title,
      thumbnailUrl: thumb,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      contentType: typeof cType === "string" ? cType : cType?.contentType || "unknown",
      views: parsedViews.value,
      viewsStatus: parsedViews.status,
      viewsIsRounded: parsedViews.isRounded,
      likes: null,
      comments: null,
      durationSeconds: parsedDuration.seconds,
      durationMinutes: parsedDuration.minutes,
      publishedAt: parsedPub.publishedAt,
      publishedDaysAgo: parsedPub.publishedDaysAgo,
      publishedStatus: parsedPub.status,
      dataOrigin: "observed",
      source: "youtube_innertube_search",
      collectedAt
    }
  };
}

// ============================================================================
// CRAWLER RUNTIME STATE, PERSISTENT SCHEDULE & JOB LIFECYCLE
// ============================================================================

export const crawlerState = {
  isRunning: false,
  currentJobId: null,
  autoScheduleEnabled: false,
  intervalMinutes: 15,
  lastRunAt: null,
  lastSummary: null,
  totalCrawlsRun: 0,
  cursorIndex: 0
};

let autoTimer = null;

/**
 * Recovers any crawl_jobs left in 'running' state after a process restart.
 */
export function recoverInterruptedCrawlJobs(customDb = null) {
  const db = ensureDbMigrated(customDb);
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE crawl_jobs SET
         status = 'failed',
         error_text = 'interrupted_by_restart',
         completed_at = ?
       WHERE status = 'running'`
    )
    .run(now);
  db.prepare(
    `UPDATE crawl_seeds SET status = 'failed', last_error = 'interrupted_by_restart' WHERE status = 'running'`
  ).run();
  return info.changes;
}

/**
 * Loads persisted schedule from SQLite app_settings and applies it without accidentally enabling disabled timers.
 */
export function syncScheduleFromDb(customDb = null) {
  const db = ensureDbMigrated(customDb);
  const saved = getAppSetting(db, "crawlerSchedule", {
    autoScheduleEnabled: false,
    intervalMinutes: 15
  });
  crawlerState.autoScheduleEnabled = Boolean(saved?.autoScheduleEnabled);
  crawlerState.intervalMinutes = Math.max(1, Number(saved?.intervalMinutes || 15));
  applyScheduleTimer();
  return crawlerState;
}

function applyScheduleTimer() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (!crawlerState.autoScheduleEnabled) {
    return;
  }
  autoTimer = setInterval(async () => {
    if (!crawlerState.autoScheduleEnabled || crawlerState.isRunning) return;
    const countryCodes = GLOBAL_COUNTRIES.map((c) => c.code);
    const slice = [
      countryCodes[crawlerState.cursorIndex % countryCodes.length],
      countryCodes[(crawlerState.cursorIndex + 1) % countryCodes.length]
    ];
    crawlerState.cursorIndex = (crawlerState.cursorIndex + 2) % countryCodes.length;
    try {
      await crawlMultiCountryBatch({
        countries: slice,
        keywordsPerCountry: 2,
        maxChannelsPerKeyword: 5
      });
    } catch {
      // background error recorded in crawl_jobs
    }
  }, crawlerState.intervalMinutes * 60 * 1000);
}

/**
 * Updates crawler schedule settings in SQLite and memory.
 * Sending { autoScheduleEnabled: false, intervalMinutes: 15 } keeps the crawler DISABLED!
 */
export function updateCrawlerSchedule(
  { autoScheduleEnabled, intervalMinutes } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  if (Number(intervalMinutes) > 0) {
    crawlerState.intervalMinutes = Math.max(1, Math.round(Number(intervalMinutes)));
  }
  if (typeof autoScheduleEnabled === "boolean") {
    crawlerState.autoScheduleEnabled = autoScheduleEnabled;
  }

  setAppSetting(db, "crawlerSchedule", {
    autoScheduleEnabled: crawlerState.autoScheduleEnabled,
    intervalMinutes: crawlerState.intervalMinutes
  });

  applyScheduleTimer();
  return { ...crawlerState };
}

export function startBackgroundAutoCrawler(intervalMinutes = 15, enable = false) {
  return updateCrawlerSchedule({
    intervalMinutes,
    autoScheduleEnabled: Boolean(enable)
  });
}

export function cancelCrawlJob(jobId = null, customDb = null) {
  const db = ensureDbMigrated(customDb);
  const targetId = jobId || crawlerState.currentJobId;
  if (!targetId) return { cancelled: false, reason: "no_active_job" };

  db.prepare("UPDATE crawl_jobs SET cancel_requested = 1 WHERE job_id = ?").run(targetId);
  return { cancelled: true, jobId: targetId };
}

export function getCrawlerHealth(customDb = null) {
  const db = ensureDbMigrated(customDb);
  ensureStaticSeedsRegistered(db);

  const seedStats = db
    .prepare(
      `SELECT
         COUNT(*) AS totalSeeds,
         SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS succeededSeeds,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedSeeds,
         SUM(CASE WHEN last_success_at IS NULL THEN 1 ELSE 0 END) AS unseenSeeds
       FROM crawl_seeds`
    )
    .get();

  const recentJobs = db
    .prepare("SELECT * FROM crawl_jobs ORDER BY created_at DESC LIMIT 15")
    .all()
    .map((j) => ({
      jobId: j.job_id,
      jobType: j.job_type,
      status: j.status,
      params: JSON.parse(j.params_json || "{}"),
      progress: JSON.parse(j.progress_json || "{}"),
      summary: JSON.parse(j.summary_json || "{}"),
      errorText: j.error_text,
      requestCount: j.request_count,
      cancelRequested: Boolean(j.cancel_requested),
      startedAt: j.started_at,
      completedAt: j.completed_at,
      createdAt: j.created_at
    }));

  const totalChannelsInDb = db
    .prepare("SELECT COUNT(*) AS c FROM channels WHERE data_origin != 'demo'")
    .get().c;

  return {
    crawlerState,
    seedStats,
    recentJobs,
    countries: GLOBAL_COUNTRIES,
    totalChannelsInDb
  };
}

// ============================================================================
// MULTI-COUNTRY BATCH CRAWLER & LIVE NICHE SCANNER
// ============================================================================

export async function crawlMultiCountryBatch(
  {
    countries = ["ALL"],
    keywordsPerCountry = 2,
    maxChannelsPerKeyword = 5,
    customKeyword = "",
    searchProvider = null, // Injectable for deterministic tests
    enrichmentProvider = null
  } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  ensureStaticSeedsRegistered(db);

  if (crawlerState.isRunning) {
    return {
      alreadyRunning: true,
      jobId: crawlerState.currentJobId,
      crawlerState
    };
  }

  const jobId = `job_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const startedAt = new Date().toISOString();
  crawlerState.isRunning = true;
  crawlerState.currentJobId = jobId;

  const targetCountries = GLOBAL_COUNTRIES.filter((c) =>
    countries.includes("ALL") ? true : countries.includes(c.code)
  );

  const params = {
    countries: targetCountries.map((c) => c.code),
    keywordsPerCountry,
    maxChannelsPerKeyword,
    customKeyword
  };

  db.prepare(`
    INSERT INTO crawl_jobs (
      job_id, job_type, status, params_json, progress_json, request_count, started_at, created_at
    ) VALUES (?, 'multi_country_crawl', 'running', ?, ?, 0, ?, ?)
  `).run(
    jobId,
    JSON.stringify(params),
    JSON.stringify({ seedsCompleted: 0, channelsUpserted: 0 }),
    startedAt,
    startedAt
  );

  let newChannelsCount = 0;
  let updatedChannelsCount = 0;
  let requestCount = 0;
  let seedsSucceeded = 0;
  let seedsFailed = 0;
  const minOutlierSampleSize = Number(
    getAppSetting(db, "minOutlierSampleSize", DEFAULT_MIN_OUTLIER_SAMPLE_SIZE)
  );
  const secrets = loadSecrets();

  try {
    for (const countryMeta of targetCountries) {
      // Check if cancellation was requested
      const jobRow = db
        .prepare("SELECT cancel_requested FROM crawl_jobs WHERE job_id = ?")
        .get(jobId);
      if (jobRow?.cancel_requested) {
        break;
      }

      const seedsToRun = selectSeedsForMarket(
        db,
        countryMeta.code,
        keywordsPerCountry,
        customKeyword
      );

      for (const seedRow of seedsToRun) {
        const checkCancel = db
          .prepare("SELECT cancel_requested FROM crawl_jobs WHERE job_id = ?")
          .get(jobId);
        if (checkCancel?.cancel_requested) break;

        const seedKey = seedRow.seed_key;
        const seedKeyword = seedRow.keyword;
        const attemptAt = new Date().toISOString();
        markSeedAttemptStart(db, seedKey, attemptAt);

        try {
          let rawVideos = [];
          requestCount += 1;

          if (typeof searchProvider === "function") {
            rawVideos = await searchProvider({
              keyword: seedKeyword,
              lang: countryMeta.lang,
              countryCode: countryMeta.code
            });
          } else {
            const yt = await getCountryInnertube(countryMeta.lang, countryMeta.code);
            const search = await yt.search(seedKeyword, { type: "video" });
            rawVideos = (search?.videos || []).slice(0, maxChannelsPerKeyword * 4);
          }

          const byChannel = new Map();
          for (const item of rawVideos) {
            const parsed = parseInnerTubeSearchItem(item, countryMeta.lang, attemptAt);
            if (!parsed) continue;
            if (!byChannel.has(parsed.channelId)) {
              byChannel.set(parsed.channelId, {
                channelId: parsed.channelId,
                title: parsed.channelTitle,
                handle: parsed.channelHandle,
                avatarUrl: parsed.avatarUrl,
                videos: []
              });
            }
            byChannel.get(parsed.channelId).videos.push(parsed.video);
          }

          let channelsForSeed = 0;
          for (const [, chGroup] of byChannel.entries()) {
            const existingBefore = db
              .prepare("SELECT id FROM channels WHERE id = ?")
              .get(chGroup.channelId);

            // Optional enrichment via YouTube Data API v3 or custom enrichmentProvider
            let enriched = null;
            if (typeof enrichmentProvider === "function") {
              enriched = await enrichmentProvider(chGroup.channelId);
            } else if (secrets.youtubeApiKey) {
              requestCount += 1;
              enriched = await enrichChannelViaYouTubeDataApi(
                chGroup.channelId,
                secrets.youtubeApiKey
              );
            }

            const combinedVideos = [
              ...chGroup.videos,
              ...(enriched?.videos || [])
            ];

            const upserted = upsertChannelAndVideos(db, {
              channelId: chGroup.channelId,
              handle: enriched?.handle || chGroup.handle,
              title: enriched?.title || chGroup.title,
              description: enriched?.description || "",
              avatarUrl: enriched?.avatarUrl || chGroup.avatarUrl,
              observedSubscribers: enriched?.observedSubscribers ?? null,
              observedTotalViews: enriched?.observedTotalViews ?? null,
              observedVideoCount: enriched?.observedVideoCount ?? null,
              // CRITICAL: Never assign countryMeta.code as channelCountry! Only use observedChannelCountry!
              observedChannelCountry: enriched?.observedChannelCountry ?? null,
              observedJoinedAt: enriched?.observedJoinedAt ?? null,
              observedContentLanguage: enriched?.observedContentLanguage ?? null,
              discoveryMarket: {
                countryCode: countryMeta.code,
                languageCode: countryMeta.lang,
                seedKeyword,
                source: enriched ? "youtube_data_api_v3" : "youtube_innertube_search"
              },
              videos: combinedVideos,
              dataOrigin: "observed",
              minOutlierSampleSize,
              recordSnapshot: true,
              collectedAt: attemptAt
            });

            // Multilingual Snowball seed expansion from verified outlier videos
            for (const v of upserted.videos || []) {
              if (v.outlierStatus === "derived" && v.outlierRatio >= 3.0) {
                const phrase = extractSnowballPhrase(v.title, countryMeta.lang);
                if (phrase) {
                  db.prepare(`
                    INSERT OR IGNORE INTO crawl_seeds (
                      seed_key, market_code, language_code, keyword, origin, status, created_at
                    ) VALUES (?, ?, ?, ?, 'snowball', 'pending', ?)
                  `).run(
                    `${countryMeta.code}:${phrase}`,
                    countryMeta.code,
                    countryMeta.lang,
                    phrase,
                    attemptAt
                  );
                }
              }
            }

            if (existingBefore) updatedChannelsCount += 1;
            else newChannelsCount += 1;

            channelsForSeed += 1;
            if (channelsForSeed >= maxChannelsPerKeyword) break;
          }

          // Only mark seed as succeeded AFTER all DB transactions for this seed complete!
          markSeedSuccess(db, seedKey, channelsForSeed, new Date().toISOString());
          seedsSucceeded += 1;
        } catch (seedErr) {
          markSeedFailure(db, seedKey, seedErr?.message || "seed_search_failed");
          seedsFailed += 1;
        }
      }
    }

    const completedAt = new Date().toISOString();
    const jobRowAfter = db
      .prepare("SELECT cancel_requested FROM crawl_jobs WHERE job_id = ?")
      .get(jobId);

    const finalStatus = jobRowAfter?.cancel_requested
      ? "cancelled"
      : seedsFailed > 0 && seedsSucceeded === 0
        ? "failed"
        : seedsFailed > 0
          ? "partial"
          : "succeeded";

    const totalChannelsInDb = db
      .prepare("SELECT COUNT(*) AS c FROM channels WHERE data_origin != 'demo'")
      .get().c;

    const summary = {
      jobId,
      status: finalStatus,
      startedAt,
      completedAt,
      countriesCrawled: targetCountries.map((c) => c.code),
      seedsSucceeded,
      seedsFailed,
      requestCount,
      newChannelsCount,
      updatedChannelsCount,
      totalChannelsInDb
    };

    db.prepare(`
      UPDATE crawl_jobs SET
        status = ?,
        summary_json = ?,
        request_count = ?,
        completed_at = ?
      WHERE job_id = ?
    `).run(finalStatus, JSON.stringify(summary), requestCount, completedAt, jobId);

    crawlerState.lastRunAt = completedAt;
    crawlerState.totalCrawlsRun += 1;
    crawlerState.lastSummary = summary;

    return summary;
  } catch (err) {
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE crawl_jobs SET
        status = 'failed',
        error_text = ?,
        request_count = ?,
        completed_at = ?
      WHERE job_id = ?
    `).run(err?.message || "batch_crawl_failed", requestCount, completedAt, jobId);
    throw err;
  } finally {
    crawlerState.isRunning = false;
    crawlerState.currentJobId = null;
  }
}

/**
 * Live Niche Scanner for a specific keyword & market
 */
export async function scanYouTubeNicheLive(
  keyword,
  maxResults = 10,
  { country = "US", searchProvider = null, enrichmentProvider = null } = {},
  customDb = null
) {
  const db = ensureDbMigrated(customDb);
  const cleanKw = String(keyword || "").trim();
  if (!cleanKw) {
    const err = new Error("Từ khóa tìm kiếm (keyword) không được để trống.");
    err.statusCode = 400;
    throw err;
  }

  const targetCountry =
    GLOBAL_COUNTRIES.find((c) => c.code === country)?.code || "US";

  const summary = await crawlMultiCountryBatch(
    {
      countries: [targetCountry],
      keywordsPerCountry: 1,
      maxChannelsPerKeyword: Math.min(25, Math.max(1, Number(maxResults) || 10)),
      customKeyword: cleanKw,
      searchProvider,
      enrichmentProvider
    },
    db
  );

  const matchedRows = db
    .prepare(
      `SELECT * FROM channels
       WHERE discovery_keyword = ? OR LOWER(title) LIKE ?
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(cleanKw, `%${cleanKw.toLowerCase()}%`, maxResults);

  return {
    jobId: summary.jobId,
    status: summary.status,
    source: "youtube-innertube-live",
    keyword: cleanKw,
    market: targetCountry,
    discoveredCount: (summary.newChannelsCount || 0) + (summary.updatedChannelsCount || 0),
    summary,
    channelIds: matchedRows.map((r) => r.id)
  };
}
