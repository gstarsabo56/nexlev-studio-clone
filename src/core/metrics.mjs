// Honest Metrics, True Multi-Video Outlier Engine & Scenario RPM Simulator (Batch 1)
// Strictly adheres to: no fabricated numbers, null/unknown when sample or source is missing.

import { createMetric } from "./provenance.mjs";
import { classifyVideoContentType } from "./parsers.mjs";
import { NICHE_CPM_TABLE } from "./seed-data.mjs";

export const DEFAULT_MIN_OUTLIER_SAMPLE_SIZE = 3;
export const RECOMMENDED_OUTLIER_SAMPLE_SIZE = 5;
export const METRICS_METHOD_VERSION = "honest-metrics-v2.0";

export function computeMedian(numbers) {
  if (!Array.isArray(numbers)) return null;
  const valid = numbers.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(med);
}

export function computeTrimmedMean(numbers) {
  if (!Array.isArray(numbers)) return null;
  const valid = numbers.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  if (sorted.length <= 3) {
    return Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  }
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.15));
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
}

export function computeOutlierTier(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) {
    return null;
  }
  if (ratio >= 5.0) return 3;
  if (ratio >= 3.0) return 2;
  if (ratio >= 1.5) return 1;
  return 0;
}

/**
 * Evaluates Outlier ratios across a channel's observed videos.
 * - Groups strictly by video format ('long', 'shorts', 'live') so Shorts never skew long-form baselines.
 * - Requires at least `minSampleSize` videos with valid views in the same format group.
 * - Never uses channel title hashes or arbitrary divisors.
 * - Flags age-skew warnings when lifetime views are compared across wide publication windows.
 */
