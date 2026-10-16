// Nexlev Studio v2.1 — YouTube Content Script Overlay (Section 11 & T12)
// - Uses multi-locale decimal/thousand count parsing ("1,2 Mio. Aufrufe" -> 1,200,000)
// - Separates Shorts vs Long-form (>180s) when computing same-channel baseline
// - Never injects a top homepage banner and never hides YouTube cards
// - Batches DOM updates with requestAnimationFrame
// - Strictly verifies response.ok === true before showing "Đã lưu"

const MULTIPLIER_UNITS = [
  { pattern: /^(b|bn|billion|milliard|milliarden|mrd\.?|tỷ|ty)$/i, mult: 1_000_000_000 },
  { pattern: /^(억|億)$/i, mult: 100_000_000 },
  { pattern: /^(m|mio\.?|million|millions|mln|tr|triệu|trieu|mi)$/i, mult: 1_000_000 },
  { pattern: /^(만|万)$/i, mult: 10_000 },
  { pattern: /^(k|n|nghìn|nghin|ngàn|ngan|tsd\.?|mil)$/i, mult: 1_000 }
];

function parseNumericTokenMultiLocale(numStr, hasCompactUnit) {
  const s = String(numStr || "").trim().replace(/\s+/g, "");
  if (!s) return NaN;
  if (hasCompactUnit) {
    if (s.includes(",") && !s.includes(".")) {
      return Number(s.replace(",", "."));
    }
    if (s.includes(",") && s.includes(".")) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");
      if (lastComma > lastDot) {
        return Number(s.replace(/\./g, "").replace(",", "."));
      }
      return Number(s.replace(/,/g, ""));
    }
    return Number(s);
  }
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
  return Number(s.replace(/,/g, ""));
}

function parseViewsFromText(text = "") {
  const raw = String(text || "");
  if (!raw) return null;
  // Extract substring near view keywords across locales
  const viewLineMatch = raw.match(
    /([\d.,\s]+\s*(?:K|M|B|N|Tr|Mio\.?|Mrd\.?|Tsd\.?|만|억|万|億)?)\s*(?:views|lượt xem|회|回|次|Aufrufe|vues|visualizzazioni|weergaven|visualizações|vistas)/i
  );
  const candidate = viewLineMatch ? viewLineMatch[1].trim() : "";
  if (!candidate) return null;

  const tokenMatch = candidate.match(/^([0-9][0-9.,\s]*)\s*([^\d\s.,]+)?$/);
  if (!tokenMatch) return null;
  const numPart = tokenMatch[1].trim();
  const unitPart = (tokenMatch[2] || "").trim().replace(/\.$/, "");

  let mult = 1;
  let hasCompactUnit = false;
  if (unitPart) {
    for (const u of MULTIPLIER_UNITS) {
      if (u.pattern.test(unitPart) || u.pattern.test(`${unitPart}.`)) {
        mult = u.mult;
        hasCompactUnit = true;
        break;
      }
    }
    if (!hasCompactUnit) return null;
  }

  const base = parseNumericTokenMultiLocale(numPart, hasCompactUnit);
  if (!Number.isFinite(base) || base < 0) return null;
  return Math.round(base * mult);
}

