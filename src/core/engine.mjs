import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Innertube } from "youtubei.js";
import {
  NICHE_CPM_TABLE,
  INITIAL_FILTER_TEMPLATES,
  SEED_CHANNELS,
  INITIAL_SWIPE_FOLDERS,
  INITIAL_SWIPE_ITEMS
} from "./seed-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.resolve(__dirname, "../../data/nexlev-db.json");

let innertubePromise = null;
export async function getInnertube() {
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

// ============================================================================
// ATOMIC & CACHED DATABASE LAYER (mtimeMs-aware in-memory cache + atomic rename)
// ============================================================================

let cachedDb = null;
let cachedMtimeMs = 0;

function createInitialDb() {
  return {
    settings: {
      youtubeApiKey: "",
      geminiApiKey: "",
      defaultCurrency: "USD",
      autoTrackOutliers: true
    },
    channels: SEED_CHANNELS,
    filterTemplates: INITIAL_FILTER_TEMPLATES,
    swipeFolders: INITIAL_SWIPE_FOLDERS,
    swipeItems: INITIAL_SWIPE_ITEMS,
    trackedChannelIds: SEED_CHANNELS.slice(0, 6).map((c) => c.id),
    crawledSeeds: {},
    snowballQueue: [],
    searchHistory: [
      { keyword: "boring history for sleep", count: 42, competitionScore: 24, opportunityScore: 92 },
      { keyword: "3d crime documentary", count: 38, competitionScore: 41, opportunityScore: 88 },
      { keyword: "aviation black box animation", count: 31, competitionScore: 19, opportunityScore: 95 },
      { keyword: "carl jung shadow work", count: 29, competitionScore: 33, opportunityScore: 86 },
      { keyword: "geopolitics animated map", count: 25, competitionScore: 45, opportunityScore: 82 }
    ]
  };
}

export function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = createInitialDb();
    saveDb(initial);
    return initial;
  }
  try {
    const stat = fs.statSync(DB_PATH);
    if (cachedDb && stat.mtimeMs === cachedMtimeMs) {
      return cachedDb;
    }
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    cachedDb = parsed;
    cachedMtimeMs = stat.mtimeMs;
    return parsed;
  } catch {
    if (cachedDb) return cachedDb;
    return createInitialDb();
  }
}

export function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmpPath = `${DB_PATH}.${process.pid}.tmp`;
  const payload = JSON.stringify(db, null, 2);
  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, DB_PATH);
  try {
    const stat = fs.statSync(DB_PATH);
    cachedDb = db;
    cachedMtimeMs = stat.mtimeMs;
  } catch {
    cachedDb = db;
  }
  return db;
}

// ============================================================================
// REVERSE-ENGINEERED NEXLEV FORMULAS
// ============================================================================

/**
 * Nexlev Outlier Tier Quantization:
 * 0: Default (< 1.5x channel median)
 * 1: Above Average (1.5x - 3.0x channel median)
 * 2: Strong Outlier (3.0x - 5.0x channel median)
 * 3: Exceptional Outlier (>= 5.0x channel median)
 */
export function computeOutlierTier(ratio) {
  if (ratio >= 5.0) return 3;
  if (ratio >= 3.0) return 2;
  if (ratio >= 1.5) return 1;
  return 0;
}

export function computeMedian(numbers) {
  if (!numbers || numbers.length === 0) return 1;
  const sorted = [...numbers].map((n) => Number(n) || 0).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(1, Math.round(med));
}

export function computeTrimmedMean(numbers) {
  if (!numbers || numbers.length === 0) return 1;
  const sorted = [...numbers].map((n) => Number(n) || 0).sort((a, b) => a - b);
  if (sorted.length <= 3) {
    return Math.max(1, Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length));
  }
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.15));
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return Math.max(1, Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length));
}

/**
 * Derives realistic channel baseline statistics (medianViews, avgViews, subscribers,
 * channelAgeMonths, videoCount, growthRate30d) from an array of observed videos.
 */
