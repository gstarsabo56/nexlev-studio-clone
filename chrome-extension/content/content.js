function parseViewsFromText(text = "") {
  const clean = String(text).replace(/,/g, "");
  const m = clean.match(/([\d.]+)\s*([KMBkmb]|N|Tr)?\s*(views|lượt xem)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  if (unit === "K" || unit === "N") return Math.round(val * 1_000);
  if (unit === "M" || unit === "TR") return Math.round(val * 1_000_000);
  if (unit === "B") return Math.round(val * 1_000_000_000);
  return Math.round(val);
}

function estimateRpmFromTitle(title = "") {
  const lower = title.toLowerCase();
  if (/finance|money|invest|bank|debt|economy|million|billion/.test(lower)) return 14.8;
  if (/ai|agent|coding|mcp|software|tech/.test(lower)) return 12.6;
  if (/history|roman|medieval|sleep|empire|ancient|crime|flight/.test(lower)) return 9.8;
  return 7.4;
}

let currentMinOutlier = 0;

function ensureHomepageBar() {
  if (document.querySelector(".nx-yt-bar")) return;
  const target =
    document.querySelector("ytd-rich-grid-renderer") ||
    document.querySelector("#primary #contents");
  if (!target || !target.parentElement) return;

  const bar = document.createElement("div");
  bar.className = "nx-yt-bar";
  bar.innerHTML = `
    <span class="nx-yt-logo">⚡ NEXLEV STUDIO</span>
    <button type="button" class="nx-yt-btn active" data-nx-filter="0">Tất Cả Video</button>
    <button type="button" class="nx-yt-btn" data-nx-filter="1.8">🔥 Outliers (&gt;= 1.8x)</button>
    <button type="button" class="nx-yt-btn" data-nx-filter="3.0">🚀 Super Outliers (&gt;= 3.0x)</button>
    <button type="button" class="nx-yt-btn" id="nx-btn-test-thumb">🧪 Chèn Thử Thumbnail Của Tôi</button>
    <a href="http://localhost:3088" target="_blank" class="nx-yt-btn" style="text-decoration:none;margin-left:auto;">📊 Mở Dashboard (21 Filters)</a>
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

  const testBtn = bar.querySelector("#nx-btn-test-thumb");
  if (testBtn) {
    testBtn.addEventListener("click", () => {
      const customTitle = window.prompt(
        "Nhập Tiêu đề Video bạn muốn test trên lưới trang chủ YouTube:",
        "Why Nobody Talks About Daily Life in a Roman Legion (2 Hours)"
      );
      if (!customTitle) return;
      const firstCard = document.querySelector("ytd-rich-item-renderer, ytd-video-renderer");
      if (!firstCard) return;
      const titleEl = firstCard.querySelector("#video-title");
      if (titleEl) titleEl.textContent = `🧪 [TEST] ${customTitle}`;
      firstCard.style.outline = "2px solid #10b981";
    });
  }
}

function applyOutlierFilterToCards() {
  const cards = document.querySelectorAll("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer");
  cards.forEach((card) => {
    const ratio = parseFloat(card.dataset.nxOutlierRatio || "1");
    if (currentMinOutlier > 0 && ratio < currentMinOutlier) {
      card.style.display = "none";
    } else {
      card.style.display = "";
    }
  });
}

async function processVideoCardsBatch() {
  ensureHomepageBar();

  const allCards = Array.from(
    document.querySelectorAll("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer")
  );
  if (allCards.length === 0) return;

  const viewsList = allCards
    .map((c) => parseViewsFromText(c.innerText || ""))
    .filter((v) => v > 0);
  const sorted = [...viewsList].sort((a, b) => a - b);
  const medianViews = sorted.length
    ? sorted[Math.floor(sorted.length / 2)]
    : 50000;

  const unprocessed = allCards.filter((c) => !c.dataset.nxProcessed);
  const BATCH_SIZE = 15;

  for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
    const batch = unprocessed.slice(i, i + BATCH_SIZE);
    await new Promise((resolve) =>
      requestAnimationFrame(() => {
        for (const card of batch) {
          card.dataset.nxProcessed = "1";
          const titleEl = card.querySelector("#video-title");
          const title = (titleEl?.textContent || "").trim();
          if (!title) continue;

          const views = parseViewsFromText(card.innerText || "") || medianViews;
          const ratio = Number((views / Math.max(1, medianViews)).toFixed(1));
          card.dataset.nxOutlierRatio = String(ratio);

          const rpm = estimateRpmFromTitle(title);
          const estRev = Math.round((views / 1000) * rpm);

          const strip = document.createElement("div");
          strip.className = "nx-yt-badge-strip";
          strip.innerHTML = `
            <span class="nx-yt-pill ${ratio >= 2.5 ? "hot" : ""}">🔥 ${ratio}x Outlier</span>
            <span class="nx-yt-pill">💎 ~$${rpm} RPM ($${estRev.toLocaleString()})</span>
            <button type="button" class="nx-yt-save-btn">🗂️ Lưu Swipe</button>
          `;

          const saveBtn = strip.querySelector(".nx-yt-save-btn");
          saveBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
            saveBtn.textContent = "⏳...";
            await chrome.runtime.sendMessage({
              type: "SAVE_SWIPE_ITEM",
              payload: {
                title,
                channelTitle: "YouTube Feed Discovery",
                channelHandle: "@youtube",
                outlierRatio: ratio,
                views,
                estimatedRpm: rpm,
                tags: ["YouTube Overlay", `${ratio}x Outlier`],
                notes: "Lưu trực tiếp từ Chrome Extension trên YouTube.com"
              }
            });
            saveBtn.textContent = "✅ Đã lưu!";
          });

          const metaBlock =
            card.querySelector("#meta") ||
            card.querySelector("#details") ||
            titleEl.parentElement;
          if (metaBlock) {
            metaBlock.appendChild(strip);
          }
        }
        resolve();
      })
    );
    if (typeof scheduler !== "undefined" && scheduler.yield) {
      await scheduler.yield();
    }
  }
}

const observer = new MutationObserver(() => {
  processVideoCardsBatch();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

processVideoCardsBatch();
