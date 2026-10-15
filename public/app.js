const fmtNum = (n) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(v);
};

const fmtMoney = (n) => "$" + Number(n || 0).toLocaleString("en-US");

let cachedChannels = [];
let cachedOutliers = [];
let metaInfo = null;

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

function renderSparkline(series = []) {
  const slice = series.slice(-16);
  const max = Math.max(...slice, 1);
  return `<div class="mini-spark">${slice
    .map((val) => {
      const h = Math.max(4, Math.round((val / max) * 26));
      return `<span style="height:${h}px"></span>`;
    })
    .join("")}</div>`;
}

// ============================================================================
// 1. NICHE FINDER (21 FILTERS)
// ============================================================================

async function loadMeta() {
  metaInfo = await fetchJson("/api/v1/meta");
  document.getElementById("badge-channels").textContent = metaInfo.totalChannels;
  document.getElementById("top-stat-channels").textContent = metaInfo.totalChannels;
  document.getElementById("badge-outliers").textContent = metaInfo.totalOutliers;
  document.getElementById("badge-tracker").textContent = metaInfo.trackedCount;
  document.getElementById("badge-swipe").textContent = metaInfo.swipeCount;

  const nicheSelect = document.getElementById("f-niche");
  if (nicheSelect && nicheSelect.options.length <= 1) {
    for (const n of metaInfo.niches || []) {
      const opt = document.createElement("option");
      opt.value = n.name;
      opt.textContent = `${n.name} (Base CPM $${n.baseCpm})`;
      nicheSelect.appendChild(opt);
    }
  }

  const tplBar = document.getElementById("filter-templates-bar");
  if (tplBar) {
    tplBar.innerHTML = (metaInfo.filterTemplates || [])
      .map(
        (tpl) =>
          `<button type="button" class="tpl-chip" data-tpl-id="${tpl.id}" title="${tpl.description}">${tpl.name}</button>`
      )
      .join("");

    tplBar.querySelectorAll(".tpl-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tpl = (metaInfo.filterTemplates || []).find(
          (t) => t.id === btn.dataset.tplId
        );
        if (!tpl) return;
        const form = document.getElementById("niche-filters-form");
        form.reset();
        for (const [k, v] of Object.entries(tpl.filters || {})) {
          if (form.elements[k]) form.elements[k].value = String(v);
        }
        loadChannels();
      });
    });
  }
}

