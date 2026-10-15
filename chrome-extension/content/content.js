// Nexlev Team Studio — YouTube Content Script Overlay (Batch 4)
// Extracts canonical videoId/channelId/thumbnailUrl, uses same-channel baseline (never feed median!),
// verifies res.ok before reporting "Đã lưu", and handles YouTube SPA navigation safely.

function parseViewsFromText(text = "") {
  const clean = String(text || "").replace(/,/g, "");
  const m = clean.match(
    /([\d.]+)\s*([KMBkmb]|N|Tr|만|억|万|億)?\s*(views|lượt xem|회|回|次|Aufrufe|vues|visualizzazioni|weergaven|visualizações|vistas)/i
  );
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!Number.isFinite(val)) return null;
  const unit = (m[2] || "").toUpperCase();
  if (unit === "K" || unit === "N") return Math.round(val * 1_000);
  if (unit === "만" || unit === "万") return Math.round(val * 10_000);
  if (unit === "M" || unit === "TR") return Math.round(val * 1_000_000);
  if (unit === "억" || unit === "億") return Math.round(val * 100_000_000);
  if (unit === "B") return Math.round(val * 1_000_000_000);
  return Math.round(val);
}

function estimateScenarioRpmFromTitle(title = "") {
  const lower = String(title || "").toLowerCase();
  if (/finance|money|invest|bank|debt|economy|million|billion/.test(lower)) return 10.5;
  if (/ai|agent|coding|mcp|software|tech/.test(lower)) return 8.8;
  if (/history|roman|medieval|sleep|empire|ancient|crime|flight/.test(lower)) return 6.8;
  return 5.2;
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

  const titleEl =
    card.querySelector("#video-title") ||
    card.querySelector("a#video-title-link");
  const title = (titleEl?.textContent || "").trim();

  // Channel info from card or current channel page URL
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

let currentMinOutlier = 0;
let isProcessingBatch = false;
let observerDebounceTimer = null;

function isOnSingleChannelPage() {
  const p = window.location.pathname || "";
  return p.startsWith("/@") || p.startsWith("/channel/") || p.startsWith("/c/");
}

function ensureHomepageBar() {
  if (document.querySelector(".nx-yt-bar")) return;
  const target =
    document.querySelector("ytd-rich-grid-renderer") ||
    document.querySelector("#primary #contents");
  if (!target || !target.parentElement) return;

  const bar = document.createElement("div");
  bar.className = "nx-yt-bar";
  bar.innerHTML = `
    <span class="nx-yt-logo">⚡ NEXLEV TEAM STUDIO</span>
    <button type="button" class="nx-yt-btn active" data-nx-filter="0">Tất Cả Video</button>
    <button type="button" class="nx-yt-btn" data-nx-filter="1.8">🔥 Outliers (&ge; 1.8x cùng kênh)</button>
    <button type="button" class="nx-yt-btn" data-nx-filter="3.0">🚀 Super Outliers (&ge; 3.0x)</button>
    <a href="http://127.0.0.1:3088" target="_blank" rel="noopener noreferrer" class="nx-yt-btn" style="text-decoration:none;margin-left:auto;">📊 Mở Team Dashboard</a>
  `;

  target.parentElement.insertBefore(bar, target);

  bar.querySelectorAll("[data-nx-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      bar.querySelectorAll("[data-nx-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentMinOutlier = parseFloat(btn.dataset.nxFilter || "0");
      applyOutlierFilterToCards();
    });
  });
}

