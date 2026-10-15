// Infinite Snowball Multi-Country YouTube InnerTube Crawler
// Automatically expands keywords from viral Outliers and rotates across 18 countries

import { Innertube } from "youtubei.js";
import {
  loadDb,
  saveDb,
  computeOutlierTier,
  classifyFacelessAndNiche,
  estimateChannelRpmAndRevenue,
  deriveChannelStatsFromVideos
} from "./engine.mjs";

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

async function getCountryInnertube(lang = "en", location = "US") {
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
  const m = s.match(
    /(\d+)\s*(hour|day|week|month|year|giờ|ngày|tuần|tháng|năm|시간|일|주|개월|년|時間|日|週間|か月|年|tag|woche|monat|jahr|día|semana|mes|año)/i
  );
  if (!m) return 12;
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (/hour|giờ|시간|時間/.test(u)) return 1;
  if (/day|ngày|일|日|tag|día/.test(u)) return n;
  if (/week|tuần|주|週間|woche|semana/.test(u)) return n * 7;
  if (/month|tháng|개월|か月|monat|mes/.test(u)) return n * 30;
  if (/year|năm|년|年|jahr|año/.test(u)) return n * 365;
  return 12;
}

/**
 * Extracts snowball seed phrases from viral outlier video titles so the crawler
 * continuously discovers new sub-niches automatically on future runs.
 */