function parseCardDurationSeconds(card) {
  const badgeEl =
    card.querySelector("ytd-thumbnail-overlay-time-status-renderer #text") ||
    card.querySelector("badge-shape .yt-badge-shape__text") ||
    card.querySelector("span.ytd-thumbnail-overlay-time-status-renderer");
  const txt = (badgeEl?.textContent || "").trim();
  if (!txt) return null;
  if (/^(shorts|live|trực tiếp)$/i.test(txt)) return null;
  const parts = txt.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function extractCardMetadata(card) {
  const linkEl =
    card.querySelector("a#video-title-link[href]") ||
    card.querySelector("a#video-title[href]") ||
    card.querySelector("a#thumbnail[href]");
  const rawHref = linkEl?.getAttribute("href") || "";

  let videoId = null;
  let isShorts = false;
  if (rawHref.includes("watch?v=")) {
    const m = rawHref.match(/[?&]v=([a-zA-Z0-9_-]{6,15})/);
    if (m) videoId = m[1];
  } else if (rawHref.includes("/shorts/")) {
    const m = rawHref.match(/\/shorts\/([a-zA-Z0-9_-]{6,15})/);
    if (m) {
      videoId = m[1];
      isShorts = true;
    }
  }

  const durationSeconds = parseCardDurationSeconds(card);
  const contentType = isShorts
    ? "shorts"
    : durationSeconds !== null && durationSeconds > 180
      ? "long"
      : "unknown";

  const titleEl =
    card.querySelector("#video-title") ||
    card.querySelector("a#video-title-link");
  const title = (titleEl?.textContent || "").trim();

  const chLinkEl =
    card.querySelector("ytd-channel-name a[href]") ||
    card.querySelector("#channel-name a[href]") ||
    card.querySelector("a.yt-simple-endpoint[href^='/@']") ||
    card.querySelector("a.yt-simple-endpoint[href^='/channel/']");

  let channelHref = chLinkEl?.getAttribute("href") || "";
  if (
    !channelHref &&
    (window.location.pathname.startsWith("/@") ||
      window.location.pathname.startsWith("/channel/"))
  ) {
    channelHref = window.location.pathname;
  }

  let channelId = null;
  let channelHandle = null;
  if (channelHref.startsWith("/channel/")) {
    channelId = channelHref.split("/")[2] || null;
  } else if (channelHref.startsWith("/@")) {
    channelHandle = channelHref.split("/")[1] || null;
  }

  const channelTitle =
    (
      chLinkEl?.textContent ||
      document.querySelector("ytd-channel-name #text")?.textContent ||
      ""
    ).trim() ||
    channelHandle ||
    "YouTube Channel";

  const imgEl = card.querySelector("img#img, ytd-thumbnail img");
  const rawImg = imgEl?.getAttribute("src") || "";
  const thumbnailUrl =
    rawImg.startsWith("http://") || rawImg.startsWith("https://")
      ? rawImg
      : videoId
        ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        : "";

  const canonicalUrl = videoId
    ? isShorts
      ? `https://www.youtube.com/shorts/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`
    : "";

  const views = parseViewsFromText(card.innerText || "");

  return {
    videoId,
    title,
    isShorts,
    durationSeconds,
    contentType,
    channelId,
    channelHandle,
    channelTitle,
    thumbnailUrl,
    canonicalUrl,
    views
  };
}

function computeMedian(nums = []) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

let isProcessingBatch = false;
let observerDebounceTimer = null;

function isOnSingleChannelPage() {
  const p = window.location.pathname || "";
  return p.startsWith("/@") || p.startsWith("/channel/") || p.startsWith("/c/");
}

async function processVideoCardsBatch() {
  if (isProcessingBatch) return;
  isProcessingBatch = true;

  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const cfg = await chrome.storage.local.get(["overlayEnabled"]);
      if (cfg.overlayEnabled === false) {
        return;
      }
    }

    const allCards = Array.from(
      document.querySelectorAll(
        "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer"
      )
    );
    if (allCards.length === 0) return;

    // On a single channel page, compute format-stratified baselines (long vs shorts) when n >= 3
    const sameChannelBaselines = {
      long: { median: null, sampleSize: 0 },
      shorts: { median: null, sampleSize: 0 }
    };
    if (isOnSingleChannelPage()) {
      const extractedAll = allCards.map((c) => extractCardMetadata(c));
      for (const fmt of ["long", "shorts"]) {
        const fmtViews = extractedAll
          .filter((m) => m.contentType === fmt && typeof m.views === "number" && m.views > 0)
          .map((m) => m.views);
        if (fmtViews.length >= 3) {
          sameChannelBaselines[fmt] = {
            median: computeMedian(fmtViews),
            sampleSize: fmtViews.length
          };
        }
      }
    }

    const unprocessed = allCards.filter((c) => !c.dataset.nxProcessed);
    if (unprocessed.length === 0) return;

    const metas = unprocessed.map((card) => ({
      card,
      meta: extractCardMetadata(card)
    }));

    const videoIds = metas.map((m) => m.meta.videoId).filter(Boolean);
    const channelIds = metas.map((m) => m.meta.channelId).filter(Boolean);
    const handles = metas.map((m) => m.meta.channelHandle).filter(Boolean);

    let backendMetrics = { videos: {}, channels: {} };
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime?.sendMessage &&
      (videoIds.length > 0 || channelIds.length > 0 || handles.length > 0)
    ) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "FETCH_BATCH_METRICS",
          payload: { videoIds, channelIds, handles }
        });
        if (res && res.ok) {
          backendMetrics = res;
        }
      } catch {
        // Offline or unauthenticated
      }
    }

    // Batch DOM writes using requestAnimationFrame
    const BATCH_SIZE = 20;
    for (let i = 0; i < metas.length; i += BATCH_SIZE) {
      const slice = metas.slice(i, i + BATCH_SIZE);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          for (const { card, meta } of slice) {
            if (!meta.title || !meta.videoId) continue;
            card.dataset.nxProcessed = "1";
            card.dataset.nxVideoId = meta.videoId;

            card.querySelectorAll(".nx-yt-badge-strip").forEach((el) => el.remove());

            const vBackend = backendMetrics.videos?.[meta.videoId];
            const chBackend =
              (meta.channelId && backendMetrics.channels?.[meta.channelId]) ||
              (meta.channelHandle && backendMetrics.channels?.[meta.channelHandle]);

            let outlierRatio = null;
            let outlierStatus = "insufficient_data";
            let sampleSize = 0;

            if (vBackend && vBackend.outlierStatus === "derived" && vBackend.outlierRatio !== null) {
              outlierRatio = vBackend.outlierRatio;
              outlierStatus = "derived";
              sampleSize = vBackend.baselineSampleSize || 3;
            } else if (
              meta.contentType === "long" &&
              chBackend &&
              chBackend.outlierStatus === "derived" &&
              chBackend.medianViews > 0 &&
              meta.views !== null
            ) {
              outlierRatio = Number((meta.views / chBackend.medianViews).toFixed(2));
              outlierStatus = "derived";
              sampleSize = chBackend.observedVideoSampleCount || 3;
            } else if (
              (meta.contentType === "long" || meta.contentType === "shorts") &&
              sameChannelBaselines[meta.contentType]?.median > 0 &&
              meta.views !== null
            ) {
              const b = sameChannelBaselines[meta.contentType];
              outlierRatio = Number((meta.views / b.median).toFixed(2));
              outlierStatus = "derived";
              sampleSize = b.sampleSize;
            }

            const rpm = vBackend?.estimatedRpm ?? chBackend?.estimatedRpm ?? null;

            const strip = document.createElement("div");
            strip.className = "nx-yt-badge-strip";

            const outlierPill = document.createElement("span");
            if (outlierStatus === "derived" && outlierRatio !== null) {
              const cls =
                outlierRatio >= 3 ? "positive" : outlierRatio >= 1.5 ? "warning" : "";
              outlierPill.className = `nx-yt-pill ${cls}`;
              outlierPill.textContent = `${outlierRatio.toFixed(1)}x (n=${sampleSize})`;
            } else {
              outlierPill.className = "nx-yt-pill";
              outlierPill.textContent = "Chưa đủ mẫu";
              outlierPill.title =
                "Cần tối thiểu 3 video cùng định dạng từ cùng một kênh để tính Outlier.";
            }
            strip.appendChild(outlierPill);

            if (rpm !== null && Number.isFinite(Number(rpm))) {
              const rpmPill = document.createElement("span");
              rpmPill.className = "nx-yt-pill";
              rpmPill.textContent = `~$${Number(rpm).toFixed(2)} RPM`;
              rpmPill.title = "RPM kịch bản ước tính từ kho dữ liệu Nexlev";
              strip.appendChild(rpmPill);
            }

            const saveBtn = document.createElement("button");
            saveBtn.type = "button";
            saveBtn.className = "nx-yt-save-btn";
            saveBtn.textContent = "+ Lưu ý tưởng";

            saveBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              e.preventDefault();
              saveBtn.disabled = true;
              saveBtn.textContent = "Đang lưu...";

              try {
                const response = await chrome.runtime.sendMessage({
                  type: "SAVE_SWIPE_ITEM",
                  payload: {
                    videoId: meta.videoId,
                    channelId: meta.channelId || vBackend?.channelId || chBackend?.channelId || null,
                    canonicalUrl: meta.canonicalUrl,
                    thumbnailUrl: meta.thumbnailUrl,
                    title: meta.title,
                    channelTitle: meta.channelTitle,
                    channelHandle: meta.channelHandle || vBackend?.channelHandle || "",
                    outlierRatio,
                    views: meta.views,
                    estimatedRpm: rpm,
                    workflowStage: "discovered",
                    tags: [
                      "YouTube Extension",
                      outlierRatio !== null ? `${outlierRatio}x Outlier` : "Insufficient Baseline"
                    ],
                    notes: `Lưu từ YouTube (${meta.canonicalUrl})`
                  }
                });

                if (response && response.ok === true) {
                  saveBtn.textContent = "Đã lưu";
                } else {
                  saveBtn.disabled = false;
                  saveBtn.textContent = "Lỗi lưu (Thử lại)";
                  saveBtn.title = response?.error || "Vui lòng kiểm tra API Token trong Popup Extension";
                }
              } catch (err) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Lỗi kết nối";
                saveBtn.title = err?.message || "Lỗi kết nối tới service worker";
              }
            });

            strip.appendChild(saveBtn);

            const metaBlock =
              card.querySelector("#meta") ||
              card.querySelector("#details") ||
              card.querySelector("#dismissible");
            if (metaBlock) {
              metaBlock.appendChild(strip);
            }
          }
          resolve();
        })
      );
    }
  } finally {
    isProcessingBatch = false;
  }
}

function scheduleProcessCards() {
  clearTimeout(observerDebounceTimer);
  observerDebounceTimer = setTimeout(() => {
    processVideoCardsBatch();
  }, 300);
}

window.addEventListener("yt-navigate-finish", () => {
  document
    .querySelectorAll("[data-nx-processed]")
    .forEach((el) => delete el.dataset.nxProcessed);
  scheduleProcessCards();
});

const observer = new MutationObserver(() => {
  scheduleProcessCards();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

scheduleProcessCards();