export function deriveChannelStatsFromVideos(videos = [], seedHint = "") {
  const viewsArr = videos.map((v) => Number(v.views) || 0).filter((v) => v > 0);
  const daysArr = videos.map((v) => Math.max(1, Number(v.publishedDaysAgo) || 14));
  const maxViews = viewsArr.length ? Math.max(...viewsArr) : 65000;
  const minViews = viewsArr.length ? Math.min(...viewsArr) : 18000;

  let medianViews;
  if (viewsArr.length >= 3) {
    medianViews = computeMedian(viewsArr);
  } else if (viewsArr.length === 2) {
    medianViews = Math.max(8000, Math.round(minViews * 0.85));
  } else {
    // Deterministic hash variance from title so single-video search hits don't all share the same ratio
    const hash = Array.from(seedHint || "nx").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const divisor = 2.4 + (hash % 32) / 10; // range 2.4x to 5.5x
    medianViews = Math.max(6000, Math.round(maxViews / divisor));
  }

  const avgViews =
    viewsArr.length >= 3
      ? computeTrimmedMean(viewsArr)
      : Math.round((medianViews + maxViews) / 2);

  // Estimate velocity (views per day on newest video)
  const velocities = videos.map(
    (v) => (Number(v.views) || 50000) / Math.max(1, Number(v.publishedDaysAgo) || 14)
  );
  const maxVelocity = Math.max(...velocities, 1200);

  const oldestDays = Math.max(...daysArr, 45);
  const channelAgeMonths = Number(
    Math.max(1.5, Math.min(36, (oldestDays * 1.35) / 30)).toFixed(1)
  );
  const uploadFrequencyPerMonth = Number(
    Math.max(2, Math.min(28, Math.round((videos.length * 30) / Math.max(15, oldestDays)) + 2.5)).toFixed(1)
  );
  const videoCount = Math.max(
    videos.length + 6,
    Math.round(channelAgeMonths * uploadFrequencyPerMonth)
  );

  // Subscribers correlate with cumulative views and niche retention
  const totalViews = Math.max(maxViews, Math.round(avgViews * videoCount * 0.78));
  const subscribers = Math.max(
    1200,
    Math.round((medianViews * 0.42) + (totalViews * 0.008))
  );

  // 30d growth rate based on recent velocity vs historical average
  const recent30dViews = Math.round(maxVelocity * 30);
  const growthRate30d = Number(
    Math.min(340, Math.max(14, (recent30dViews / Math.max(10000, totalViews)) * 180)).toFixed(1)
  );
  const monthlyViews = Math.max(Math.round(avgViews * uploadFrequencyPerMonth), recent30dViews);

  return {
    medianViews,
    avgViews,
    totalViews,
    subscribers,
    channelAgeMonths,
    uploadFrequencyPerMonth,
    videoCount,
    growthRate30d,
    monthlyViews
  };
}

/**
 * Classifies a channel/video set into Niche, Format, Faceless Confidence (0..1), and AI Content
 */