async function loadChannels() {
  const form = document.getElementById("niche-filters-form");
  const fd = new FormData(form);
  const params = new URLSearchParams();
  for (const [k, v] of fd.entries()) {
    if (v !== "" && v !== "all") params.set(k, String(v));
  }

  const data = await fetchJson(`/api/v1/channels?${params.toString()}`);
  cachedChannels = data.channels || [];
  document.getElementById("badge-channels").textContent = cachedChannels.length;

  const tbody = document.getElementById("channels-tbody");
  if (cachedChannels.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8">Không có kênh nào khớp bộ lọc. Hãy bấm "Đặt lại bộ lọc" hoặc quét từ khóa mới trên thanh tìm kiếm YouTube Live!</td></tr>`;
    return;
  }

  const maxOutlier = Math.max(...cachedChannels.map((c) => c.topOutlierRatio || 1), 1);
  document.getElementById("top-stat-outlier").textContent = `${maxOutlier.toFixed(1)}x 🔥`;

  tbody.innerHTML = cachedChannels
    .map(
      (ch) => `
      <tr>
        <th scope="row">
          <div class="ch-cell">
            <img class="ch-avatar" src="${ch.avatarUrl}" alt="${ch.title}" loading="lazy" />
            <div>
              <div class="ch-title" data-open-channel="${ch.id}">${ch.title}</div>
              <div class="ch-meta">${ch.handle} • ${ch.niche}</div>
              <div class="engine-pills">
                <span class="pill ok">${ch.countryName || ch.country || "US"}</span>
                <span class="pill">${ch.format}</span>
                <span class="pill amber">${ch.channelAgeMonths} tháng tuổi</span>
              </div>
            </div>
          </div>
        </th>
        <td>
          <div class="engine-pills">
            ${
              ch.isFaceless
                ? `<span class="pill ok">🎭 Faceless ${Math.round((ch.facelessConfidence || 0.9) * 100)}%</span>`
                : `<span class="pill">On-Camera</span>`
            }
            ${ch.isAiContent ? `<span class="pill">🤖 AI-Assisted</span>` : ""}
            ${ch.isMonetized ? `<span class="pill ok">💰 YPP Monetized</span>` : `<span class="pill hot">Chưa YPP</span>`}
          </div>
        </td>
        <td>
          <strong>${fmtNum(ch.subscribers)}</strong> subs
          <div class="ch-meta">${ch.videoCount} videos • TB ${ch.avgDurationMinutes}p</div>
        </td>
        <td>
          <strong>${fmtNum(ch.avgViews)}</strong> TB
          <div class="ch-meta">Median: ${fmtNum(ch.medianViews)}</div>
        </td>
        <td>
          <span class="pill hot">🔥 ${ch.topOutlierRatio}x (Tier ${ch.maxOutlierScore})</span>
          <div class="ch-meta">+${ch.growthRate30d}% / 30d</div>
        </td>
        <td>
          <strong class="text-emerald">$${ch.estimatedRpm} RPM</strong>
          <div class="ch-meta">${fmtMoney(ch.monthlyRevenueMin)} – ${fmtMoney(ch.monthlyRevenueMax)}/tháng</div>
        </td>
        <td>
          <strong>${fmtNum(ch.realtime48hViews)}</strong> views
          ${renderSparkline(ch.hourly48hSeries)}
        </td>
        <td>
          <div class="video-card-actions">
            <button type="button" class="btn-primary" data-open-channel="${ch.id}">Phân Tích</button>
            <button type="button" class="btn-ghost" data-track-channel="${ch.id}">📡 Track</button>
            <button type="button" class="btn-ghost" data-swipe-channel="${ch.id}">🗂️ Lưu</button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll("[data-open-channel]").forEach((el) => {
    el.addEventListener("click", () => openChannelModal(el.dataset.openChannel));
  });

  tbody.querySelectorAll("[data-track-channel]").forEach((el) => {
    el.addEventListener("click", async () => {
      await fetchJson("/api/v1/tracker/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: el.dataset.trackChannel })
      });
      await loadMeta();
      await loadTracker();
      el.textContent = "✅ Đã ghim";
    });
  });

  tbody.querySelectorAll("[data-swipe-channel]").forEach((el) => {
    el.addEventListener("click", async () => {
      const ch = cachedChannels.find((c) => c.id === el.dataset.swipeChannel);
      if (!ch) return;
      await fetchJson("/api/v1/swipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderId: "folder-faceless-niches",
          type: "channel",
          title: `${ch.title} (${ch.handle})`,
          channelTitle: ch.title,
          channelHandle: ch.handle,
          thumbnailUrl: ch.avatarUrl,
          outlierRatio: ch.topOutlierRatio,
          views: ch.totalViews,
          estimatedRpm: ch.estimatedRpm,
          tags: [ch.niche, ch.format, `${ch.topOutlierRatio}x Outlier`],
          notes: `Kênh ${ch.niche} đạt ${fmtMoney(ch.monthlyRevenueMax)}/tháng với chỉ ${ch.videoCount} videos.`
        })
      });
      await loadMeta();
      await loadSwipeFile();
      el.textContent = "✅ Đã lưu";
    });
  });
}

// ============================================================================
// 2. CHANNEL DEEP-DIVE MODAL & LIVE TRANSCRIPT EXTRACTOR
// ============================================================================

async function openChannelModal(channelId) {
  const modal = document.getElementById("channel-modal");
  const titleEl = document.getElementById("modal-channel-title");
  const bodyEl = document.getElementById("modal-channel-body");

  titleEl.textContent = "Đang tải dữ liệu phân tích kênh...";
  bodyEl.innerHTML = `<p>Đang tổng hợp dữ liệu... </p>`;
  modal.showModal();

  const data = await fetchJson(`/api/v1/channels/${encodeURIComponent(channelId)}`);
  const ch = data.channel;
  if (!ch) {
    bodyEl.innerHTML = `<p>Không tìm thấy dữ liệu kênh.</p>`;
    return;
  }

  titleEl.textContent = `📊 ${ch.title} (${ch.handle}) — ${ch.niche}`;

  const geoHtml = (ch.geographyBreakdown || [])
    .map(
      (g) =>
        `<span class="pill">${g.country}: ${Math.round(g.share * 100)}% ($${g.rpm} RPM)</span>`
    )
    .join(" ");

  const videosHtml = (ch.videos || [])
    .map(
      (v) => `
      <div class="info-item" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:0.85rem;">
          <img src="${v.thumbnailUrl}" alt="${v.title}" style="width:120px;height:68px;object-fit:cover;border-radius:8px;" />
          <div>
            <strong>${v.title}</strong>
            <div class="ch-meta">
              ${fmtNum(v.views)} views • ${v.durationMinutes} phút • Đăng ${v.publishedDaysAgo} ngày trước • Doanh thu ước tính: <strong>${fmtMoney(v.estimatedRevenue)}</strong>
            </div>
            <div class="engine-pills">
              <span class="pill hot">🔥 ${v.outlierRatio}x Outlier (Tier ${v.outlierScore})</span>
            </div>
          </div>
        </div>
        <button type="button" class="btn-ghost" data-extract-transcript="${v.videoId}">
          📝 Lấy Transcript / Kịch Bản (0 Quota)
        </button>
      </div>
    `
    )
    .join("");

  const similarHtml = (data.similarChannels || [])
    .map(
      (s) =>
        `<button type="button" class="tpl-chip" data-sim-channel="${s.id}">${s.title} (${s.handle} • $${s.estimatedRpm} RPM)</button>`
    )
    .join(" ");

  bodyEl.innerHTML = `
    <p class="ch-meta">${ch.description || ""}</p>
    <div class="kpi-row">
      <div class="kpi-box">
        <small>Subscribers</small>
        <strong>${fmtNum(ch.subscribers)}</strong>
      </div>
      <div class="kpi-box">
        <small>Outlier Đỉnh Nhất</small>
        <strong class="text-emerald">${ch.topOutlierRatio}x 🔥</strong>
      </div>
      <div class="kpi-box">
        <small>RPM Ước Tính</small>
        <strong>$${ch.estimatedRpm}</strong>
      </div>
      <div class="kpi-box">
        <small>Doanh Thu / Tháng</small>
        <strong class="text-emerald">${fmtMoney(ch.monthlyRevenueMin)}–${fmtMoney(ch.monthlyRevenueMax)}</strong>
      </div>
      <div class="kpi-box">
        <small>Faceless Confidence</small>
        <strong>${Math.round((ch.facelessConfidence || 0.9) * 100)}% (${ch.format})</strong>
      </div>
      <div class="kpi-box">
        <small>48h Realtime Views</small>
        <strong>${fmtNum(ch.realtime48hViews)}</strong>
      </div>
    </div>

    <div>
      <strong>🌍 Phân Bổ Khán Giả &amp; RPM Theo Quốc Gia (Geography Revenue):</strong>
      <div class="engine-pills" style="margin-top:0.45rem;">${geoHtml}</div>
    </div>

    <div>
      <strong>✅ Tín Hiệu Kiếm Tiền (Monetization Signals):</strong>
      <div class="engine-pills" style="margin-top:0.45rem;">
        ${(ch.monetizationSignals || []).map((sig) => `<span class="pill ok">${sig}</span>`).join(" ")}
      </div>
    </div>

    <div>
      <strong>🎬 Danh Sách Video Outlier &amp; Trích Xuất Kịch Bản:</strong>
      <div class="info-list" style="margin-top:0.55rem;">${videosHtml}</div>
    </div>

    <div id="modal-transcript-container" style="display:none;">
      <strong>📝 Kịch Bản / Transcript Video:</strong>
      <div id="modal-transcript-text" class="transcript-box" style="margin-top:0.45rem;"></div>
    </div>

    <div>
      <strong>🔗 Kênh Tương Tự Cùng Ngách (Similar Channels):</strong>
      <div class="template-bar" style="margin-top:0.45rem;">${similarHtml || "Đang cập nhật thêm kênh cùng ngách..."}</div>
    </div>
  `;

  bodyEl.querySelectorAll("[data-extract-transcript]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const vid = btn.dataset.extractTranscript;
      const box = document.getElementById("modal-transcript-container");
      const textEl = document.getElementById("modal-transcript-text");
      box.style.display = "block";
      textEl.textContent = "Đang trích xuất phụ đề/kịch bản qua YouTube InnerTube...";
      const tr = await fetchJson(`/api/v1/videos/${encodeURIComponent(vid)}/transcript`);
      textEl.textContent = `[Nguồn: ${tr.source} • ${tr.segmentCount} phân đoạn]\n\n${tr.fullText}`;
    });
  });

  bodyEl.querySelectorAll("[data-sim-channel]").forEach((btn) => {
    btn.addEventListener("click", () => openChannelModal(btn.dataset.simChannel));
  });
}

// ============================================================================
// 3. VIRAL OUTLIERS RADAR
// ============================================================================

async function loadOutliers() {
  const maxDaysAgo = document.getElementById("outlier-days-filter").value;
  const maxChannelSubscribers = document.getElementById("outlier-sub-filter").value;
  const data = await fetchJson(
    `/api/v1/outliers?maxDaysAgo=${maxDaysAgo}&maxChannelSubscribers=${maxChannelSubscribers}`
  );
  cachedOutliers = data.outliers || [];

  const grid = document.getElementById("outliers-grid");
  grid.innerHTML = cachedOutliers
    .map(
      (v) => `
      <article class="video-card">
        <div class="video-thumb-wrap">
          <img src="${v.thumbnailUrl}" alt="${v.title}" loading="lazy" />
          <span class="outlier-floating-badge">🔥 ${v.outlierRatio}x Outlier</span>
          <span class="duration-badge">${v.durationMinutes}m</span>
        </div>
        <div class="video-card-body">
          <div class="video-card-title">${v.title}</div>
          <div class="ch-meta">${v.channelTitle} (${v.channelHandle}) • ${fmtNum(v.channelSubscribers)} subs</div>
          <div class="engine-pills">
            <span class="pill ok">${fmtNum(v.views)} views</span>
            <span class="pill amber">Views/Sub: ${v.viewToSubRatio}x</span>
            <span class="pill">Est. ${fmtMoney(v.estimatedRevenue)}</span>
          </div>
          <div class="video-card-actions">
            <button type="button" class="btn-primary" data-open-channel="${v.channelId}">Xem Kênh</button>
            <button type="button" class="btn-ghost" data-save-outlier="${v.videoId}">🗂️ Lưu Swipe</button>
          </div>
        </div>
      </article>
    `
    )
    .join("");

  grid.querySelectorAll("[data-open-channel]").forEach((btn) => {
    btn.addEventListener("click", () => openChannelModal(btn.dataset.openChannel));
  });

  grid.querySelectorAll("[data-save-outlier]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const v = cachedOutliers.find((x) => x.videoId === btn.dataset.saveOutlier);
      if (!v) return;
      await fetchJson("/api/v1/swipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderId: "folder-outliers",
          type: "video",
          title: v.title,
          channelTitle: v.channelTitle,
          channelHandle: v.channelHandle,
          thumbnailUrl: v.thumbnailUrl,
          outlierRatio: v.outlierRatio,
          views: v.views,
          estimatedRpm: v.estimatedRpm,
          tags: [v.niche, `${v.outlierRatio}x Outlier`, `Views/Sub ${v.viewToSubRatio}x`],
          notes: `Đạt ${fmtNum(v.views)} views chỉ sau ${v.publishedDaysAgo} ngày trên kênh ${fmtNum(v.channelSubscribers)} subs.`
        })
      });
      await loadMeta();
      await loadSwipeFile();
      btn.textContent = "✅ Đã lưu";
    });
  });
}

// ============================================================================
// 4. 48H REALTIME CHANNEL TRACKER
// ============================================================================

async function loadTracker() {
  const data = await fetchJson("/api/v1/tracker");
  const list = data.channels || [];
  const grid = document.getElementById("tracker-grid");

  grid.innerHTML = list
    .map(
      (ch) => `
      <article class="lab-form-card">
        <div class="ch-cell">
          <img class="ch-avatar" src="${ch.avatarUrl}" alt="${ch.title}" />
          <div>
            <div class="ch-title" data-open-channel="${ch.id}">${ch.title}</div>
            <div class="ch-meta">${ch.handle} • ${ch.niche}</div>
          </div>
        </div>
        <div class="kpi-row">
          <div class="kpi-box">
            <small>48h Realtime Views</small>
            <strong class="text-emerald">${fmtNum(ch.realtime48hViews)}</strong>
          </div>
          <div class="kpi-box">
            <small>Tốc Độ / Giờ</small>
            <strong>${fmtNum(Math.round(ch.realtime48hViews / 48))}/h</strong>
          </div>
        </div>
        ${renderSparkline(ch.hourly48hSeries)}
        <div class="video-card-actions">
          <button type="button" class="btn-primary" data-open-channel="${ch.id}">Chi Tiết Kênh</button>
          <button type="button" class="btn-ghost" data-untrack="${ch.id}">Bỏ ghim</button>
        </div>
      </article>
    `
    )
    .join("");

  grid.querySelectorAll("[data-open-channel]").forEach((btn) => {
    btn.addEventListener("click", () => openChannelModal(btn.dataset.openChannel));
  });

  grid.querySelectorAll("[data-untrack]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetchJson("/api/v1/tracker/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: btn.dataset.untrack })
      });
      await loadMeta();
      await loadTracker();
    });
  });
}

// ============================================================================
// 5. THUMBNAIL & TITLE TESTER LAB
// ============================================================================

async function runThumbnailLab() {
  const title = document.getElementById("lab-title").value;
  const thumbnailUrl = document.getElementById("lab-thumb").value;
  const channelTitle = document.getElementById("lab-channel").value;
  const niche = document.getElementById("lab-niche").value;

  const audit = await fetchJson("/api/v1/thumbnail-lab/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, thumbnailUrl, channelTitle, niche })
  });

  const auditBox = document.getElementById("lab-audit-result");
  auditBox.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong>Điểm CTR Readiness:</strong>
      <span class="pill ok" style="font-size:0.95rem;">${audit.ctrScore} / 100</span>
    </div>
    <p>${audit.aiCritique}</p>
    <div>
      ${(audit.checklist || [])
        .map(
          (item) =>
            `<div style="margin-top:0.35rem;">${item.passed ? "✅" : "⚠️"} <strong>${item.label}:</strong> <span class="ch-meta">${item.detail}</span></div>`
        )
        .join("")}
    </div>
    <div>
      <strong>💡 Gợi ý biến thể Tiêu đề Outlier cao:</strong>
      <ul style="padding-left:1.1rem;margin-top:0.3rem;color:#a5f3fc;">
        ${(audit.suggestedTitles || []).map((t) => `<li>${t}</li>`).join("")}
      </ul>
    </div>
  `;

  // Render YouTube Homepage Grid with user's test card in slot #2
  const competitors = (cachedOutliers.length ? cachedOutliers : []).slice(0, 5);
  const cards = [
    competitors[0],
    {
      isUserTest: true,
      title,
      thumbnailUrl,
      channelTitle,
      views: 412000,
      publishedDaysAgo: 1,
      durationMinutes: 24.0,
      outlierRatio: 7.5
    },
    ...competitors.slice(1, 5)
  ].filter(Boolean);

  const simGrid = document.getElementById("yt-sim-grid");
  simGrid.innerHTML = cards
    .map(
      (c) => `
      <article class="video-card ${c.isUserTest ? "yt-Test-highlight" : ""}">
        <div class="video-thumb-wrap">
          <img src="${c.thumbnailUrl}" alt="${c.title}" />
          ${
            c.isUserTest
              ? `<span class="outlier-floating-badge">🧪 VIDEO CỦA BẠN (CTR ${audit.ctrScore}/100)</span>`
              : `<span class="outlier-floating-badge">🔥 ${c.outlierRatio}x Outlier</span>`
          }
          <span class="duration-badge">${c.durationMinutes}m</span>
        </div>
        <div class="video-card-body">
          <div class="video-card-title">${c.title}</div>
          <div class="ch-meta">${c.channelTitle} • ${fmtNum(c.views)} views • ${c.publishedDaysAgo} ngày trước</div>
        </div>
      </article>
    `
    )
    .join("");
}

// ============================================================================
// 6. SWIPE FILE & SETTINGS
// ============================================================================

async function loadSwipeFile() {
  const data = await fetchJson("/api/v1/swipe");
  const items = data.items || [];
  const grid = document.getElementById("swipe-grid");

  grid.innerHTML = items
    .map(
      (item) => `
      <article class="video-card">
        <div class="video-thumb-wrap">
          <img src="${item.thumbnailUrl}" alt="${item.title}" loading="lazy" />
          <span class="outlier-floating-badge">🔥 ${item.outlierRatio}x Outlier</span>
        </div>
        <div class="video-card-body">
          <div class="video-card-title">${item.title}</div>
          <div class="ch-meta">${item.channelTitle} (${item.channelHandle}) • RPM $${item.estimatedRpm}</div>
          <p class="ch-meta" style="color:#e2e8f0;">${item.notes || ""}</p>
          <div class="engine-pills">
            ${(item.tags || []).map((t) => `<span class="pill">${t}</span>`).join("")}
          </div>
          <div class="video-card-actions">
            <button type="button" class="btn-ghost" data-del-swipe="${item.id}">🗑️ Xóa</button>
          </div>
        </div>
      </article>
    `
    )
    .join("");

  grid.querySelectorAll("[data-del-swipe]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetchJson(`/api/v1/swipe/${encodeURIComponent(btn.dataset.delSwipe)}`, {
        method: "DELETE"
      });
      await loadMeta();
      await loadSwipeFile();
    });
  });
}