export function evaluateChannelVideosOutliers(
  videos = [],
  {
    minSampleSize = DEFAULT_MIN_OUTLIER_SAMPLE_SIZE,
    channelDataOrigin = "observed",
    nowMs = Date.now()
  } = {}
) {
  const effectiveMinSample = Math.max(
    3,
    Math.round(Number(minSampleSize) || DEFAULT_MIN_OUTLIER_SAMPLE_SIZE)
  );

  if (!Array.isArray(videos) || videos.length === 0) {
    return {
      videos: [],
      baselinesByFormat: {},
      maxOutlierScore: null,
      topOutlierRatio: null,
      minSampleRequired: effectiveMinSample,
      outlierStatus: "insufficient_data",
      outlierReason: "no_observed_videos"
    };
  }

  // 1. Classify each video individually & compute dynamic age from publishedAt when available (T04, T07)
  const normalizedVideos = videos.map((v) => {
    const videoOrigin = v.dataOrigin || channelDataOrigin || "observed";
    const views =
      typeof v.views === "number" && Number.isFinite(v.views) && v.views >= 0
        ? Math.round(v.views)
        : null;
    const viewsStatus =
      v.viewsStatus ||
      (views === null
        ? "unknown"
        : videoOrigin === "legacy_unverified"
          ? "legacy_unverified"
          : videoOrigin === "demo"
            ? "demo"
            : "observed");

    const contentType =
      v.contentType && ["long", "shorts", "live"].includes(v.contentType)
        ? v.contentType
        : classifyVideoContentType({
            isLive: v.isLive,
            isUpcoming: v.isUpcoming,
            isShorts: v.isShorts,
            aspectRatio: v.aspectRatio,
            url: v.canonicalUrl || v.url,
            durationSeconds: v.durationSeconds,
            durationMinutes: v.durationMinutes
          });

    // Dynamic age from publishedAt if valid ISO timestamp exists (T07)
    let publishedDaysAgo = null;
    let publishedPrecision = v.publishedPrecision || "unknown";
    if (v.publishedAt) {
      const pubMs = Date.parse(v.publishedAt);
      if (Number.isFinite(pubMs)) {
        publishedDaysAgo = Math.max(0, Number(((nowMs - pubMs) / 86400_000).toFixed(2)));
        publishedPrecision = "exact_timestamp";
      }
    }
    if (
      publishedDaysAgo === null &&
      typeof v.publishedDaysAgo === "number" &&
      Number.isFinite(v.publishedDaysAgo) &&
      v.publishedDaysAgo >= 0
    ) {
      publishedDaysAgo = Number(v.publishedDaysAgo);
      publishedPrecision = "relative_estimate";
    }

    const viewsPerDay =
      views !== null && publishedDaysAgo !== null && publishedDaysAgo > 0
        ? Math.round(views / publishedDaysAgo)
        : null;

    return {
      ...v,
      dataOrigin: videoOrigin,
      viewsStatus,
      contentType,
      views,
      publishedDaysAgo,
      publishedPrecision,
      viewsPerDay,
      likes:
        typeof v.likes === "number" && Number.isFinite(v.likes) && v.likes >= 0
          ? Math.round(v.likes)
          : null,
      comments:
        typeof v.comments === "number" && Number.isFinite(v.comments) && v.comments >= 0
          ? Math.round(v.comments)
          : null
    };
  });

  // 2. Group ONLY eligible observed videos by known format ('long', 'shorts', 'live') (T03, T04)
  // Unknown format, legacy_unverified, and demo videos NEVER form a 'derived' baseline!
  const VALID_BASELINE_FORMATS = new Set(["long", "shorts", "live"]);
  const formatGroups = new Map();
  const rawFormatCounts = new Map();

  for (const v of normalizedVideos) {
    const fmt = v.contentType || "unknown";
    rawFormatCounts.set(fmt, (rawFormatCounts.get(fmt) || 0) + 1);
    if (!formatGroups.has(fmt)) formatGroups.set(fmt, []);

    const isEligibleSource =
      v.dataOrigin === "observed" &&
      v.viewsStatus === "observed" &&
      v.views !== null &&
      VALID_BASELINE_FORMATS.has(fmt);

    if (isEligibleSource) {
      formatGroups.get(fmt).push(v);
    }
  }

  const baselinesByFormat = {};
  for (const [fmt, group] of formatGroups.entries()) {
    const sampleSize = group.length;
    if (!VALID_BASELINE_FORMATS.has(fmt)) {
      baselinesByFormat[fmt] = {
        format: fmt,
        sampleSize: 0,
        rawCount: rawFormatCounts.get(fmt) || 0,
        minSampleRequired: effectiveMinSample,
        medianViews: null,
        trimmedMeanViews: null,
        status: "insufficient_data",
        methodVersion: METRICS_METHOD_VERSION,
        reason: "unknown_video_format_cannot_form_baseline"
      };
      continue;
    }

    if (sampleSize < effectiveMinSample) {
      const hasLegacyOrDemo = normalizedVideos.some(
        (v) =>
          v.contentType === fmt &&
          (v.dataOrigin === "legacy_unverified" || v.viewsStatus === "legacy_unverified")
      );
      baselinesByFormat[fmt] = {
        format: fmt,
        sampleSize,
        minSampleRequired: effectiveMinSample,
        medianViews: null,
        trimmedMeanViews: null,
        status: hasLegacyOrDemo && sampleSize === 0 ? "unverified_source" : "insufficient_data",
        methodVersion: METRICS_METHOD_VERSION,
        reason:
          hasLegacyOrDemo && sampleSize === 0
            ? "legacy_unverified_videos_excluded_from_baseline"
            : `Requires at least ${effectiveMinSample} observed '${fmt}' videos on this channel (found ${sampleSize})`
      };
      continue;
    }

    const viewNumbers = group.map((x) => x.views);
    const medianViews = computeMedian(viewNumbers);
    const trimmedMeanViews = computeTrimmedMean(viewNumbers);
    const daysValues = group
      .map((x) => x.publishedDaysAgo)
      .filter((d) => d !== null);

    const minDays = daysValues.length ? Math.min(...daysValues) : null;
    const maxDays = daysValues.length ? Math.max(...daysValues) : null;
    const ageSpanDays =
      minDays !== null && maxDays !== null ? Number((maxDays - minDays).toFixed(1)) : null;

    let ageSkewWarning = null;
    if (daysValues.length < sampleSize) {
      ageSkewWarning = "some_videos_missing_publish_timestamp_lifetime_comparison_only";
    } else if (ageSpanDays !== null && ageSpanDays > 60) {
      ageSkewWarning = `wide_publication_window_${ageSpanDays}d_lifetime_views_compared`;
    }

    baselinesByFormat[fmt] = {
      format: fmt,
      sampleSize,
      minSampleRequired: effectiveMinSample,
      medianViews,
      trimmedMeanViews,
      minPublishedDaysAgo: minDays,
      maxPublishedDaysAgo: maxDays,
      ageSpanDays,
      ageSkewWarning,
      confidenceNote:
        sampleSize < RECOMMENDED_OUTLIER_SAMPLE_SIZE
          ? `low_sample_size_${sampleSize}_recommended_${RECOMMENDED_OUTLIER_SAMPLE_SIZE}`
          : "adequate_sample_size",
      status: "derived",
      methodVersion: METRICS_METHOD_VERSION,
      baselineVideoIds: group.map((x) => x.videoId || x.id).filter(Boolean),
      reason: null
    };
  }

  // 3. Assign outlier metrics per video
  const evaluatedVideos = normalizedVideos.map((v) => {
    const fmt = v.contentType || "unknown";
    const baseline = baselinesByFormat[fmt];

    if (v.dataOrigin === "demo" || v.viewsStatus === "demo") {
      return {
        ...v,
        outlierRatio: null,
        outlierScore: null,
        outlierStatus: "demo",
        outlierReason: "demo_fixture_excluded_from_verified_outliers",
        baselineMedianViews: null,
        baselineSampleSize: 0,
        minSampleRequired: effectiveMinSample,
        ageSkewWarning: null
      };
    }

    if (v.dataOrigin === "legacy_unverified" || v.viewsStatus === "legacy_unverified") {
      return {
        ...v,
        outlierRatio: null,
        outlierScore: null,
        outlierStatus: "unverified_source",
        outlierReason: "legacy_unverified_source_requires_refresh",
        baselineMedianViews: null,
        baselineSampleSize: 0,
        minSampleRequired: effectiveMinSample,
        ageSkewWarning: null
      };
    }

    if (!VALID_BASELINE_FORMATS.has(fmt)) {
      return {
        ...v,
        outlierRatio: null,
        outlierScore: null,
        outlierStatus: "insufficient_data",
        outlierReason: "unknown_video_format_cannot_form_baseline",
        baselineMedianViews: null,
        baselineSampleSize: 0,
        minSampleRequired: effectiveMinSample,
        ageSkewWarning: null
      };
    }

    if (
      !baseline ||
      baseline.status !== "derived" ||
      baseline.medianViews === null ||
      baseline.medianViews <= 0 ||
      v.views === null
    ) {
      const reason =
        v.views === null
          ? "video_views_unknown"
          : baseline?.reason || "insufficient_channel_baseline_sample";
      return {
        ...v,
        outlierRatio: null,
        outlierScore: null,
        outlierStatus: "insufficient_data",
        outlierReason: reason,
        baselineMedianViews: null,
        baselineSampleSize: baseline?.sampleSize ?? 0,
        minSampleRequired: effectiveMinSample,
        ageSkewWarning: null
      };
    }

    const ratio = Number((v.views / baseline.medianViews).toFixed(2));
    const score = computeOutlierTier(ratio);

    return {
      ...v,
      outlierRatio: ratio,
      outlierScore: score,
      outlierStatus: "derived",
      outlierReason: null,
      baselineMedianViews: baseline.medianViews,
      baselineSampleSize: baseline.sampleSize,
      minSampleRequired: effectiveMinSample,
      ageSkewWarning: baseline.ageSkewWarning
    };
  });

  const validRatios = evaluatedVideos
    .filter((v) => v.outlierStatus === "derived")
    .map((v) => v.outlierRatio)
    .filter((r) => typeof r === "number" && Number.isFinite(r));

  const topOutlierRatio = validRatios.length ? Math.max(...validRatios) : null;
  const maxOutlierScore =
    topOutlierRatio !== null ? computeOutlierTier(topOutlierRatio) : null;

  const allDemo =
    normalizedVideos.length > 0 && normalizedVideos.every((v) => v.dataOrigin === "demo");
  const allLegacy =
    normalizedVideos.length > 0 &&
    normalizedVideos.every(
      (v) => v.dataOrigin === "legacy_unverified" || v.viewsStatus === "legacy_unverified"
    );

  const channelOutlierStatus = validRatios.length
    ? "derived"
    : allDemo
      ? "demo"
      : allLegacy
        ? "unverified_source"
        : "insufficient_data";

  const channelOutlierReason = validRatios.length
    ? null
    : allDemo
      ? "demo_fixture_excluded_from_verified_outliers"
      : allLegacy
        ? "legacy_unverified_source_requires_refresh"
        : `Channel has fewer than ${effectiveMinSample} observed videos in any single format`;

  return {
    videos: evaluatedVideos,
    baselinesByFormat,
    maxOutlierScore,
    topOutlierRatio,
    minSampleRequired: effectiveMinSample,
    outlierStatus: channelOutlierStatus,
    outlierReason: channelOutlierReason
  };
}