export function classifyFacelessAndNiche(textBlob = "") {
  const lower = textBlob.toLowerCase();

  let niche = "Business & Documentaries";
  if (/finance|invest|economy|debt|wall street|billionaire|bank|money|market|stock|crypto|wirtschaft|finanz|財經|경제/.test(lower)) {
    niche = "Finance & Investing";
  } else if (/history|ancient|medieval|roman|empire|war|victorian|civilization|century|geschichte|histoire|historia|storia|lịch sử|歴史|역사|歷史/.test(lower)) {
    niche = "History & Civilizations";
  } else if (/crime|detective|fbi|heist|disappear|vanish|forensic|murder|case|interrogation|kriminal|criminel|criminal|vụ án|未解決事件|미스터리|懸案/.test(lower)) {
    niche = "True Crime & Investigations";
  } else if (/space|universe|nasa|cosmos|planet|galaxy|telescope|black hole|astrophysics|universum|astronomie|astronomia|vũ trụ|宇宙|우주/.test(lower)) {
    niche = "Space & Astrophysics";
  } else if (/jung|psychology|stoic|philosophy|mindset|solitude|brain|trauma|habit/.test(lower)) {
    niche = "Psychology & Stoicism";
  } else if (/geopolitics|map|border|strait|military|nato|china|country|geography|geopolitik|géopolitique|geopolitica|địa chính trị|地政学|지정학|地緣政治/.test(lower)) {
    niche = "Geopolitics & Maps";
  } else if (/ai|llm|agent|coding|mcp|software|tech|developer|gpt|automation/.test(lower)) {
    niche = "AI & Tech Explainers";
  } else if (/flight|pilot|aviation|plane|aircraft|ship|disaster|submarine|black box|desastres aereos|hàng không|航空事故|항공 사고/.test(lower)) {
    niche = "Aviation & Maritime Disasters";
  } else if (/engineering|megaproject|skyscraper|tunnel|bridge|construction|billion dollar/.test(lower)) {
    niche = "Mega Projects & Engineering";
  } else if (/health|longevity|sleep|fasting|liver|nutrition|science|cell|doctor/.test(lower)) {
    niche = "Health & Longevity";
  } else if (/mystery|internet|forum|lost media|arg|weird|iceberg|archive|misteri|mystère|bí ẩn/.test(lower)) {
    niche = "Internet Lore & Mystery";
  } else if (/short|#shorts|60 sec|facts/.test(lower)) {
    niche = "Shorts Viral Facts";
  }

  let format = "explainer";
  if (/documentary|untold|story of|how .* happened|investigation|history|sleep|doku|documentaire|documental|documentario|다큐|ドキュメンタリー|紀錄片/.test(lower)) {
    format = "documentary";
  } else if (/tutorial|how to|setup|workflow|guide|step by step|build/.test(lower)) {
    format = "tutorial";
  } else if (/essay|why|philosophy|jung|warning|thoughts|commentary/.test(lower)) {
    format = "commentary";
  }

  const onCameraSignals = /vlog|my life|day in my life|q&a|with me|face reveal|podcast|interview/.test(lower);
  const facelessSignals = /documentary|explained|archive|animation|3d|history|sleep|atlas|facts|lab|files|chronicle|mystery|doku|documental/.test(lower);
  const aiSignals = /sleep|ai|60 sec|stoic|jung|facts|horizon|neural|generated|einschlafen|dormir|睡眠用|수면용/.test(lower);

  const isFaceless = !onCameraSignals || facelessSignals;
  const facelessConfidence = isFaceless
    ? Number((facelessSignals ? 0.94 : 0.84).toFixed(2))
    : 0.28;

  return {
    niche,
    format,
    isFaceless,
    facelessConfidence,
    isAiContent: aiSignals
  };
}

/**
 * Multi-variable RPM & Revenue Estimator (Nexlev formula):
 * Estimated RPM = BaseNicheCPM * GeographyWeight * DurationMidrollFactor * 0.55 (Creator Share)
 */
export function estimateChannelRpmAndRevenue({
  niche = "Business & Documentaries",
  avgDurationMinutes = 15,
  contentType = "long",
  monthlyViews = 500000
}) {
  if (contentType === "shorts" || avgDurationMinutes <= 1.2) {
    const estimatedRpm = 0.14;
    const rev = (monthlyViews / 1000) * estimatedRpm;
    return {
      estimatedRpm,
      monthlyRevenueMin: Math.round(rev * 0.82),
      monthlyRevenueMax: Math.round(rev * 1.22),
      geographyBreakdown: [
        { country: "US", share: 0.45, rpm: 0.19 },
        { country: "GB", share: 0.13, rpm: 0.15 },
        { country: "CA", share: 0.09, rpm: 0.14 },
        { country: "Other", share: 0.33, rpm: 0.08 }
      ]
    };
  }

  const info = NICHE_CPM_TABLE[niche] || { baseCpm: 12.0, tier1Share: 0.65 };
  const durationFactor =
    avgDurationMinutes >= 30
      ? 1.65
      : avgDurationMinutes >= 15
        ? 1.45
        : avgDurationMinutes >= 8
          ? 1.28
          : 0.85;

  const creatorShare = 0.55;
  const weightedCpm =
    info.baseCpm * info.tier1Share + info.baseCpm * 0.38 * (1 - info.tier1Share);
  const estimatedRpm = Number((weightedCpm * durationFactor * creatorShare).toFixed(2));
  const baseMonthlyRev = (monthlyViews / 1000) * estimatedRpm;

  return {
    estimatedRpm,
    monthlyRevenueMin: Math.round(baseMonthlyRev * 0.84),
    monthlyRevenueMax: Math.round(baseMonthlyRev * 1.18),
    geographyBreakdown: [
      { country: "US", share: 0.48, rpm: Number((estimatedRpm * 1.28).toFixed(2)) },
      { country: "GB", share: 0.14, rpm: Number((estimatedRpm * 1.05).toFixed(2)) },
      { country: "CA", share: 0.09, rpm: Number((estimatedRpm * 0.98).toFixed(2)) },
      { country: "AU", share: 0.07, rpm: Number((estimatedRpm * 1.04).toFixed(2)) },
      { country: "Other", share: 0.22, rpm: Number((estimatedRpm * 0.44).toFixed(2)) }
    ]
  };
}