function applyOutlierFilterToCards() {
  const cards = document.querySelectorAll(
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer"
  );
  cards.forEach((card) => {
    const status = card.dataset.nxOutlierStatus || "insufficient_data";
    const ratio = parseFloat(card.dataset.nxOutlierRatio || "0");
    if (currentMinOutlier > 0 && (status !== "derived" || ratio < currentMinOutlier)) {
      card.style.display = "none";
    } else {
      card.style.display = "";
    }
  });
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

    ensureHomepageBar();

    const allCards = Array.from(
      document.querySelectorAll(
        "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer"
      )
    );
    if (allCards.length === 0) return;

    // If on a single channel page, compute same-channel median baseline when >= 3 videos exist
    let sameChannelPageMedian = null;
    let sameChannelSampleSize = 0;
    if (isOnSingleChannelPage()) {
      const channelViews = allCards
        .map((c) => extractCardMetadata(c).views)
        .filter((v) => typeof v === "number" && v > 0);
      if (channelViews.length >= 3) {
        sameChannelPageMedian = computeMedian(channelViews);
        sameChannelSampleSize = channelViews.length;
      }
    }

    const unprocessed = allCards.filter((c) => !c.dataset.nxProcessed);
    if (unprocessed.length === 0) return;

    // Extract metadata for unprocessed cards and query backend for known channel baselines
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
        // Offline or extension reload; fall back to insufficient_data unless on channel page
      }
    }

    for (const { card, meta } of metas) {
      if (!meta.title || !meta.videoId) continue;
      card.dataset.nxProcessed = "1";
      card.dataset.nxVideoId = meta.videoId;

      // Remove any stale badge strip before inserting
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
        chBackend &&
        chBackend.outlierStatus === "derived" &&
        chBackend.medianViews > 0 &&
        meta.views !== null
      ) {
        outlierRatio = Number((meta.views / chBackend.medianViews).toFixed(2));
        outlierStatus = "derived";
        sampleSize = chBackend.observedVideoSampleCount || 3;
      } else if (sameChannelPageMedian && sameChannelPageMedian > 0 && meta.views !== null) {
        outlierRatio = Number((meta.views / sameChannelPageMedian).toFixed(2));
        outlierStatus = "derived";
        sampleSize = sameChannelSampleSize;
      }

      card.dataset.nxOutlierStatus = outlierStatus;
      card.dataset.nxOutlierRatio = outlierRatio !== null ? String(outlierRatio) : "0";

      const rpm =
        vBackend?.estimatedRpm ||
        chBackend?.estimatedRpm ||
        estimateScenarioRpmFromTitle(meta.title);

      const strip = document.createElement("div");
      strip.className = "nx-yt-badge-strip";

      const outlierPill = document.createElement("span");
      if (outlierStatus === "derived" && outlierRatio !== null) {
        outlierPill.className = `nx-yt-pill ${outlierRatio >= 2.5 ? "hot" : ""}`;
        outlierPill.textContent = `🔥 ${outlierRatio}x Outlier (n=${sampleSize})`;
      } else {
        outlierPill.className = "nx-yt-pill";
        outlierPill.textContent = "⏳ Chưa đủ dữ liệu baseline";
        outlierPill.title =
          "Cần tối thiểu 3 video cùng kênh để tính Outlier (Không dùng median trang chủ).";
      }

      const rpmPill = document.createElement("span");
      rpmPill.className = "nx-yt-pill";
      rpmPill.textContent = `💎 ~$${rpm} RPM (Kịch bản)`;

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "nx-yt-save-btn";
      saveBtn.textContent = "🗂️ Lưu Ý Tưởng";

      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        saveBtn.disabled = true;
        saveBtn.textContent = "⏳ Đang lưu...";

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

          // CRITICAL: Only show "✅ Đã lưu!" when backend responds ok === true!
          if (response && response.ok === true) {
            saveBtn.textContent = "✅ Đã lưu!";
          } else {
            saveBtn.disabled = false;
            saveBtn.textContent = "❌ Lỗi lưu (Thử lại)";
            saveBtn.title = response?.error || "Backend từ chối hoặc không phản hồi";
          }
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = "❌ Lỗi kết nối";
          saveBtn.title = err?.message || "Lỗi kết nối tới service worker";
        }
      });

      strip.appendChild(outlierPill);
      strip.appendChild(rpmPill);
      strip.appendChild(saveBtn);

      const metaBlock =
        card.querySelector("#meta") ||
        card.querySelector("#details") ||
        card.querySelector("#dismissible");
      if (metaBlock) {
        metaBlock.appendChild(strip);
      }
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

// Reset processed markers on YouTube SPA navigation
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