/**
 * Heuristic keyword classifier for Niche, Format, Faceless, and AI signals.
 * - Empty text returns 'unknown' (null values) — NEVER defaults to isFaceless=true!
 * - Non-empty text returns explicit heuristic labels and matched signals, without fake calibrated probabilities.
 */
export function classifyChannelHeuristic(textBlob = "") {
  const clean = String(textBlob || "").trim();
  if (!clean) {
    return {
      niche: null,
      nicheStatus: "unknown",
      format: null,
      formatStatus: "unknown",
      isFaceless: null,
      facelessLabel: "unknown",
      facelessStatus: "unknown",
      facelessReason: "empty_text_input",
      facelessSignals: [],
      isAiContent: null,
      aiLabel: "unknown",
      aiStatus: "unknown",
      aiSignals: [],
      methodVersion: METRICS_METHOD_VERSION
    };
  }

  const lower = clean.toLowerCase();

  // Niche classification
  let niche = null;
  if (/finance|invest|economy|debt|wall street|billionaire|bank|money|market|stock|crypto|wirtschaft|finanz|財經|경제|tài chính/.test(lower)) {
    niche = "Finance & Investing";
  } else if (/history|ancient|medieval|roman|empire|war|victorian|civilization|century|geschichte|histoire|historia|storia|lịch sử|歴史|역사|歷史/.test(lower)) {
    niche = "History & Civilizations";
  } else if (/crime|detective|fbi|heist|disappear|vanish|forensic|murder|case|interrogation|kriminal|criminel|criminal|vụ án|未解決事件|미스터리|懸案/.test(lower)) {
    niche = "True Crime & Investigations";
  } else if (/space|universe|nasa|cosmos|planet|galaxy|telescope|black hole|astrophysics|universum|astronomie|astronomia|vũ trụ|宇宙|우주/.test(lower)) {
    niche = "Space & Astrophysics";
  } else if (/jung|psychology|stoic|philosophy|mindset|solitude|brain|trauma|habit|tâm lý/.test(lower)) {
    niche = "Psychology & Stoicism";
  } else if (/geopolitics|map|border|strait|military|nato|china|geography|geopolitik|géopolitique|geopolitica|địa chính trị|地政学|지정학|地緣政治/.test(lower)) {
    niche = "Geopolitics & Maps";
  } else if (/ai\b|llm|agent|coding|mcp|software|tech|developer|gpt|automation/.test(lower)) {
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

  // Format classification
  let format = null;
  if (/documentary|untold|story of|how .* happened|investigation|history|sleep|doku|documentaire|documental|documentario|다큐|ドキュメンタリー|紀錄片|tài liệu|hồ sơ/.test(lower)) {
    format = "documentary";
  } else if (/tutorial|how to|setup|workflow|guide|step by step|build|hướng dẫn/.test(lower)) {
    format = "tutorial";
  } else if (/essay|why|philosophy|jung|warning|thoughts|commentary|분析|解説|phân tích/.test(lower)) {
    format = "commentary";
  } else if (/explained|explainer|map|animation|3d|breakdown|giải thích|tóm tắt/.test(lower)) {
    format = "explainer";
  }

  // Faceless vs On-Camera keyword signals
  const facelessPatterns = [
    ["documentary/doku", /documentary|doku|documentaire|documental|documentario|다큐|ドキュメンタリー|紀錄片/],
    ["explained/breakdown", /explained|explainer|breakdown|animation|3d|map|atlas|giải thích|tóm tắt/],
    ["sleep/narration", /for sleep|fall asleep|einschlafen|dormir|睡眠用|수면용/],
    ["archive/files", /archive|files|chronicle|iceberg|lore|hồ sơ/]
  ];
  const onCameraPatterns = [
    ["vlog/personal", /\bvlog\b|my life|day in my life|with me|face reveal/],
    ["interview/podcast", /\bpodcast\b|\binterview\b|q&a|reacts to|reaction/]
  ];

  const matchedFaceless = facelessPatterns
    .filter(([, re]) => re.test(lower))
    .map(([name]) => name);
  const matchedOnCamera = onCameraPatterns
    .filter(([, re]) => re.test(lower))
    .map(([name]) => name);

  let isFaceless = null;
  let facelessLabel = "unknown";
  let facelessStatus = "unknown";
  let facelessReason = "no_decisive_faceless_or_on_camera_keywords";

  if (matchedFaceless.length > 0 && matchedOnCamera.length === 0) {
    isFaceless = true;
    facelessLabel = "likely_faceless";
    facelessStatus = "estimated";
    facelessReason = `Matched faceless text heuristics: ${matchedFaceless.join(", ")}`;
  } else if (matchedOnCamera.length > 0 && matchedFaceless.length === 0) {
    isFaceless = false;
    facelessLabel = "likely_on_camera";
    facelessStatus = "estimated";
    facelessReason = `Matched on-camera text heuristics: ${matchedOnCamera.join(", ")}`;
  } else if (matchedFaceless.length > 0 && matchedOnCamera.length > 0) {
    isFaceless = null;
    facelessLabel = "mixed_or_unclear";
    facelessStatus = "unknown";
    facelessReason = `Conflicting signals (${matchedFaceless.join(", ")} vs ${matchedOnCamera.join(", ")})`;
  }

  const aiPatterns = [
    ["sleep_narration_template", /boring history for sleep|to fall asleep to|zum einschlafen|para dormir|睡眠用|수면용/],
    ["ai_explicit_tag", /\bai generated\b|\bai voice\b|\bneural\b|ゆっくり/]
  ];
  const matchedAi = aiPatterns.filter(([, re]) => re.test(lower)).map(([n]) => n);
  const isAiContent = matchedAi.length > 0 ? true : null;
  const aiLabel = matchedAi.length > 0 ? "heuristic_ai_signals" : "unknown";
  const aiStatus = matchedAi.length > 0 ? "estimated" : "unknown";

  return {
    niche: niche || "General / Unclassified",
    nicheStatus: niche ? "estimated" : "unknown",
    format: format || "unknown",
    formatStatus: format ? "estimated" : "unknown",
    isFaceless,
    facelessLabel,
    facelessStatus,
    facelessReason,
    facelessSignals: [...matchedFaceless, ...matchedOnCamera],
    isAiContent,
    aiLabel,
    aiStatus,
    aiSignals: matchedAi,
    methodVersion: METRICS_METHOD_VERSION
  };
}

/**
 * Scenario-based RPM & Revenue Simulation.
 * Never claims verified competitor revenue; requires explicit assumptions and valid view input.
 */
export function simulateRpmScenario({
  niche = null,
  avgDurationMinutes = null,
  contentType = "long",
  monthlyViews = null,
  countryMultiplier = 1.0
} = {}) {
  const hasViews =
    typeof monthlyViews === "number" && Number.isFinite(monthlyViews) && monthlyViews > 0;

  const isShorts =
    contentType === "shorts" ||
    (typeof avgDurationMinutes === "number" && avgDurationMinutes > 0 && avgDurationMinutes <= 1.0);

  const info = (niche && NICHE_CPM_TABLE[niche]) || {
    baseCpm: 8.5,
    tier1Share: 0.55
  };

  let estimatedRpm;
  let durationFactor = 1.0;

  if (isShorts) {
    estimatedRpm = Number((0.12 * countryMultiplier).toFixed(2));
  } else {
    if (typeof avgDurationMinutes === "number" && avgDurationMinutes > 0) {
      durationFactor =
        avgDurationMinutes >= 30
          ? 1.55
          : avgDurationMinutes >= 15
            ? 1.35
            : avgDurationMinutes >= 8
              ? 1.2
              : 0.85;
    }
    const creatorShare = 0.55;
    const weightedCpm =
      info.baseCpm * info.tier1Share + info.baseCpm * 0.35 * (1 - info.tier1Share);
    estimatedRpm = Number(
      (weightedCpm * durationFactor * countryMultiplier * creatorShare).toFixed(2)
    );
  }

  const assumptions = {
    isScenarioSimulation: true,
    nicheAssumed: niche || "General / Unclassified",
    baseCpmUsd: info.baseCpm,
    assumedTier1AudienceShare: info.tier1Share,
    countryMarketMultiplier: countryMultiplier,
    durationMidrollFactor: durationFactor,
    youtubeCreatorShare: 0.55,
    disclaimer:
      "Scenario simulation only. Actual RPM and revenue are private to YouTube Studio and depend on real viewer geography, ad blockers, and advertiser demand."
  };

  if (!hasViews) {
    return {
      estimatedRpm,
      rpmStatus: "estimated",
      monthlyRevenueMin: null,
      monthlyRevenueMax: null,
      revenueStatus: "unknown",
      revenueReason: "monthly_views_unknown_cannot_simulate_monthly_revenue",
      assumptions,
      methodVersion: METRICS_METHOD_VERSION
    };
  }

  const baseMonthlyRev = (monthlyViews / 1000) * estimatedRpm;
  return {
    estimatedRpm,
    rpmStatus: "estimated",
    monthlyRevenueMin: Math.round(baseMonthlyRev * 0.75),
    monthlyRevenueMax: Math.round(baseMonthlyRev * 1.25),
    revenueStatus: "estimated",
    revenueReason: "scenario_simulation_from_observed_or_user_views",
    assumptions,
    methodVersion: METRICS_METHOD_VERSION
  };
}

/**
 * Computes honest channel-level metrics strictly from observed channel metadata and observed videos.
 * Never fabricates subscribers, totalViews, videoCount, channelAgeMonths, YPP, or 48h sine series!
 */
export function buildHonestChannelRecord({
  id,
  channelId,
  handle = null,
  title = "",
  description = "",
  avatarUrl = null,
  observedSubscribers = null,
  observedTotalViews = null,
  observedVideoCount = null,
  observedChannelCountry = null,
  observedJoinedAt = null,
  observedContentLanguage = null,
  isKidsContent = null,
  discoveryMarket = null,
  videos = [],
  minOutlierSampleSize = DEFAULT_MIN_OUTLIER_SAMPLE_SIZE,
  dataOrigin = "observed",
  collectedAt = new Date().toISOString()
} = {}) {
  const resolvedId = id || channelId;
  const safeVideos = Array.isArray(videos) ? videos : [];

  // 1. Evaluate video-level outliers strictly within format groups & eligible origins (T03, T04)
  const outlierEval = evaluateChannelVideosOutliers(safeVideos, {
    minSampleSize: minOutlierSampleSize,
    channelDataOrigin: dataOrigin
  });

  // 2. Observed video statistics (only if we have observed videos with views)
  const validViews = outlierEval.videos
    .map((v) => v.views)
    .filter((v) => typeof v === "number" && Number.isFinite(v));

  const medianViews = validViews.length >= 1 ? computeMedian(validViews) : null;
  const avgViews = validViews.length >= 1 ? computeTrimmedMean(validViews) : null;

  const validDurations = outlierEval.videos
    .map((v) => v.durationMinutes)
    .filter((d) => typeof d === "number" && Number.isFinite(d) && d > 0);
  const avgDurationMinutes =
    validDurations.length >= 1
      ? Number((validDurations.reduce((a, b) => a + b, 0) / validDurations.length).toFixed(1))
      : null;

  // Dominant content type from individual videos (never from channel average duration)
  const formatCounts = { long: 0, shorts: 0, live: 0, unknown: 0 };
  for (const v of outlierEval.videos) {
    formatCounts[v.contentType || "unknown"] =
      (formatCounts[v.contentType || "unknown"] || 0) + 1;
  }
  let dominantContentType = "unknown";
  if (formatCounts.long > 0 && formatCounts.shorts === 0) dominantContentType = "long";
  else if (formatCounts.shorts > 0 && formatCounts.long === 0) dominantContentType = "shorts";
  else if (formatCounts.long > 0 && formatCounts.shorts > 0) dominantContentType = "mixed";
  else if (formatCounts.live > 0) dominantContentType = "live";

  // 3. Separate Channel Age (derived from observedJoinedAt) vs Oldest Observed Video Age (T17, T18)
  let channelAgeMonths = null;
  let channelAgeStatus = "unknown";
  let channelAgeReason = "channel_join_date_not_fetched";
  if (observedJoinedAt) {
    const joinedMs = Date.parse(observedJoinedAt);
    if (Number.isFinite(joinedMs)) {
      channelAgeMonths = Number(
        Math.max(0.1, (Date.now() - joinedMs) / (86400_000 * 30.4375)).toFixed(1)
      );
      channelAgeStatus = "derived";
      channelAgeReason = null;
    }
  }

  const validDays = outlierEval.videos
    .map((v) => v.publishedDaysAgo)
    .filter((d) => typeof d === "number" && Number.isFinite(d) && d >= 0);
  const oldestObservedVideoDays =
    validDays.length >= 1 ? Number(Math.max(...validDays).toFixed(1)) : null;

  // Upload frequency in observed sample (only when >= 3 videos with valid publish dates)
  let uploadFrequencyPerMonth = null;
  if (validDays.length >= 3 && oldestObservedVideoDays && oldestObservedVideoDays >= 7) {
    uploadFrequencyPerMonth = Number(
      ((validDays.length / oldestObservedVideoDays) * 30).toFixed(1)
    );
  }

  // 4. Heuristic text classification (only from actual channel/video text)
  const combinedText = [
    title || "",
    description || "",
    ...outlierEval.videos.map((v) => v.title || "")
  ]
    .join(" ")
    .trim();
  const heuristic = classifyChannelHeuristic(combinedText);

  // 5. Observed 30d upload views (T17: explicitly named viewsOfObservedRecentUploads, NOT total channel monthlyViews!)
  const videosLast30d = outlierEval.videos.filter(
    (v) => v.views !== null && v.publishedDaysAgo !== null && v.publishedDaysAgo <= 30
  );
  const viewsOfObservedRecentUploads =
    videosLast30d.length > 0
      ? videosLast30d.reduce((sum, v) => sum + v.views, 0)
      : null;

  // 6. Scenario RPM Simulation (clearly marked as estimated scenario, null revenue if views unknown)
  const rpmScenario = simulateRpmScenario({
    niche: heuristic.niche,
    avgDurationMinutes,
    contentType: dominantContentType === "shorts" ? "shorts" : "long",
    monthlyViews: null, // True 30-day channel views require comparable snapshots or user scenario input
    countryMultiplier: 1.0
  });

  // 7. Attach format-aware scenario revenue per video only when video views are known
  const videosWithScenario = outlierEval.videos.map((v) => {
    const vRpm =
      v.contentType === "shorts"
        ? 0.12
        : rpmScenario.estimatedRpm;
    return {
      ...v,
      estimatedRevenue:
        v.views !== null && vRpm !== null
          ? Math.round((v.views / 1000) * vRpm)
          : null,
      estimatedRevenueStatus:
        v.views !== null ? "estimated" : "unknown"
    };
  });

  return {
    id: resolvedId,
    handle: handle || null,
    title: title || "Unknown Channel",
    description: description || "",
    avatarUrl: avatarUrl || null,
    dataOrigin, // 'observed' | 'legacy_unverified' | 'demo' | 'imported_pending'
    collectedAt,

    // Strictly separated market & geography fields
    discoveryMarket: discoveryMarket || null,
    channelCountry: observedChannelCountry || null,
    channelCountryStatus: observedChannelCountry ? "observed" : "unknown",
    contentLanguage: observedContentLanguage || null,
    contentLanguageStatus: observedContentLanguage ? "observed" : "unknown",
    audienceGeography: null,
    audienceGeographyStatus: "unknown",
    audienceGeographyReason: "YouTube Studio audience geography is private to channel owner",

    // Heuristic classification (explicitly labeled, no fake calibrated confidence)
    niche: heuristic.niche,
    nicheStatus: heuristic.nicheStatus,
    format: heuristic.format,
    formatStatus: heuristic.formatStatus,
    contentType: dominantContentType,
    isFaceless: heuristic.isFaceless,
    facelessLabel: heuristic.facelessLabel,
    facelessStatus: heuristic.facelessStatus,
    facelessReason: heuristic.facelessReason,
    facelessSignals: heuristic.facelessSignals,
    facelessConfidence: null,
    isAiContent: heuristic.isAiContent,
    aiLabel: heuristic.aiLabel,
    aiStatus: heuristic.aiStatus,
    aiSignals: heuristic.aiSignals,

    // Monetization (YPP) cannot be inferred from subscribers >= 1000
    isMonetized: null,
    monetizationStatus: "unknown",
    monetizationReason:
      "YPP monetization status is private and cannot be verified from subscriber count or public metadata",
    isKidsContent: typeof isKidsContent === "boolean" ? isKidsContent : null,

    // Channel-level statistics (null if not enriched from channel page / API)
    subscribers:
      typeof observedSubscribers === "number" && Number.isFinite(observedSubscribers)
        ? Math.round(observedSubscribers)
        : null,
    subscribersStatus:
      typeof observedSubscribers === "number" && Number.isFinite(observedSubscribers)
        ? "observed"
        : "unknown",
    totalViews:
      typeof observedTotalViews === "number" && Number.isFinite(observedTotalViews)
        ? Math.round(observedTotalViews)
        : null,
    totalViewsStatus:
      typeof observedTotalViews === "number" && Number.isFinite(observedTotalViews)
        ? "observed"
        : "unknown",
    videoCount:
      typeof observedVideoCount === "number" && Number.isFinite(observedVideoCount)
        ? Math.round(observedVideoCount)
        : null,
    videoCountStatus:
      typeof observedVideoCount === "number" && Number.isFinite(observedVideoCount)
        ? "observed"
        : "unknown",
    observedVideoSampleCount: videosWithScenario.length,

    // Sample-derived metrics
    avgViews,
    medianViews,
    avgDurationMinutes,
    uploadFrequencyPerMonth,
    channelJoinedAt: observedJoinedAt || null,
    channelAgeMonths,
    channelAgeStatus,
    channelAgeReason,
    oldestObservedVideoDays,

    // Growth & Realtime tracking (only populated when >= 2 comparable snapshots exist)
    growthRate30d: null,
    growthStatus: "not_comparable",
    realtime48hViews: null,
    hourly48hSeries: [],

    // Scenario RPM & Revenue simulation
    estimatedRpm: rpmScenario.estimatedRpm,
    rpmStatus: rpmScenario.rpmStatus,
    monthlyViews: null,
    monthlyViewsStatus: "unknown",
    viewsOfObservedRecentUploads,
    viewsOfObservedRecentUploadsStatus:
      viewsOfObservedRecentUploads !== null ? "derived" : "unknown",
    monthlyRevenueMin: null,
    monthlyRevenueMax: null,
    revenueStatus: "unknown",
    revenueAssumptions: rpmScenario.assumptions,

    // Outlier summary
    maxOutlierScore: outlierEval.maxOutlierScore,
    topOutlierRatio: outlierEval.topOutlierRatio,
    minSampleRequired: outlierEval.minSampleRequired,
    outlierStatus: outlierEval.outlierStatus,
    outlierReason: outlierEval.outlierReason,
    baselinesByFormat: outlierEval.baselinesByFormat,

    videos: videosWithScenario,
    provenance: {
      methodVersion: METRICS_METHOD_VERSION,
      minOutlierSampleSize: outlierEval.minSampleRequired,
      subscribersMetric: createMetric({
        value: observedSubscribers,
        status: observedSubscribers !== null ? "observed" : "unknown",
        source: dataOrigin,
        collectedAt,
        reason: observedSubscribers !== null ? null : "channel_header_not_enriched"
      }),
      outlierMetric: createMetric({
        value: outlierEval.topOutlierRatio,
        status: outlierEval.outlierStatus,
        source: dataOrigin,
        collectedAt,
        sampleSize: videosWithScenario.length,
        minRequired: outlierEval.minSampleRequired,
        methodVersion: METRICS_METHOD_VERSION,
        reason: outlierEval.outlierReason
      }),
      rpmScenarioMetric: createMetric({
        value: rpmScenario.estimatedRpm,
        status: "estimated",
        source: "scenario_benchmark_table",
        collectedAt,
        methodVersion: METRICS_METHOD_VERSION,
        assumptions: rpmScenario.assumptions
      })
    }
  };
}