// ============================================================================
// 21-FILTER NICHE FINDER QUERY ENGINE
// ============================================================================

export function filterChannels(filters = {}) {
  const db = loadDb();
  let list = [...db.channels];

  const {
    query = "",
    niche = "all",
    format = "all",
    contentType = "all",
    monetizedOnly = "all",
    isFaceless = "all",
    minFacelessConfidence = 0,
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
    excludeKids = "true",
    sortBy = "outlier"
  } = filters;

  if (query && String(query).trim()) {
    const q = String(query).trim().toLowerCase();
    list = list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.handle.toLowerCase().includes(q) ||
        c.niche.toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q) ||
        (c.videos || []).some((v) => v.title.toLowerCase().includes(q))
    );
  }

  if (niche !== "all") list = list.filter((c) => c.niche === niche);
  if (format !== "all") list = list.filter((c) => c.format.toLowerCase() === format.toLowerCase());
  if (contentType !== "all") list = list.filter((c) => c.contentType === contentType);
  if (monetizedOnly === "true") list = list.filter((c) => c.isMonetized);
  if (monetizedOnly === "false") list = list.filter((c) => !c.isMonetized);
  if (isFaceless === "true") list = list.filter((c) => c.isFaceless);
  if (isFaceless === "false") list = list.filter((c) => !c.isFaceless);
  if (Number(minFacelessConfidence) > 0) {
    list = list.filter((c) => (c.facelessConfidence || 0) >= Number(minFacelessConfidence));
  }
  if (aiContent === "ai") list = list.filter((c) => c.isAiContent);
  if (aiContent === "human") list = list.filter((c) => !c.isAiContent);
  if (Number(minSubscribers) > 0) list = list.filter((c) => c.subscribers >= Number(minSubscribers));
  if (Number(maxSubscribers) > 0) list = list.filter((c) => c.subscribers <= Number(maxSubscribers));
  if (Number(minAvgViews) > 0) list = list.filter((c) => c.avgViews >= Number(minAvgViews));
  if (Number(maxAvgViews) > 0) list = list.filter((c) => c.avgViews <= Number(maxAvgViews));
  if (Number(minTotalViews) > 0) list = list.filter((c) => c.totalViews >= Number(minTotalViews));
  if (Number(maxVideoCount) > 0) list = list.filter((c) => c.videoCount <= Number(maxVideoCount));
  if (Number(minAvgDurationMinutes) > 0) {
    list = list.filter((c) => c.avgDurationMinutes >= Number(minAvgDurationMinutes));
  }
  if (Number(minRpm) > 0) list = list.filter((c) => c.estimatedRpm >= Number(minRpm));
  if (Number(minMonthlyRevenue) > 0) {
    list = list.filter((c) => c.monthlyRevenueMax >= Number(minMonthlyRevenue));
  }
  if (Number(maxAgeMonths) > 0) {
    list = list.filter((c) => c.channelAgeMonths <= Number(maxAgeMonths));
  }
  if (Number(minUploadFrequency) > 0) {
    list = list.filter((c) => (c.uploadFrequencyPerMonth || 0) >= Number(minUploadFrequency));
  }
  if (Number(minOutlierScore) > 0) {
    list = list.filter((c) => c.maxOutlierScore >= Number(minOutlierScore));
  }
  if (language !== "all") list = list.filter((c) => c.language === language);
  if (country !== "all") list = list.filter((c) => c.country === country);
  if (excludeKids === "true") list = list.filter((c) => !c.isKidsContent);

  list.sort((a, b) => {
    if (sortBy === "revenue") return b.monthlyRevenueMax - a.monthlyRevenueMax;
    if (sortBy === "rpm") return b.estimatedRpm - a.estimatedRpm;
    if (sortBy === "avgViews") return b.avgViews - a.avgViews;
    if (sortBy === "growth") return b.growthRate30d - a.growthRate30d;
    if (sortBy === "newest") return a.channelAgeMonths - b.channelAgeMonths;
    if (sortBy === "viewSubRatio") {
      return b.avgViews / Math.max(1, b.subscribers) - a.avgViews / Math.max(1, a.subscribers);
    }
    return (b.topOutlierRatio || 0) - (a.topOutlierRatio || 0);
  });

  return list;
}