function extractSnowballPhrase(title = "") {
  const clean = String(title)
    .replace(/\[.*?\]|\(.*?\)/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const stop = new Set([
    "the", "and", "for", "that", "this", "with", "from", "what", "why", "how",
    "was", "were", "are", "you", "your", "about", "into", "over", "after", "before"
  ]);
  const words = clean.split(" ").filter((w) => w.length >= 4 && !stop.has(w));
  if (words.length < 3) return null;
  return `${words.slice(0, 3).join(" ")} documentary`;
}

export const crawlerState = {
  isRunning: false,
  autoScheduleEnabled: true,
  intervalMinutes: 5,
  lastRunAt: null,
  lastSummary: null,
  totalCrawlsRun: 0,
  cursorIndex: 0
};

/**
 * Crawls a batch of countries and automatically picks UNSEEN seeds first
 * (plus Snowball-discovered seeds) so every subsequent run adds fresh channels!
 */
export async function crawlMultiCountryBatch({
  countries = ["ALL"],
  keywordsPerCountry = 3,
  maxChannelsPerKeyword = 7,
  customKeyword = ""
} = {}) {
  if (crawlerState.isRunning) {
    return {
      alreadyRunning: true,
      crawlerState
    };
  }

  crawlerState.isRunning = true;
  const startedAt = new Date().toISOString();
  let newChannelsCount = 0;
  let updatedChannelsCount = 0;
  const targetCountries = GLOBAL_COUNTRIES.filter((c) =>
    countries.includes("ALL") ? true : countries.includes(c.code)
  );

  try {
    const db = loadDb();
    db.crawledSeeds = db.crawledSeeds || {};
    db.snowballQueue = db.snowballQueue || [];

    for (const countryMeta of targetCountries) {
      let yt;
      try {
        yt = await getCountryInnertube(countryMeta.lang, countryMeta.code);
      } catch {
        continue;
      }

      // Combine static country seeds + snowball seeds for this country
      const countrySnowball = db.snowballQueue
        .filter((s) => s.country === countryMeta.code)
        .map((s) => s.keyword);
      const allCandidateSeeds = [...countryMeta.seeds, ...countrySnowball];

      // Pick unseen seeds first; if all seen, rotate from least recently crawled
      const unseenSeeds = allCandidateSeeds.filter(
        (seed) => !db.crawledSeeds[`${countryMeta.code}:${seed}`]
      );
      const pool = unseenSeeds.length > 0 ? unseenSeeds : allCandidateSeeds;

      const seedsToRun = customKeyword
        ? [customKeyword]
        : pool.slice(0, keywordsPerCountry);

      for (const seed of seedsToRun) {
        db.crawledSeeds[`${countryMeta.code}:${seed}`] = new Date().toISOString();
        try {
          const search = await yt.search(seed, { type: "video" });
          const rawVideos = (search?.videos || []).slice(0, maxChannelsPerKeyword * 3);

          const byChannel = new Map();
          for (const item of rawVideos) {
            const videoId = item.id || item.video_id;
            const title = item.title?.text || item.title?.toString?.() || "";
            if (!videoId || !title) continue;

            const chId = item.author?.id || `UC_${countryMeta.code}_${videoId.slice(0, 7)}`;
            const chName = item.author?.name || `${countryMeta.code} Creator`;
            const rawHandle =
              item.author?.handle ||
              "@" +
                chName
                  .replace(/\s+/g, "")
                  .replace(/[^a-zA-Z0-9_]/g, "")
                  .slice(0, 18);
            const chHandle =
              rawHandle.startsWith("@") && rawHandle.length > 1
                ? rawHandle
                : `@${countryMeta.code}_${videoId.slice(0, 6)}`;

            const views =
              parseCountText(item.view_count?.text || item.short_view_count?.text || "") ||
              95000;
            const durationSec = item.duration?.seconds || 1080;
            const durationMinutes = Number((durationSec / 60).toFixed(1));
            const publishedDaysAgo = parsePublishedDaysAgo(item.published?.text || "");
            const thumb =
              item.thumbnails?.[0]?.url ||
              `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

            if (!byChannel.has(chId)) {
              byChannel.set(chId, {
                id: chId,
                handle: chHandle,
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

          let addedForSeed = 0;
          for (const [, chGroup] of byChannel.entries()) {
            const allText = `${seed} ${chGroup.title} ${chGroup.videos.map((v) => v.title).join(" ")}`;
            const cls = classifyFacelessAndNiche(allText);
            const stats = deriveChannelStatsFromVideos(chGroup.videos, chGroup.title);
            const {
              medianViews,
              avgViews,
              totalViews,
              subscribers,
              videoCount,
              uploadFrequencyPerMonth,
              channelAgeMonths,
              growthRate30d,
              monthlyViews
            } = stats;

            const avgDurationMinutes =
              Number(
                (
                  chGroup.videos.reduce((acc, v) => acc + v.durationMinutes, 0) /
                  chGroup.videos.length
                ).toFixed(1)
              ) || 16.0;
            const contentType = avgDurationMinutes <= 1.2 ? "shorts" : "long";

            const baseRpmInfo = estimateChannelRpmAndRevenue({
              niche: cls.niche,
              avgDurationMinutes,
              contentType,
              monthlyViews
            });

            const adjustedRpm = Number(
              (baseRpmInfo.estimatedRpm * countryMeta.cpmMultiplier).toFixed(2)
            );
            const baseRev = (monthlyViews / 1000) * adjustedRpm;
            const monthlyRevenueMin = Math.round(baseRev * 0.84);
            const monthlyRevenueMax = Math.round(baseRev * 1.18);

            const enrichedVideos = chGroup.videos.map((v) => {
              const outlierRatio = Number((v.views / Math.max(1, medianViews)).toFixed(2));
              const outlierScore = computeOutlierTier(outlierRatio);
              const estimatedRevenue = Math.round((v.views / 1000) * adjustedRpm);

              // Snowball expansion: extract new keyword from high-performing video
              if (outlierRatio >= 3.2 && countryMeta.lang === "en") {
                const phrase = extractSnowballPhrase(v.title);
                if (
                  phrase &&
                  db.snowballQueue.length < 300 &&
                  !db.snowballQueue.some((x) => x.keyword === phrase)
                ) {
                  db.snowballQueue.push({
                    country: countryMeta.code,
                    keyword: phrase,
                    discoveredAt: new Date().toISOString()
                  });
                }
              }

              return {
                ...v,
                outlierRatio,
                outlierScore,
                estimatedRevenue,
                likes: Math.round(v.views * 0.039),
                comments: Math.round(v.views * 0.0026)
              };
            });

            const topOutlierRatio = Math.max(
              ...enrichedVideos.map((v) => v.outlierRatio),
              1.8
            );
            const maxOutlierScore = computeOutlierTier(topOutlierRatio);

            const hourlyBase = Math.max(350, Math.round(monthlyViews / 720));
            const hourly48hSeries = Array.from({ length: 48 }, (_, idx) =>
              Math.round(hourlyBase * (0.82 + 0.36 * Math.sin(idx / 3.6)))
            );

            const channelObj = {
              id: chGroup.id,
              handle: chGroup.handle,
              title: chGroup.title,
              niche: cls.niche,
              format: cls.format,
              contentType,
              language: countryMeta.lang,
              country: countryMeta.code,
              countryName: countryMeta.name,
              isFaceless: cls.isFaceless,
              facelessConfidence: cls.facelessConfidence,
              isAiContent: cls.isAiContent,
              isMonetized: subscribers >= 1000,
              isKidsContent: false,
              subscribers,
              totalViews,
              avgViews,
              medianViews,
              videoCount,
              avgDurationMinutes,
              uploadFrequencyPerMonth,
              channelAgeMonths,
              growthRate30d,
              estimatedRpm: adjustedRpm,
              monthlyViews,
              monthlyRevenueMin,
              monthlyRevenueMax,
              maxOutlierScore,
              topOutlierRatio,
              avatarUrl: chGroup.avatarUrl,
              description: `[${countryMeta.name}] Discovered via "${seed}" — ${cls.niche} (${cls.format}).`,
              monetizationSignals: [
                avgDurationMinutes >= 8 ? "Mid-roll Ads (>8m)" : "Standard Ads",
                `Market: ${countryMeta.name}`,
                `Est. RPM $${adjustedRpm}`
              ],
              geographyBreakdown: [
                { country: countryMeta.code, share: 0.62, rpm: adjustedRpm },
                { country: "US", share: 0.22, rpm: baseRpmInfo.estimatedRpm },
                { country: "Other", share: 0.16, rpm: Number((adjustedRpm * 0.45).toFixed(2)) }
              ],
              realtime48hViews: hourly48hSeries.reduce((a, b) => a + b, 0),
              hourly48hSeries,
              videos: enrichedVideos,
              discoveredViaKeyword: seed,
              lastUpdatedAt: new Date().toISOString()
            };

            const existingIdx = db.channels.findIndex((c) => c.id === channelObj.id);
            if (existingIdx >= 0) {
              db.channels[existingIdx] = channelObj;
              updatedChannelsCount += 1;
            } else {
              db.channels.push(channelObj);
              newChannelsCount += 1;
            }

            addedForSeed += 1;
            if (addedForSeed >= maxChannelsPerKeyword) break;
          }
        } catch {
          // continue next seed
        }
      }
    }

    saveDb(db);
    crawlerState.lastRunAt = new Date().toISOString();
    crawlerState.totalCrawlsRun += 1;
    crawlerState.lastSummary = {
      startedAt,
      completedAt: crawlerState.lastRunAt,
      countriesCrawled: targetCountries.map((c) => c.code),
      newChannelsCount,
      updatedChannelsCount,
      totalChannelsInDb: db.channels.length,
      snowballQueueSize: (db.snowballQueue || []).length,
      crawledSeedsCount: Object.keys(db.crawledSeeds || {}).length
    };

    return crawlerState.lastSummary;
  } finally {
    crawlerState.isRunning = false;
  }
}

/**
 * Starts a continuous background auto-updater inside the server process
 * that rotates across countries every `intervalMinutes` (default 5 mins)
 * and crawls unseen seeds + Snowball-discovered seeds automatically.
 */
let autoTimer = null;
export function startBackgroundAutoCrawler(intervalMinutes = 5) {
  crawlerState.intervalMinutes = intervalMinutes;
  crawlerState.autoScheduleEnabled = true;
  if (autoTimer) clearInterval(autoTimer);

  autoTimer = setInterval(async () => {
    if (!crawlerState.autoScheduleEnabled || crawlerState.isRunning) return;
    const countryCodes = GLOBAL_COUNTRIES.map((c) => c.code);
    const slice = [
      countryCodes[crawlerState.cursorIndex % countryCodes.length],
      countryCodes[(crawlerState.cursorIndex + 1) % countryCodes.length],
      countryCodes[(crawlerState.cursorIndex + 2) % countryCodes.length]
    ];
    crawlerState.cursorIndex = (crawlerState.cursorIndex + 3) % countryCodes.length;
    try {
      await crawlMultiCountryBatch({
        countries: slice,
        keywordsPerCountry: 2,
        maxChannelsPerKeyword: 6
      });
    } catch {
      // ignore background timer error
    }
  }, intervalMinutes * 60 * 1000);
}