async function loadSettings() {
  const s = await fetchJson("/api/v1/settings");
  document.getElementById("status-yt-key").textContent = s.hasYoutubeApiKey
    ? `✅ Đã cấu hình YouTube API Key (${s.youtubeApiKeyMasked})`
    : "Đang dùng chế độ InnerTube Zero-Quota mặc định.";
  document.getElementById("status-gemini-key").textContent = s.hasGeminiApiKey
    ? `✅ Đã cấu hình Gemini API Key (${s.geminiApiKeyMasked})`
    : "Đang dùng bộ phân tích Heuristic nội bộ.";
}

// ============================================================================
// INITIALIZATION & EVENT LISTENERS
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  // Navigation Tabs
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.getElementById(`tab-${btn.dataset.tab}`);
      if (target) target.classList.add("active");
      if (btn.dataset.tab === "thumbnail-lab") runThumbnailLab();
    });
  });

  // Filter changes
  const filterForm = document.getElementById("niche-filters-form");
  filterForm.addEventListener("input", () => loadChannels());
  filterForm.addEventListener("change", () => loadChannels());

  document.getElementById("btn-reset-filters").addEventListener("click", () => {
    filterForm.reset();
    document.getElementById("f-isFaceless").value = "all";
    loadChannels();
  });

  // Live YouTube Scanner (with Country Selection)
  const scanBtn = document.getElementById("btn-live-scan");
  const scanInput = document.getElementById("live-scan-input");
  const scanCountry = document.getElementById("live-scan-country");
  scanBtn.addEventListener("click", async () => {
    const keyword = scanInput.value.trim() || "boring history for sleep";
    const country = scanCountry ? scanCountry.value : "US";
    scanBtn.disabled = true;
    scanBtn.textContent = `⏳ Đang quét (${country})...`;
    try {
      const res = await fetchJson("/api/v1/niche/scan-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, country, limit: 10 })
      });
      await loadMeta();
      document.getElementById("f-query").value = "";
      document.getElementById("f-isFaceless").value = "all";
      await loadChannels();
      await loadOutliers();
      scanBtn.textContent = `✅ +${res.discoveredCount} kênh!`;
      setTimeout(() => {
        scanBtn.textContent = "⚡ Quét Từ Khóa Live";
      }, 2500);
    } finally {
      scanBtn.disabled = false;
    }
  });

  // Global 12-Country Auto-Crawler Button
  const globalBtn = document.getElementById("btn-global-crawl");
  if (globalBtn) {
    globalBtn.addEventListener("click", async () => {
      const selectedCountry = scanCountry ? scanCountry.value : "ALL";
      const customKeyword = scanInput.value.trim();
      globalBtn.disabled = true;
      globalBtn.textContent = "⏳ Đang quét 12 Quốc Gia...";
      try {
        const res = await fetchJson("/api/v1/crawler/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            countries: selectedCountry === "ALL" ? ["ALL"] : [selectedCountry],
            keywordsPerCountry: 2,
            maxChannelsPerKeyword: 6,
            customKeyword
          })
        });
        await loadMeta();
        document.getElementById("f-isFaceless").value = "all";
        await loadChannels();
        await loadOutliers();
        const added = res?.summary?.newChannelsCount || 0;
        const total = res?.summary?.totalChannelsInDb || "";
        globalBtn.textContent = `✅ +${added} kênh mới (Tổng: ${total})`;
        setTimeout(() => {
          globalBtn.textContent = "🌍 Quét Tự Động 12 Quốc Gia";
        }, 3000);
      } finally {
        globalBtn.disabled = false;
      }
    });
  }

  // Outlier Filters
  document.getElementById("outlier-days-filter").addEventListener("change", loadOutliers);
  document.getElementById("outlier-sub-filter").addEventListener("change", loadOutliers);

  // Thumbnail Lab Submit
  document.getElementById("thumbnail-lab-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runThumbnailLab();
  });

  // Settings Submit
  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const youtubeApiKey = document.getElementById("set-yt-key").value;
    const geminiApiKey = document.getElementById("set-gemini-key").value;
    await fetchJson("/api/v1/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtubeApiKey, geminiApiKey })
    });
    await loadSettings();
  });

  // Close Modal
  const modal = document.getElementById("channel-modal");
  document.getElementById("btn-close-modal").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.close();
  });

  await loadMeta();
  await loadChannels();
  await loadOutliers();
  await loadTracker();
  await loadSwipeFile();
  await loadSettings();
});