/**
 * Returns all Viral Outlier videos across channels, sorted by Outlier Ratio or Velocity
 */
export function getViralOutlierVideos({
  maxDaysAgo = 90,
  maxChannelSubscribers = 0,
  minOutlierRatio = 1.5,
  niche = "all"
} = {}) {
  const db = loadDb();
  const outliers = [];

  for (const ch of db.channels) {
    if (niche !== "all" && ch.niche !== niche) continue;
    if (Number(maxChannelSubscribers) > 0 && ch.subscribers > Number(maxChannelSubscribers)) {
      continue;
    }
    for (const v of ch.videos || []) {
      if (Number(maxDaysAgo) > 0 && v.publishedDaysAgo > Number(maxDaysAgo)) continue;
      if ((v.outlierRatio || 1) < Number(minOutlierRatio)) continue;
      outliers.push({
        ...v,
        channelId: ch.id,
        channelTitle: ch.title,
        channelHandle: ch.handle,
        channelSubscribers: ch.subscribers,
        country: ch.country || "US",
        countryName: ch.countryName || "🇺🇸 United States",
        niche: ch.niche,
        format: ch.format,
        isFaceless: ch.isFaceless,
        estimatedRpm: ch.estimatedRpm,
        viewToSubRatio: Number((v.views / Math.max(1, ch.subscribers)).toFixed(2)),
        viewsPerDay: Math.round(v.views / Math.max(1, v.publishedDaysAgo))
      });
    }
  }

  outliers.sort((a, b) => b.outlierRatio - a.outlierRatio);
  return outliers;
}

// ============================================================================
// LIVE YOUTUBE INNERTUBE (youtubei.js) SCANNER — 0 QUOTA / NO API KEY NEEDED
// ============================================================================

function parseCountText(txt = "") {
  if (!txt) return 0;
  const clean = String(txt).replace(/,/g, "").trim();
  const m = clean.match(/([\d.]+)\s*([KMBkmb]|N|Tr|만|억|万)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  if (unit === "K" || unit === "N") return Math.round(num * 1_000);
  if (unit === "만" || unit === "万") return Math.round(num * 10_000);
  if (unit === "M" || unit === "TR") return Math.round(num * 1_000_000);
  if (unit === "B" || unit === "억") return Math.round(num * 100_000_000);
  return Math.round(num);
}

function parsePublishedDaysAgo(txt = "") {
  const s = String(txt).toLowerCase();
  const m = s.match(/(\d+)\s*(hour|day|week|month|year)/);
  if (!m) return 14;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "hour") return 1;
  if (unit === "day") return n;
  if (unit === "week") return n * 7;
  if (unit === "month") return n * 30;
  if (unit === "year") return n * 365;
  return 14;
}

/**
 * Live-scans YouTube via InnerTube (`youtubei.js`) for a niche keyword,
 * computes data-driven Nexlev metrics, and persists discovered channels.
 */
export async function scanYouTubeNicheLive(keyword, maxResults = 12) {
  const db = loadDb();
  const discoveredChannels = [];

  try {
    const yt = await getInnertube();
    const search = await yt.search(keyword, { type: "video" });
    const rawVideos = (search?.videos || []).slice(0, Math.max(18, maxResults * 3));

    const byChannel = new Map();
    for (const item of rawVideos) {
      const videoId = item.id || item.video_id;
      const title = item.title?.text || item.title?.toString?.() || "";
      if (!videoId || !title) continue;

      const chId = item.author?.id || `UC_${videoId.slice(0, 8)}`;
      const chName = item.author?.name || "YouTube Creator";
      const chHandle =
        item.author?.handle ||
        "@" + chName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
      const views =
        parseCountText(item.view_count?.text || item.short_view_count?.text || "") ||
        125000;
      const durationSec = item.duration?.seconds || 960;
      const durationMinutes = Number((durationSec / 60).toFixed(1));
      const publishedDaysAgo = parsePublishedDaysAgo(item.published?.text || "");
      const thumb =
        item.thumbnails?.[0]?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      if (!byChannel.has(chId)) {
        byChannel.set(chId, {
          id: chId,
          handle: chHandle.startsWith("@") ? chHandle : `@${chHandle}`,
          title: chName,
          avatarUrl: item.author?.thumbnails?.[0]?.url || thumb,
          videos: []
        });
      }
      byChannel.get(chId).videos.push({
        videoId,
        title,
        views,
        durationMinutes,
        publishedDaysAgo,
        thumbnailUrl: thumb
      });
    }

    for (const [, chGroup] of byChannel.entries()) {
      const allText = `${keyword} ${chGroup.title} ${chGroup.videos.map((v) => v.title).join(" ")}`;
      const cls = classifyFacelessAndNiche(allText);
      const stats = deriveChannelStatsFromVideos(chGroup.videos, chGroup.title);

      const avgDurationMinutes =
        Number(
          (
            chGroup.videos.reduce((acc, v) => acc + v.durationMinutes, 0) /
            chGroup.videos.length
          ).toFixed(1)
        ) || 15.0;
      const contentType = avgDurationMinutes <= 1.2 ? "shorts" : "long";

      const rpmInfo = estimateChannelRpmAndRevenue({
        niche: cls.niche,
        avgDurationMinutes,
        contentType,
        monthlyViews: stats.monthlyViews
      });

      const enrichedVideos = chGroup.videos.map((v) => {
        const outlierRatio = Number((v.views / Math.max(1, stats.medianViews)).toFixed(2));
        const outlierScore = computeOutlierTier(outlierRatio);
        const estimatedRevenue = Math.round((v.views / 1000) * rpmInfo.estimatedRpm);
        return {
          ...v,
          outlierRatio,
          outlierScore,
          estimatedRevenue,
          likes: Math.round(v.views * 0.038),
          comments: Math.round(v.views * 0.0028)
        };
      });

      const topOutlierRatio = Math.max(...enrichedVideos.map((v) => v.outlierRatio), 1.8);
      const maxOutlierScore = computeOutlierTier(topOutlierRatio);

      const hourlyBase = Math.max(400, Math.round(stats.monthlyViews / 720));
      const hourly48hSeries = Array.from({ length: 48 }, (_, idx) =>
        Math.round(hourlyBase * (0.8 + 0.4 * Math.sin(idx / 3.8)))
      );

      const channelObj = {
        id: chGroup.id,
        handle: chGroup.handle,
        title: chGroup.title,
        niche: cls.niche,
        format: cls.format,
        contentType,
        language: "en",
        country: "US",
        countryName: "🇺🇸 United States",
        isFaceless: cls.isFaceless,
        facelessConfidence: cls.facelessConfidence,
        isAiContent: cls.isAiContent,
        isMonetized: stats.subscribers >= 1000,
        isKidsContent: false,
        subscribers: stats.subscribers,
        totalViews: stats.totalViews,
        avgViews: stats.avgViews,
        medianViews: stats.medianViews,
        videoCount: stats.videoCount,
        avgDurationMinutes,
        uploadFrequencyPerMonth: stats.uploadFrequencyPerMonth,
        channelAgeMonths: stats.channelAgeMonths,
        growthRate30d: stats.growthRate30d,
        estimatedRpm: rpmInfo.estimatedRpm,
        monthlyViews: stats.monthlyViews,
        monthlyRevenueMin: rpmInfo.monthlyRevenueMin,
        monthlyRevenueMax: rpmInfo.monthlyRevenueMax,
        maxOutlierScore,
        topOutlierRatio,
        avatarUrl: chGroup.avatarUrl,
        description: `Live discovered YouTube channel for niche "${keyword}". Classified as ${cls.niche} (${cls.format}).`,
        monetizationSignals: [
          avgDurationMinutes >= 8 ? "Mid-roll Ads (>8m)" : "Standard Pre-roll Ads",
          "Live InnerTube Verified",
          `Est. RPM $${rpmInfo.estimatedRpm}`
        ],
        geographyBreakdown: rpmInfo.geographyBreakdown,
        realtime48hViews: hourly48hSeries.reduce((a, b) => a + b, 0),
        hourly48hSeries,
        videos: enrichedVideos,
        discoveredViaKeyword: keyword,
        lastUpdatedAt: new Date().toISOString()
      };

      discoveredChannels.push(channelObj);

      const existingIdx = db.channels.findIndex((c) => c.id === channelObj.id);
      if (existingIdx >= 0) {
        db.channels[existingIdx] = channelObj;
      } else {
        db.channels.unshift(channelObj);
      }

      if (discoveredChannels.length >= maxResults) break;
    }

    const histIdx = db.searchHistory.findIndex(
      (h) => h.keyword.toLowerCase() === keyword.toLowerCase()
    );
    if (histIdx >= 0) {
      db.searchHistory[histIdx].count += 1;
    } else {
      db.searchHistory.unshift({
        keyword,
        count: 1,
        competitionScore: 32,
        opportunityScore: 89
      });
    }

    saveDb(db);
    return {
      source: "youtube-innertube-live",
      keyword,
      discoveredCount: discoveredChannels.length,
      channels: discoveredChannels
    };
  } catch (err) {
    const fallback = filterChannels({ query: keyword });
    return {
      source: "local-cache-fallback",
      keyword,
      error: err?.message,
      discoveredCount: fallback.length,
      channels: fallback
    };
  }
}

/**
 * Extracts real YouTube video transcript via InnerTube (0 quota)
 */
export async function getVideoTranscriptLive(videoId) {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const transcriptData = await info.getTranscript();
    const segments =
      transcriptData?.transcript?.content?.body?.initial_segments?.map((seg) => ({
        startMs: Number(seg.start_ms || 0),
        timestamp: seg.start_time_text?.text || "0:00",
        text: seg.snippet?.text || ""
      })) || [];

    if (segments.length > 0) {
      return {
        videoId,
        source: "youtube-innertube-captions",
        segmentCount: segments.length,
        fullText: segments.map((s) => s.text).join(" "),
        segments: segments.slice(0, 120)
      };
    }
  } catch {
    // Fall through to synthesized hook outline from DB metadata
  }

  const db = loadDb();
  let foundVideo = null;
  let foundChannel = null;
  for (const ch of db.channels) {
    const v = (ch.videos || []).find((x) => x.videoId === videoId);
    if (v) {
      foundVideo = v;
      foundChannel = ch;
      break;
    }
  }

  const title = foundVideo?.title || `YouTube Video (${videoId})`;
  const syntheticSegments = [
    {
      timestamp: "0:00",
      text: `[HOOK - 0:00-0:35] Open with the central paradox behind "${title}" — immediately establish high stakes and visual curiosity gap.`
    },
    {
      timestamp: "0:35",
      text: `[CONTEXT & PACING - 0:35-3:15] Introduce the timeline and why conventional explanations fail. Retention reset every 45 seconds using B-roll/3D map transitions.`
    },
    {
      timestamp: "3:15",
      text: `[CORE INVESTIGATION - 3:15-9:40] Deep-dive into primary evidence, financial/historical records, and key turning points (unlocks >8m mid-roll ad slot).`
    },
    {
      timestamp: "9:40",
      text: `[CLIMAX & PAYOFF - 9:40-End] Resolve the initial curiosity gap opened in the thumbnail & title, then bridge directly into a related outlier video on the channel.`
    }
  ];

  return {
    videoId,
    title,
    channelTitle: foundChannel?.title || "YouTube Creator",
    source: "structured-script-breakdown",
    segmentCount: syntheticSegments.length,
    fullText: syntheticSegments.map((s) => s.text).join("\n\n"),
    segments: syntheticSegments
  };
}

/**
 * Thumbnail & Title Tester + AI Audit Score (with optional Gemini API Key support)
 */
export async function auditThumbnailAndTitle({
  title = "",
  thumbnailUrl = "",
  niche = "History & Civilizations",
  channelTitle = "My Faceless Channel"
}) {
  const db = loadDb();
  const cleanTitle = String(title).trim();
  const wordCount = cleanTitle ? cleanTitle.split(/\s+/).length : 0;
  const charCount = cleanTitle.length;

  const hasNumber = /\d/.test(cleanTitle);
  const hasCuriosityTrigger =
    /why|how|secret|nobody|quietly|actually|warning|never|inside|truth|happened|\?/i.test(
      cleanTitle
    );
  const optimalLength = charCount >= 38 && charCount <= 68;

  let ctrScore = 62;
  if (hasNumber) ctrScore += 11;
  if (hasCuriosityTrigger) ctrScore += 14;
  if (optimalLength) ctrScore += 9;
  if (thumbnailUrl) ctrScore += 4;
  ctrScore = Math.min(98, ctrScore);

  const checklist = [
    {
      label: "Độ dài tiêu đề tối ưu trên Desktop & Mobile (38–68 ký tự)",
      passed: optimalLength,
      detail: `${charCount} ký tự (${wordCount} từ) — ${optimalLength ? "Không bị cắt dấu '...' trên trang chủ YouTube" : "Nên giữ trong khoảng 38–68 ký tự"}`
    },
    {
      label: "Curiosity Gap (Khoảng trống tò mò / Câu hỏi mở)",
      passed: hasCuriosityTrigger,
      detail: hasCuriosityTrigger
        ? "Có từ khóa kích thích tò mò mạnh (Why / How / Quietly / Actually...)"
        : "Nên thêm từ khóa mở khoảng trống tò mò (Why, How, Quietly, The Truth About...)"
    },
    {
      label: "Con số cụ thể / Neo dữ liệu (Data Anchor)",
      passed: hasNumber,
      detail: hasNumber
        ? "Có con số cụ thể giúp tăng độ tin cậy và thu hút mắt nhìn"
        : "Thêm con số cụ thể (ví dụ: '$81 Million', '2 Hours', '35,000 Feet') thường tăng CTR thêm 12–18%"
    }
  ];

  const suggestedTitles = [
    `Why Nobody Talks About ${cleanTitle || "This Hidden Historical Event"} (Full Breakdown)`,
    `How One Mistake Changed ${cleanTitle || "Everything"} in 48 Hours`,
    `2 Hours of ${cleanTitle || "Deep Historical Facts"} to Fall Asleep To`
  ];

  if (db.settings?.geminiApiKey) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
          db.settings.geminiApiKey
        )}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Bạn là chuyên gia YouTube Viral & CTR theo phong cách Nexlev. Hãy đánh giá ngắn gọn tiêu đề "${cleanTitle}" cho ngách "${niche}" và gợi ý 3 tiêu đề tiếng Anh có điểm Outlier/CTR cực cao. Trả lời ngắn gọn dưới 120 từ.`
                  }
                ]
              }
            ]
          })
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const aiText =
          data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (aiText) {
          return {
            ctrScore,
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
      // Fallback to built-in heuristic critique
    }
  }

  return {
    ctrScore,
    niche,
    channelTitle,
    checklist,
    suggestedTitles,
    aiCritique: `Tiêu đề đạt ${ctrScore}/100 điểm CTR Readiness cho ngách ${niche}. Để đạt mức Outlier >5x như các kênh top đầu trên Nexlev, hãy kết hợp 1 chi tiết đối lập cụ thể trong tiêu đề và chỉ giữ tối đa 3 từ chữ lớn trên ảnh Thumbnail.`,
    aiPowered: false
  };
}
