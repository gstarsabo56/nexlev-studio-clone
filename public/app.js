// Nexlev Internal Team Studio Frontend (Batch 2, 3, 4)
// XSS-safe rendering, URL protocol validation, debounced server-side pagination,
// Honest provenance display, Team Login/RBAC, and 6-Stage Production Workflow.

export function escapeHtml(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHttpUrl(rawUrl, fallback = "") {
  if (!rawUrl || typeof rawUrl !== "string") return fallback;
  try {
    const u = new URL(rawUrl.trim(), window.location.origin);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return escapeHtml(u.toString());
    }
    return fallback;
  } catch {
    return fallback;
  }
}

const fmtNum = (n, fallback = "unknown") => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return fallback;
  const v = Number(n);
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(Math.round(v));
};

const fmtMoney = (n, fallback = "unknown") => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return fallback;
  return "$" + Number(n).toLocaleString("en-US");
};

let currentPage = 1;
const PAGE_LIMIT = 30;
let cachedChannels = [];
let cachedOutliers = [];
let metaInfo = null;
let currentUser = null;
let teamUsers = [];
let sessionToken = localStorage.getItem("nexlev_session_token") || "";

let channelsAbortController = null;
let channelsReqSeq = 0;
let filterDebounceTimer = null;

function showToast(msg, isError = false) {
  const el = document.getElementById("global-toast");
  if (!el) return;
  el.style.display = "block";
  el.style.background = isError
    ? "rgba(239, 68, 68, 0.18)"
    : "rgba(16, 185, 129, 0.18)";
  el.style.borderColor = isError ? "#ef4444" : "#10b981";
  el.textContent = msg;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.display = "none";
  }, 4500);
}

async function fetchJson(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  if (sessionToken) {
    headers["x-nexlev-token"] = sessionToken;
  }
  const res = await fetch(url, {
    ...options,
    headers
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { error: `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const errMsg = data?.error || `Lỗi HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function renderOriginBadge(origin) {
  if (origin === "observed") {
    return `<span class="pill ok" title="Dữ liệu thu thập có nguồn trực tiếp">✅ Observed</span>`;
  }
  if (origin === "legacy_unverified") {
    return `<span class="pill amber" title="Dữ liệu cũ migrate từ JSON, cần quét enrich lại">⚠️ Legacy (Chưa xác minh đủ)</span>`;
  }
  if (origin === "demo") {
    return `<span class="pill" title="Dữ liệu mẫu minh họa">🧪 Demo Fixture</span>`;
  }
  return `<span class="pill">${escapeHtml(origin || "unknown")}</span>`;
}

function renderFacelessBadge(ch) {
  if (ch.facelessStatus === "unknown" || ch.facelessLabel === "unknown") {
    return `<span class="pill" title="${escapeHtml(ch.facelessReason || "Chưa đủ tín hiệu văn bản")}">Faceless: unknown</span>`;
  }
  if (ch.facelessLabel === "likely_faceless") {
    return `<span class="pill ok" title="Heuristic: ${escapeHtml((ch.facelessSignals || []).join(", "))}">🎭 Heuristic: Likely Faceless</span>`;
  }
  if (ch.facelessLabel === "likely_on_camera") {
    return `<span class="pill" title="Heuristic: ${escapeHtml((ch.facelessSignals || []).join(", "))}">🎥 Heuristic: On-Camera</span>`;
  }
  return `<span class="pill amber" title="${escapeHtml(ch.facelessReason || "")}">🎭 Heuristic: Mixed/Unclear</span>`;
}

// ============================================================================
// 1. METADATA & TEAM AUTHENTICATION
// ============================================================================

async function loadMeta() {
  try {
    metaInfo = await fetchJson("/api/v1/meta");
    currentUser = metaInfo.currentUser || null;
    teamUsers = metaInfo.teamUsers || [];

    const userDisp = document.getElementById("auth-user-display");
    const userRole = document.getElementById("auth-user-role");
    if (userDisp && currentUser) {
      userDisp.textContent = `👤 ${currentUser.displayName} (@${currentUser.username})`;
      userRole.textContent =
        currentUser.role === "manager"
          ? "Quyền: 👑 Quản lý (Manager)"
          : "Quyền: 🛠️ Thành viên (Member)";
    }

    document.getElementById("badge-channels").textContent = metaInfo.totalChannels ?? 0;
    document.getElementById("top-stat-channels").textContent = metaInfo.totalChannels ?? 0;
    document.getElementById("badge-outliers").textContent = metaInfo.totalOutliers ?? 0;
    document.getElementById("badge-tracker").textContent = metaInfo.trackedCount ?? 0;
    document.getElementById("badge-swipe").textContent = metaInfo.swipeCount ?? 0;

    const originPill = document.getElementById("pill-origin-summary");
    if (originPill && metaInfo.countsByOrigin) {
      const c = metaInfo.countsByOrigin;
      originPill.textContent = `Observed: ${c.observed || 0} • Legacy: ${c.legacy_unverified || 0}`;
    }

    // Populate Niche select
    const nicheSelect = document.getElementById("f-niche");
    if (nicheSelect && nicheSelect.options.length <= 1) {
      for (const n of metaInfo.niches || []) {
        const opt = document.createElement("option");
        opt.value = n.name;
        opt.textContent = `${n.name} (Base CPM $${n.baseCpm})`;
        nicheSelect.appendChild(opt);
      }
    }

    // Populate Assignee filter in Swipe tab
    const assigneeSelect = document.getElementById("swipe-assignee-filter");
    if (assigneeSelect) {
      const currentVal = assigneeSelect.value;
      assigneeSelect.innerHTML = `<option value="all">Mọi người phụ trách</option>`;
      for (const u of teamUsers) {
        const opt = document.createElement("option");
        opt.value = u.username;
        opt.textContent = `${u.displayName} (@${u.username})`;
        assigneeSelect.appendChild(opt);
      }
      assigneeSelect.value = currentVal || "all";
    }

    // Filter Templates Bar
    const tplBar = document.getElementById("filter-templates-bar");
    if (tplBar) {
      tplBar.innerHTML = (metaInfo.filterTemplates || [])
        .map(
          (tpl) =>
            `<button type="button" class="tpl-chip" data-tpl-id="${escapeHtml(tpl.id)}" title="${escapeHtml(tpl.description)}">${escapeHtml(tpl.name)}</button>`
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
          currentPage = 1;
          loadChannels();
        });
      });
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

// ============================================================================
// 2. NICHE FINDER (Server-Side Filtered, Null-Aware, Paginated & Debounced)
// ============================================================================

function scheduleLoadChannels() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => {
    currentPage = 1;
    loadChannels();
  }, 250);
}

async function loadChannels() {
  const form = document.getElementById("niche-filters-form");
  if (!form) return;

  if (channelsAbortController) {
    channelsAbortController.abort();
  }
  channelsAbortController = new AbortController();
  const reqId = ++channelsReqSeq;

  const fd = new FormData(form);
  const params = new URLSearchParams();
  for (const [k, v] of fd.entries()) {
    if (v !== "" && v !== "all") params.set(k, String(v));
  }
  params.set("page", String(currentPage));
  params.set("limit", String(PAGE_LIMIT));

  const tbody = document.getElementById("channels-tbody");
  const pageInfo = document.getElementById("channels-pagination-info");

  try {
    const data = await fetchJson(`/api/v1/channels?${params.toString()}`, {
      signal: channelsAbortController.signal
    });
    if (reqId !== channelsReqSeq) return; // Ignore stale response

    cachedChannels = data.channels || [];
    document.getElementById("badge-channels").textContent = data.totalCount ?? cachedChannels.length;

    if (pageInfo) {
      pageInfo.textContent = `Hiển thị ${cachedChannels.length} / tổng ${data.totalCount || 0} kênh • Trang ${data.page || 1} / ${data.totalPages || 1}`;
    }
    const prevBtn = document.getElementById("btn-prev-page");
    const nextBtn = document.getElementById("btn-next-page");
    if (prevBtn) prevBtn.disabled = (data.page || 1) <= 1;
    if (nextBtn) nextBtn.disabled = !data.hasMore;

    const validOutliers = cachedChannels
      .map((c) => c.topOutlierRatio)
      .filter((r) => typeof r === "number" && Number.isFinite(r));
    const maxOutlier = validOutliers.length ? Math.max(...validOutliers) : null;
    document.getElementById("top-stat-outlier").textContent =
      maxOutlier !== null ? `${maxOutlier.toFixed(1)}x 🔥` : "Chưa đủ mẫu";

    if (cachedChannels.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8">Không có kênh nào khớp bộ lọc hiện tại. Hãy bấm "Đặt lại bộ lọc" hoặc quét từ khóa mới!</td></tr>`;
      return;
    }

    tbody.innerHTML = cachedChannels
      .map((ch) => {
        const avatar = safeHttpUrl(
          ch.avatarUrl,
          "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg"
        );
        const discMarket = ch.discoveryMarket?.countryCode || "—";
        const discLang = ch.discoveryMarket?.languageCode || "—";
        const chCountry =
          ch.channelCountry !== null && ch.channelCountry !== undefined
            ? escapeHtml(ch.channelCountry)
            : "unknown";
        const ageText =
          ch.channelAgeMonths !== null
            ? `Tuổi kênh: ${escapeHtml(ch.channelAgeMonths)} tháng`
            : ch.oldestObservedVideoDays !== null
              ? `Video cũ nhất: ${Math.round(ch.oldestObservedVideoDays)} ngày trước (Tuổi kênh: unknown)`
              : `Tuổi kênh: unknown`;

        const subsHtml =
          ch.subscribers !== null
            ? `<strong>${fmtNum(ch.subscribers)}</strong> subs <span class="pill ok">${escapeHtml(ch.subscribersStatus)}</span>`
            : `<strong>unknown</strong> <span class="pill" title="Cần YouTube API Key hoặc enrich trang kênh">Chưa rõ Subs</span>`;

        const outlierHtml =
          ch.outlierStatus === "derived" && ch.topOutlierRatio !== null
            ? `<span class="pill hot">🔥 ${escapeHtml(ch.topOutlierRatio)}x (Tier ${escapeHtml(ch.maxOutlierScore)})</span>
               <div class="ch-meta">Đủ mẫu baseline (n=${escapeHtml(ch.observedVideoSampleCount)} video)</div>`
            : `<span class="pill amber" title="${escapeHtml(ch.outlierReason || "")}">⏳ Chưa đủ mẫu (n=${escapeHtml(ch.observedVideoSampleCount)}/3 video)</span>
               <div class="ch-meta">Không tự gán Outlier khi &lt;3 video</div>`;

        const revHtml =
          ch.monthlyRevenueMin !== null && ch.monthlyRevenueMax !== null
            ? `<div class="ch-meta">${fmtMoney(ch.monthlyRevenueMin)} – ${fmtMoney(ch.monthlyRevenueMax)}/th (Kịch bản)</div>`
            : `<div class="ch-meta">Doanh thu: unknown (thiếu monthlyViews)</div>`;

        return `
        <tr>
          <th scope="row">
            <div class="ch-cell">
              <img class="ch-avatar" src="${avatar}" alt="${escapeHtml(ch.title)}" loading="lazy" />
              <div>
                <div class="ch-title" data-open-channel="${escapeHtml(ch.id)}">${escapeHtml(ch.title)}</div>
                <div class="ch-meta">${escapeHtml(ch.handle)} • ${escapeHtml(ch.niche)} (${escapeHtml(ch.format)})</div>
                <div class="engine-pills">
                  ${renderOriginBadge(ch.dataOrigin)}
                  <span class="pill">${escapeHtml(ageText)}</span>
                </div>
              </div>
            </div>
          </th>
          <td>
            <div class="engine-pills">
              <span class="pill" title="Thị trường &amp; ngôn ngữ dùng khi tìm kiếm từ khóa">🔍 Tìm kiếm tại: ${escapeHtml(discMarket)} (${escapeHtml(discLang)})</span>
              <span class="pill ${ch.channelCountry ? "ok" : ""}" title="Quốc gia khai báo trên trang kênh">🏳️ Quốc gia kênh: ${chCountry}</span>
            </div>
            <div class="ch-meta" style="margin-top:0.25rem;">Từ khóa: "${escapeHtml(ch.discoveryMarket?.seedKeyword || "—")}"</div>
          </td>
          <td>
            <div class="engine-pills">
              ${renderFacelessBadge(ch)}
              <span class="pill" title="${escapeHtml(ch.monetizationReason || "")}">YPP: ${escapeHtml(ch.monetizationStatus || "unknown")}</span>
            </div>
          </td>
          <td>
            ${subsHtml}
            <div class="ch-meta">Mẫu quan sát: <strong>${escapeHtml(ch.observedVideoSampleCount)}</strong> video • Tổng video kênh: ${ch.videoCount !== null ? escapeHtml(ch.videoCount) : "unknown"}</div>
          </td>
          <td>
            <strong>${fmtNum(ch.avgViews)}</strong> TB mẫu
            <div class="ch-meta">Median mẫu: ${fmtNum(ch.medianViews)}</div>
          </td>
          <td>
            ${outlierHtml}
          </td>
          <td>
            <strong class="text-emerald">$${escapeHtml(ch.estimatedRpm ?? "—")} RPM</strong>
            <span class="pill" title="Ước lượng theo ngách &amp; thời lượng, không phải số liệu từ YouTube Analytics">Ước lượng</span>
            ${revHtml}
          </td>
          <td>
            <div class="video-card-actions">
              <button type="button" class="btn-primary" data-open-channel="${escapeHtml(ch.id)}">Chi Tiết</button>
              <button type="button" class="btn-ghost" data-track-channel="${escapeHtml(ch.id)}">${ch.isTracked ? "✅ Đang theo dõi" : "📡 Watchlist"}</button>
              <button type="button" class="btn-ghost" data-swipe-channel="${escapeHtml(ch.id)}">🗂️ Lưu Ý Tưởng</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");

    tbody.querySelectorAll("[data-open-channel]").forEach((el) => {
      el.addEventListener("click", () => openChannelModal(el.dataset.openChannel));
    });

    tbody.querySelectorAll("[data-track-channel]").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          const res = await fetchJson("/api/v1/tracker/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channelId: el.dataset.trackChannel })
          });
          el.textContent = res.tracked ? "✅ Đang theo dõi" : "📡 Watchlist";
          await loadMeta();
          await loadTracker();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    tbody.querySelectorAll("[data-swipe-channel]").forEach((el) => {
      el.addEventListener("click", async () => {
        const ch = cachedChannels.find((c) => c.id === el.dataset.swipeChannel);
        if (!ch) return;
        try {
          await fetchJson("/api/v1/swipe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folderId: "folder-faceless-niches",
              type: "channel",
              channelId: ch.id,
              canonicalUrl: `https://www.youtube.com/channel/${encodeURIComponent(ch.id)}`,
              title: `${ch.title} (${ch.handle})`,
              channelTitle: ch.title,
              channelHandle: ch.handle,
              thumbnailUrl: ch.avatarUrl || "",
              outlierRatio: ch.topOutlierRatio,
              views: ch.avgViews,
              estimatedRpm: ch.estimatedRpm,
              workflowStage: "discovered",
              tags: [ch.niche, ch.format, ch.dataOrigin],
              notes: `Mẫu quan sát: ${ch.observedVideoSampleCount} video. Thị trường phát hiện: ${ch.discoveryMarket?.countryCode || "unknown"}.`
            })
          });
          el.textContent = "✅ Đã lưu";
          showToast(`Đã lưu kênh "${ch.title}" vào Thư viện ý tưởng chung!`);
          await loadMeta();
          await loadSwipeFile();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    tbody.innerHTML = `<tr><td colspan="8">Lỗi tải danh sách kênh: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ============================================================================
// 3. CHANNEL DEEP-DIVE MODAL (Honest Provenance + Separate Transcript & Outline)
// ============================================================================

async function openChannelModal(channelId) {
  const modal = document.getElementById("channel-modal");
  const titleEl = document.getElementById("modal-channel-title");
  const bodyEl = document.getElementById("modal-channel-body");

  titleEl.textContent = "Đang tải dữ liệu phân tích kênh...";
  bodyEl.innerHTML = `<p>Đang truy vấn SQLite...</p>`;
  modal.showModal();

  try {
    const data = await fetchJson(`/api/v1/channels/${encodeURIComponent(channelId)}`);
    const ch = data.channel;
    if (!ch) {
      bodyEl.innerHTML = `<p>Không tìm thấy dữ liệu kênh.</p>`;
      return;
    }

    titleEl.textContent = `📊 ${ch.title} (${ch.handle}) — ${ch.niche}`;

    const gt = data.growthTracking || {};
    const growthHtml =
      gt.status === "derived"
        ? `<div class="info-item">
             <strong>📈 Tăng trưởng thực tế giữa ${escapeHtml(gt.snapshotCount)} Snapshots (${escapeHtml(gt.elapsedDays)} ngày):</strong>
             <div class="ch-meta">Views Delta: <strong>${fmtNum(gt.viewsDelta)}</strong> • Tốc độ: <strong>${fmtNum(gt.viewsPerDayVelocity)} views/ngày</strong></div>
             ${gt.anomalyWarning ? `<div style="color:#fbbf24;margin-top:0.25rem;">⚠️ ${escapeHtml(gt.anomalyWarning)}</div>` : ""}
           </div>`
        : `<div class="info-item">
             <strong>⏳ Trạng thái Tăng Trưởng (Snapshots):</strong>
             <span class="ch-meta">${escapeHtml(gt.reason || "Chưa đủ 2 snapshot theo thời gian.")}</span>
           </div>`;

    const videosHtml = (ch.videos || [])
      .map((v) => {
        const thumb = safeHttpUrl(
          v.thumbnailUrl,
          `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/hqdefault.jpg`
        );
        const videoLink = safeHttpUrl(
          v.canonicalUrl,
          `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`
        );
        const outlierPill =
          v.outlierStatus === "derived" && v.outlierRatio !== null
            ? `<span class="pill hot">🔥 ${escapeHtml(v.outlierRatio)}x Outlier (Baseline median: ${fmtNum(v.baselineMedianViews)} • n=${escapeHtml(v.baselineSampleSize)})</span>`
            : `<span class="pill amber">⏳ Outlier: Chưa đủ mẫu (${escapeHtml(v.outlierReason || "cần >=3 video cùng định dạng")})</span>`;

        return `
        <div class="info-item" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:0.85rem;">
            <img src="${thumb}" alt="${escapeHtml(v.title)}" style="width:120px;height:68px;object-fit:cover;border-radius:8px;" />
            <div>
              <a href="${videoLink}" target="_blank" rel="noopener noreferrer" style="color:var(--text-main);font-weight:600;text-decoration:none;">
                ${escapeHtml(v.title)} ↗
              </a>
              <div class="ch-meta">
                Views: <strong>${fmtNum(v.views)}</strong> (${escapeHtml(v.viewsStatus)}) •
                Thời lượng: ${v.durationMinutes !== null ? `${escapeHtml(v.durationMinutes)} phút` : "unknown"} (${escapeHtml(v.contentType)}) •
                Đăng: ${v.publishedDaysAgo !== null ? `${Math.round(v.publishedDaysAgo)} ngày trước` : "unknown"} •
                Likes: ${fmtNum(v.likes)}
              </div>
              <div class="engine-pills" style="margin-top:0.25rem;">
                ${outlierPill}
                ${v.ageSkewWarning ? `<span class="pill amber" title="${escapeHtml(v.ageSkewWarning)}">⚠️ Lệch tuổi mẫu</span>` : ""}
              </div>
            </div>
          </div>
          <div style="display:flex;gap:0.45rem;flex-wrap:wrap;">
            <button type="button" class="btn-ghost" data-extract-transcript="${escapeHtml(v.videoId)}">
              📝 Xem Transcript Gốc
            </button>
            <button type="button" class="btn-ghost" data-generate-outline="${escapeHtml(v.videoId)}">
              🎬 Tạo Khung Kịch Bản
            </button>
            <button type="button" class="btn-primary" data-save-video-idea="${escapeHtml(v.videoId)}">
              🗂️ Đưa Vào Quy Trình
            </button>
          </div>
        </div>
      `;
      })
      .join("");

    const similarHtml = (data.similarChannels || [])
      .map(
        (s) =>
          `<button type="button" class="tpl-chip" data-sim-channel="${escapeHtml(s.id)}">${escapeHtml(s.title)} (${escapeHtml(s.handle)})</button>`
      )
      .join(" ");

    bodyEl.innerHTML = `
      <p class="ch-meta">${escapeHtml(ch.description || "")}</p>
      <div class="kpi-row">
        <div class="kpi-box">
          <small>Nguồn Dữ Liệu</small>
          <strong>${escapeHtml(ch.dataOrigin)}</strong>
        </div>
        <div class="kpi-box">
          <small>Subscribers (${escapeHtml(ch.subscribersStatus)})</small>
          <strong>${fmtNum(ch.subscribers)}</strong>
        </div>
        <div class="kpi-box">
          <small>Outlier Đỉnh (${escapeHtml(ch.outlierStatus)})</small>
          <strong class="text-emerald">${ch.topOutlierRatio !== null ? `${escapeHtml(ch.topOutlierRatio)}x 🔥` : "insufficient_data"}</strong>
        </div>
        <div class="kpi-box">
          <small>Kịch Bản RPM (${escapeHtml(ch.rpmStatus)})</small>
          <strong>$${escapeHtml(ch.estimatedRpm ?? "—")}</strong>
        </div>
        <div class="kpi-box">
          <small>Thị Trường Tìm Kiếm</small>
          <strong>${escapeHtml(ch.discoveryMarket?.countryCode || "unknown")} (${escapeHtml(ch.discoveryMarket?.languageCode || "—")})</strong>
        </div>
        <div class="kpi-box">
          <small>Quốc Gia Kênh (${escapeHtml(ch.channelCountryStatus)})</small>
          <strong>${escapeHtml(ch.channelCountry || "unknown")}</strong>
        </div>
      </div>

      ${growthHtml}

      <div id="modal-transcript-container" style="display:none;margin:0.85rem 0;">
        <strong id="modal-transcript-header">📝 Kết Quả:</strong>
        <div id="modal-transcript-text" class="transcript-box" style="margin-top:0.45rem;white-space:pre-wrap;"></div>
      </div>

      <div style="margin-top:0.85rem;">
        <strong>🎬 Danh Sách Video Đã Thu Thập Trên Kênh (${ch.videos.length} video):</strong>
        <div class="info-list" style="margin-top:0.55rem;">${videosHtml || "<p>Chưa có video nào.</p>"}</div>
      </div>

      <div style="margin-top:0.85rem;">
        <strong>🔗 Kênh Cùng Ngách:</strong>
        <div class="template-bar" style="margin-top:0.45rem;">${similarHtml || "Chưa có kênh tương tự."}</div>
      </div>
    `;

    bodyEl.querySelectorAll("[data-extract-transcript]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = btn.dataset.extractTranscript;
        const box = document.getElementById("modal-transcript-container");
        const headerEl = document.getElementById("modal-transcript-header");
        const textEl = document.getElementById("modal-transcript-text");
        box.style.display = "block";
        headerEl.textContent = `📝 Transcript Gốc Của Video (${vid}):`;
        textEl.textContent = "Đang truy xuất phụ đề gốc từ YouTube InnerTube...";
        try {
          const tr = await fetchJson(`/api/v1/videos/${encodeURIComponent(vid)}/transcript`);
          if (!tr.available || tr.status === "unavailable") {
            textEl.textContent = `⚠️ KHÔNG CÓ TRANSCRIPT: ${tr.reason || "Video không có phụ đề công khai."}\n(Hệ thống giữ nguyên trạng thái unavailable, không tự bịa kịch bản giả làm transcript. Nếu muốn tạo khung kịch bản sản xuất, hãy bấm nút "🎬 Tạo Khung Kịch Bản".)`;
          } else {
            textEl.textContent = `[Nguồn: ${tr.source} • Ngôn ngữ: ${tr.language} • ${tr.segmentCount}/${tr.totalSegments} phân đoạn]\n\n${tr.fullText}`;
          }
        } catch (err) {
          textEl.textContent = `Lỗi lấy transcript: ${err.message}`;
        }
      });
    });

    bodyEl.querySelectorAll("[data-generate-outline]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = btn.dataset.generateOutline;
        const box = document.getElementById("modal-transcript-container");
        const headerEl = document.getElementById("modal-transcript-header");
        const textEl = document.getElementById("modal-transcript-text");
        box.style.display = "block";
        headerEl.textContent = `🎬 Khung Kịch Bản Sản Xuất (Production Outline — ${vid}):`;
        textEl.textContent = "Đang tạo khung kịch bản...";
        try {
          const out = await fetchJson(`/api/v1/videos/${encodeURIComponent(vid)}/outline`, {
            method: "POST"
          });
          const lines = (out.sections || []).map(
            (s, idx) => `${idx + 1}. ${s.phase}\n   - Mục tiêu: ${s.objective}\n   - Hình ảnh/B-roll: ${s.visualCue}`
          );
          textEl.textContent = `[${out.note}]\n\n${lines.join("\n\n")}`;
        } catch (err) {
          textEl.textContent = `Lỗi tạo outline: ${err.message}`;
        }
      });
    });

    bodyEl.querySelectorAll("[data-save-video-idea]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = btn.dataset.saveVideoIdea;
        const v = (ch.videos || []).find((x) => x.videoId === vid);
        if (!v) return;
        try {
          await fetchJson("/api/v1/swipe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folderId: "folder-outliers",
              type: "video",
              videoId: v.videoId,
              channelId: ch.id,
              canonicalUrl: v.canonicalUrl,
              title: v.title,
              channelTitle: ch.title,
              channelHandle: ch.handle,
              thumbnailUrl: v.thumbnailUrl,
              outlierRatio: v.outlierRatio,
              views: v.views,
              estimatedRpm: ch.estimatedRpm,
              workflowStage: "discovered",
              tags: [ch.niche, v.contentType],
              notes: `Phát hiện từ kênh ${ch.title}. Views: ${fmtNum(v.views)}.`
            })
          });
          btn.textContent = "✅ Đã lưu";
          showToast(`Đã thêm "${v.title}" vào quy trình (Bước 1: Phát hiện)!`);
          await loadMeta();
          await loadSwipeFile();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    bodyEl.querySelectorAll("[data-sim-channel]").forEach((btn) => {
      btn.addEventListener("click", () => openChannelModal(btn.dataset.simChannel));
    });
  } catch (err) {
    bodyEl.innerHTML = `<p>Lỗi tải chi tiết kênh: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================================
// 4. VIRAL OUTLIERS RADAR
// ============================================================================

async function loadOutliers() {
  const maxDaysAgo = document.getElementById("outlier-days-filter")?.value || "0";
  const maxChannelSubscribers = document.getElementById("outlier-sub-filter")?.value || "0";
  const includeInsufficientSample =
    document.getElementById("outlier-sample-toggle")?.value || "false";

  const grid = document.getElementById("outliers-grid");
  if (!grid) return;

  try {
    const data = await fetchJson(
      `/api/v1/outliers?maxDaysAgo=${encodeURIComponent(maxDaysAgo)}&maxChannelSubscribers=${encodeURIComponent(maxChannelSubscribers)}&includeInsufficientSample=${encodeURIComponent(includeInsufficientSample)}`
    );
    cachedOutliers = data.outliers || [];

    if (cachedOutliers.length === 0) {
      grid.innerHTML = `<div class="info-item">Chưa có video nào đạt ngưỡng Outlier đủ mẫu (n &ge; 3 video cùng kênh) với bộ lọc này. Bạn có thể chuyển bộ lọc sang "Hiện cả video chưa đủ mẫu" hoặc quét thêm kênh mới.</div>`;
      return;
    }

    grid.innerHTML = cachedOutliers
      .map((v) => {
        const thumb = safeHttpUrl(
          v.thumbnailUrl,
          `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/hqdefault.jpg`
        );
        const badgeText =
          v.outlierStatus === "derived" && v.outlierRatio !== null
            ? `🔥 ${escapeHtml(v.outlierRatio)}x Outlier (n=${escapeHtml(v.baselineSampleSize)})`
            : `⏳ Chưa đủ mẫu (n=${escapeHtml(v.baselineSampleSize)}/3)`;

        return `
        <article class="video-card">
          <div class="video-thumb-wrap">
            <img src="${thumb}" alt="${escapeHtml(v.title)}" loading="lazy" />
            <span class="outlier-floating-badge">${badgeText}</span>
            <span class="duration-badge">${v.durationMinutes !== null ? `${escapeHtml(v.durationMinutes)}m` : escapeHtml(v.contentType)}</span>
          </div>
          <div class="video-card-body">
            <div class="video-card-title">${escapeHtml(v.title)}</div>
            <div class="ch-meta">${escapeHtml(v.channelTitle)} (${escapeHtml(v.channelHandle)}) • Subs: ${fmtNum(v.channelSubscribers)}</div>
            <div class="engine-pills">
              <span class="pill ok">${fmtNum(v.views)} views</span>
              <span class="pill">Baseline Median: ${fmtNum(v.baselineMedianViews)}</span>
              ${v.publishedDaysAgo !== null ? `<span class="pill amber">${Math.round(v.publishedDaysAgo)} ngày trước</span>` : `<span class="pill">Ngày đăng: unknown</span>`}
            </div>
            <div class="video-card-actions">
              <button type="button" class="btn-primary" data-open-channel="${escapeHtml(v.channelId)}">Xem Kênh</button>
              <button type="button" class="btn-ghost" data-save-outlier="${escapeHtml(v.videoId)}">🗂️ Lưu &amp; Giao Việc</button>
            </div>
          </div>
        </article>
      `;
      })
      .join("");

    grid.querySelectorAll("[data-open-channel]").forEach((btn) => {
      btn.addEventListener("click", () => openChannelModal(btn.dataset.openChannel));
    });

    grid.querySelectorAll("[data-save-outlier]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const v = cachedOutliers.find((x) => x.videoId === btn.dataset.saveOutlier);
        if (!v) return;
        try {
          await fetchJson("/api/v1/swipe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folderId: "folder-outliers",
              type: "video",
              videoId: v.videoId,
              channelId: v.channelId,
              canonicalUrl: v.canonicalUrl,
              title: v.title,
              channelTitle: v.channelTitle,
              channelHandle: v.channelHandle,
              thumbnailUrl: v.thumbnailUrl,
              outlierRatio: v.outlierRatio,
              views: v.views,
              estimatedRpm: v.estimatedRpm,
              workflowStage: "discovered",
              tags: [v.niche, v.outlierRatio ? `${v.outlierRatio}x Outlier` : "Pending Baseline"],
              notes: `Views: ${fmtNum(v.views)} (Baseline kênh: ${fmtNum(v.baselineMedianViews)}, n=${v.baselineSampleSize} video).`
            })
          });
          btn.textContent = "✅ Đã lưu";
          showToast(`Đã lưu "${v.title}" vào Thư viện ý tưởng!`);
          await loadMeta();
          await loadSwipeFile();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p>Lỗi tải Outliers: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================================
// 5. SHARED WATCHLIST & REAL SNAPSHOT TRACKER
// ============================================================================

async function loadTracker() {
  const grid = document.getElementById("tracker-grid");
  if (!grid) return;

  try {
    const data = await fetchJson("/api/v1/tracker");
    const list = data.channels || [];

    if (list.length === 0) {
      grid.innerHTML = `<div class="info-item">Chưa có kênh nào trong Watchlist chung. Hãy bấm nút "📡 Watchlist" ở bảng Tìm Kênh để theo dõi!</div>`;
      return;
    }

    grid.innerHTML = list
      .map((ch) => {
        const avatar = safeHttpUrl(
          ch.avatarUrl,
          "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg"
        );
        const gt = ch.growthTracking || {};
        const statusHtml =
          gt.status === "derived"
            ? `<div class="kpi-row">
                 <div class="kpi-box">
                   <small>Views Delta (${escapeHtml(gt.snapshotCount)} snapshots)</small>
                   <strong class="text-emerald">${fmtNum(gt.viewsDelta)}</strong>
                 </div>
                 <div class="kpi-box">
                   <small>Tốc Độ Thực Tế / Ngày</small>
                   <strong>${fmtNum(gt.viewsPerDayVelocity)}/ngày</strong>
                 </div>
               </div>`
            : `<div class="info-item" style="margin:0.65rem 0;font-size:0.84rem;">
                 ⏳ <strong>${escapeHtml(gt.status || "accumulating_snapshots")}:</strong>
                 <span class="ch-meta">${escapeHtml(gt.reason || "Đang tích lũy snapshot...")}</span>
               </div>`;

        return `
        <article class="lab-form-card">
          <div class="ch-cell">
            <img class="ch-avatar" src="${avatar}" alt="${escapeHtml(ch.title)}" />
            <div>
              <div class="ch-title" data-open-channel="${escapeHtml(ch.id)}">${escapeHtml(ch.title)}</div>
              <div class="ch-meta">${escapeHtml(ch.handle)} • ${escapeHtml(ch.niche)}</div>
              <div class="engine-pills">
                ${renderOriginBadge(ch.dataOrigin)}
                <span class="pill">Mẫu: ${escapeHtml(ch.observedVideoSampleCount)} video</span>
              </div>
            </div>
          </div>
          ${statusHtml}
          <div class="video-card-actions">
            <button type="button" class="btn-primary" data-open-channel="${escapeHtml(ch.id)}">Chi Tiết Kênh</button>
            <button type="button" class="btn-ghost" data-untrack="${escapeHtml(ch.id)}">Bỏ khỏi Watchlist</button>
          </div>
        </article>
      `;
      })
      .join("");

    grid.querySelectorAll("[data-open-channel]").forEach((btn) => {
      btn.addEventListener("click", () => openChannelModal(btn.dataset.openChannel));
    });

    grid.querySelectorAll("[data-untrack]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await fetchJson("/api/v1/tracker/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channelId: btn.dataset.untrack })
          });
          await loadMeta();
          await loadTracker();
          await loadChannels();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p>Lỗi tải Watchlist: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================================
// 6. SHARED IDEA LIBRARY & 6-STAGE TEAM WORKFLOW
// (Phát hiện → Duyệt → Brief → Giao việc → Đã đăng → Đánh giá)
// ============================================================================

async function loadSwipeFile() {
  const stageFilter = document.getElementById("swipe-stage-filter")?.value || "all";
  const assigneeFilter = document.getElementById("swipe-assignee-filter")?.value || "all";
  const grid = document.getElementById("swipe-grid");
  if (!grid) return;

  try {
    const data = await fetchJson(
      `/api/v1/swipe?stage=${encodeURIComponent(stageFilter)}&assignee=${encodeURIComponent(assigneeFilter)}`
    );
    const items = data.items || [];
    const stageLabels = data.workflowStageLabels || {
      discovered: "1. Phát hiện",
      approved: "2. Duyệt",
      briefing: "3. Brief",
      assigned: "4. Giao việc",
      published: "5. Đã đăng",
      review: "6. Đánh giá"
    };

    if (items.length === 0) {
      grid.innerHTML = `<div class="info-item">Chưa có ý tưởng hoặc công việc nào ở trạng thái này.</div>`;
      return;
    }

    const assigneeOptionsHtml = [
      `<option value="">-- Chưa phân công --</option>`,
      ...teamUsers.map(
        (u) =>
          `<option value="${escapeHtml(u.username)}">${escapeHtml(u.displayName)} (@${escapeHtml(u.username)})</option>`
      )
    ].join("");

    grid.innerHTML = items
      .map((item) => {
        const thumb = safeHttpUrl(
          item.thumbnailUrl,
          "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg"
        );
        const srcUrl = safeHttpUrl(item.canonicalUrl, "");
        const resUrl = safeHttpUrl(item.resultUrl || item.publishedVideoUrl, "");

        const stageOptions = Object.entries(stageLabels)
          .map(
            ([k, label]) =>
              `<option value="${escapeHtml(k)}" ${item.workflowStage === k ? "selected" : ""}>${escapeHtml(label)}</option>`
          )
          .join("");

        return `
        <article class="video-card" style="display:flex;flex-direction:column;justify-content:space-between;">
          <div>
            <div class="video-thumb-wrap">
              <img src="${thumb}" alt="${escapeHtml(item.title)}" loading="lazy" />
              <span class="outlier-floating-badge">${escapeHtml(stageLabels[item.workflowStage] || item.workflowStage)}</span>
            </div>
            <div class="video-card-body">
              <div class="video-card-title">
                ${srcUrl ? `<a href="${srcUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--text-main);text-decoration:none;">${escapeHtml(item.title)} ↗</a>` : escapeHtml(item.title)}
              </div>
              <div class="ch-meta">
                Kênh gốc: ${escapeHtml(item.channelTitle || "—")} (${escapeHtml(item.channelHandle || "—")}) •
                Outlier: ${item.outlierRatio !== null ? `${escapeHtml(item.outlierRatio)}x` : "unknown"} •
                Views: ${fmtNum(item.views)}
              </div>

              <!-- 6-Stage Task Controls -->
              <div style="margin-top:0.65rem;display:grid;gap:0.45rem;background:rgba(15,23,42,0.55);padding:0.65rem;border-radius:8px;border:1px solid var(--border-subtle);">
                <div class="filter-field">
                  <label style="font-size:0.75rem;">Bước quy trình (6 bước):</label>
                  <select data-swipe-stage="${escapeHtml(item.id)}" style="padding:0.4rem;border-radius:6px;background:var(--bg-base);color:var(--text-main);border:1px solid var(--border-subtle);">
                    ${stageOptions}
                  </select>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.45rem;">
                  <div class="filter-field">
                    <label style="font-size:0.75rem;">Người phụ trách:</label>
                    <input type="text" data-swipe-owner="${escapeHtml(item.id)}" value="${escapeHtml(item.ownerLabel || "")}" list="team-users-datalist" placeholder="VD: member1" style="padding:0.4rem;border-radius:6px;" />
                  </div>
                  <div class="filter-field">
                    <label style="font-size:0.75rem;">Deadline:</label>
                    <input type="date" data-swipe-deadline="${escapeHtml(item.id)}" value="${escapeHtml(item.deadline || "")}" style="padding:0.4rem;border-radius:6px;" />
                  </div>
                </div>

                <div class="filter-field">
                  <label style="font-size:0.75rem;">Link kết quả (Video đã sản xuất / đăng):</label>
                  <input type="url" data-swipe-result="${escapeHtml(item.id)}" value="${escapeHtml(item.resultUrl || "")}" placeholder="https://www.youtube.com/watch?v=..." style="padding:0.4rem;border-radius:6px;" />
                  ${resUrl ? `<a href="${resUrl}" target="_blank" rel="noopener noreferrer" style="font-size:0.75rem;color:#34d399;">🔗 Mở video kết quả ↗</a>` : ""}
                </div>

                <div class="filter-field">
                  <label style="font-size:0.75rem;">Ghi chú giao việc &amp; nhận xét:</label>
                  <textarea data-swipe-notes="${escapeHtml(item.id)}" rows="2" style="width:100%;padding:0.4rem;border-radius:6px;background:var(--bg-base);color:var(--text-main);border:1px solid var(--border-subtle);">${escapeHtml(item.notes || "")}</textarea>
                </div>

                ${
                  item.briefMarkdown
                    ? `<details style="margin-top:0.25rem;">
                         <summary style="cursor:pointer;font-size:0.8rem;color:#a5f3fc;">📄 Xem Production Brief</summary>
                         <pre style="white-space:pre-wrap;font-size:0.76rem;background:#090d16;padding:0.6rem;border-radius:6px;margin-top:0.35rem;max-height:220px;overflow:auto;">${escapeHtml(item.briefMarkdown)}</pre>
                       </details>`
                    : ""
                }
              </div>

              <div class="video-card-actions" style="margin-top:0.65rem;">
                <button type="button" class="btn-primary" data-save-swipe-task="${escapeHtml(item.id)}">💾 Lưu Việc</button>
                <button type="button" class="btn-ghost" data-gen-brief="${escapeHtml(item.id)}">📋 Tạo Brief</button>
                <button type="button" class="btn-ghost" data-del-swipe="${escapeHtml(item.id)}">🗑️ Xóa</button>
              </div>
            </div>
          </div>
        </article>
      `;
      })
      .join("") +
      `<datalist id="team-users-datalist">
        ${teamUsers.map((u) => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.displayName)}</option>`).join("")}
      </datalist>`;

    grid.querySelectorAll("[data-save-swipe-task]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.saveSwipeTask;
        const workflowStage = grid.querySelector(`[data-swipe-stage="${id}"]`)?.value;
        const ownerLabel = grid.querySelector(`[data-swipe-owner="${id}"]`)?.value;
        const deadline = grid.querySelector(`[data-swipe-deadline="${id}"]`)?.value;
        const resultUrl = grid.querySelector(`[data-swipe-result="${id}"]`)?.value;
        const notes = grid.querySelector(`[data-swipe-notes="${id}"]`)?.value;

        try {
          await fetchJson(`/api/v1/swipe/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workflowStage,
              ownerLabel,
              assigneeId: ownerLabel,
              deadline,
              resultUrl,
              notes
            })
          });
          showToast("Đã lưu cập nhật công việc & quy trình!");
          await loadSwipeFile();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    grid.querySelectorAll("[data-gen-brief]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.genBrief;
        try {
          await fetchJson(`/api/v1/swipe/${encodeURIComponent(id)}/brief`, {
            method: "POST"
          });
          showToast("Đã sinh Production Brief và chuyển sang bước Brief!");
          await loadSwipeFile();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    grid.querySelectorAll("[data-del-swipe]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delSwipe;
        try {
          await fetchJson(`/api/v1/swipe/${encodeURIComponent(id)}`, {
            method: "DELETE"
          });
          await loadMeta();
          await loadSwipeFile();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p>Lỗi tải Thư viện ý tưởng: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================================
// 7. THUMBNAIL & TITLE TESTER LAB (Honest Title Readiness Score)
// ============================================================================

async function runThumbnailLab() {
  const title = document.getElementById("lab-title")?.value || "";
  const thumbnailUrl = document.getElementById("lab-thumb")?.value || "";
  const channelTitle = document.getElementById("lab-channel")?.value || "";
  const niche = document.getElementById("lab-niche")?.value || "History & Civilizations";

  try {
    const audit = await fetchJson("/api/v1/thumbnail-lab/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, thumbnailUrl, channelTitle, niche })
    });

    const auditBox = document.getElementById("lab-audit-result");
    auditBox.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>Điểm Cấu Trúc Tiêu Đề (Title Readiness):</strong>
        <span class="pill ok" style="font-size:0.95rem;">${escapeHtml(audit.titleReadinessScore ?? audit.ctrScore)} / 100</span>
      </div>
      <div class="ch-meta" style="margin-top:0.25rem;">Trạng thái phân tích ảnh: <code>${escapeHtml(audit.imageAnalysisStatus)}</code> — ${escapeHtml(audit.imageAnalysisReason || "")}</div>
      <p style="margin-top:0.5rem;">${escapeHtml(audit.aiCritique)}</p>
      <div>
        ${(audit.checklist || [])
          .map(
            (item) =>
              `<div style="margin-top:0.35rem;">${item.passed ? "✅" : "ℹ️"} <strong>${escapeHtml(item.label)}:</strong> <span class="ch-meta">${escapeHtml(item.detail)}</span></div>`
          )
          .join("")}
      </div>
      <div style="margin-top:0.5rem;">
        <strong>💡 Gợi ý biến thể Tiêu đề:</strong>
        <ul style="padding-left:1.1rem;margin-top:0.3rem;color:#a5f3fc;">
          ${(audit.suggestedTitles || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("")}
        </ul>
      </div>
    `;

    const competitors = (cachedOutliers.length ? cachedOutliers : []).slice(0, 5);
    const safeUserThumb = safeHttpUrl(
      audit.safeThumbnailUrl || thumbnailUrl,
      "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg"
    );

    const cards = [
      competitors[0],
      {
        isUserTest: true,
        title,
        thumbnailUrl: safeUserThumb,
        channelTitle,
        views: null,
        publishedDaysAgo: 0,
        durationMinutes: 18.0
      },
      ...competitors.slice(1, 5)
    ].filter(Boolean);

    const simGrid = document.getElementById("yt-sim-grid");
    simGrid.innerHTML = cards
      .map((c) => {
        const cardThumb = safeHttpUrl(
          c.thumbnailUrl,
          "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg"
        );
        return `
        <article class="video-card ${c.isUserTest ? "yt-Test-highlight" : ""}">
          <div class="video-thumb-wrap">
            <img src="${cardThumb}" alt="${escapeHtml(c.title)}" />
            ${
              c.isUserTest
                ? `<span class="outlier-floating-badge">🧪 PREVIEW CỦA BẠN (Title ${escapeHtml(audit.ctrScore)}/100)</span>`
                : `<span class="outlier-floating-badge">🔥 ${escapeHtml(c.outlierRatio)}x Outlier</span>`
            }
            <span class="duration-badge">${escapeHtml(c.durationMinutes || 15)}m</span>
          </div>
          <div class="video-card-body">
            <div class="video-card-title">${escapeHtml(c.title)}</div>
            <div class="ch-meta">${escapeHtml(c.channelTitle)} • ${c.isUserTest ? "Bản thử nghiệm" : `${fmtNum(c.views)} views`}</div>
          </div>
        </article>
      `;
      })
      .join("");
  } catch (err) {
    showToast(err.message, true);
  }
}

// ============================================================================
// 8. SETTINGS, TEAM USERS & CRAWLER HEALTH
// ============================================================================

async function loadSettingsAndCrawler() {
  try {
    const [s, health, usersRes] = await Promise.all([
      fetchJson("/api/v1/settings"),
      fetchJson("/api/v1/crawler/status"),
      fetchJson("/api/v1/users")
    ]);

    document.getElementById("status-yt-key").textContent = s.hasYoutubeApiKey
      ? `✅ Đang dùng YouTube Data API v3 Key (${s.youtubeApiKeyMasked}) — Nếu để trống ô trên khi bấm Lưu, key này vẫn được giữ an toàn.`
      : "Chưa cấu hình YouTube API Key (Đang chạy chế độ InnerTube Zero-Quota; Subscribers & Quốc gia kênh sẽ ở trạng thái unknown).";

    document.getElementById("status-gemini-key").textContent = s.hasGeminiApiKey
      ? `✅ Đang dùng Gemini API Key (${s.geminiApiKeyMasked}).`
      : "Chưa cấu hình Gemini API Key (Đang dùng bộ đánh giá Heuristic nội bộ).";

    const minSampleInput = document.getElementById("set-min-sample");
    if (minSampleInput && s.minOutlierSampleSize) {
      minSampleInput.value = String(s.minOutlierSampleSize);
    }

    // Team Users list
    const usersBox = document.getElementById("team-users-list");
    if (usersBox) {
      usersBox.innerHTML = (usersRes.users || [])
        .map(
          (u) => `
          <div class="info-item" style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;">
            <div>
              <strong>${escapeHtml(u.displayName)}</strong> (<code>@${escapeHtml(u.username)}</code>)
              <span class="pill ${u.role === "manager" ? "ok" : ""}">${u.role === "manager" ? "👑 Quản lý" : "🛠️ Thành viên"}</span>
              ${u.apiToken ? `<div class="ch-meta">Extension Token: <code>${escapeHtml(u.apiToken)}</code></div>` : ""}
            </div>
          </div>
        `
        )
        .join("");
    }

    // Crawler Health Box
    const healthBox = document.getElementById("crawler-health-box");
    if (healthBox && health) {
      const st = health.crawlerState || {};
      const seeds = health.seedStats || {};
      const recentJobsHtml = (health.recentJobs || [])
        .slice(0, 4)
        .map(
          (j) =>
            `<div class="ch-meta">• Job <code>${escapeHtml(j.jobId)}</code>: <strong>${escapeHtml(j.status)}</strong> (${escapeHtml(j.requestCount || 0)} reqs)</div>`
        )
        .join("");

      healthBox.innerHTML = `
        <div class="info-item">
          <div>Trạng thái lịch tự động: <strong>${st.autoScheduleEnabled ? `🟢 Đang bật (${st.intervalMinutes} phút/lần)` : "⚪ Đang tắt"}</strong></div>
          <div class="ch-meta">Hạt giống (Seeds): Tổng ${escapeHtml(seeds.totalSeeds || 0)} • Đã quét thành công: ${escapeHtml(seeds.succeededSeeds || 0)} • Chưa quét: ${escapeHtml(seeds.unseenSeeds || 0)} • Lỗi: ${escapeHtml(seeds.failedSeeds || 0)}</div>
          <div style="margin-top:0.4rem;">${recentJobsHtml}</div>
        </div>
      `;
    }
  } catch (err) {
    showToast(err.message, true);
  }
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
      if (btn.dataset.tab === "settings") loadSettingsAndCrawler();
    });
  });

  // Debounced Filter Changes & Pagination
  const filterForm = document.getElementById("niche-filters-form");
  filterForm.addEventListener("input", scheduleLoadChannels);
  filterForm.addEventListener("change", scheduleLoadChannels);

  document.getElementById("btn-reset-filters").addEventListener("click", () => {
    filterForm.reset();
    currentPage = 1;
    loadChannels();
  });

  document.getElementById("btn-prev-page").addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      loadChannels();
    }
  });

  document.getElementById("btn-next-page").addEventListener("click", () => {
    currentPage += 1;
    loadChannels();
  });

  // Live YouTube Scanner
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
      currentPage = 1;
      await loadChannels();
      await loadOutliers();
      showToast(`Đã quét từ khóa "${keyword}" tại thị trường ${country} (+${res.discoveredCount} kênh)!`);
      scanBtn.textContent = `✅ +${res.discoveredCount} kênh!`;
      setTimeout(() => {
        scanBtn.textContent = "⚡ Quét Từ Khóa Live";
      }, 2500);
    } catch (err) {
      showToast(err.message, true);
      scanBtn.textContent = "⚡ Quét Từ Khóa Live";
    } finally {
      scanBtn.disabled = false;
    }
  });

  // Global Multi-Country Crawler
  const globalBtn = document.getElementById("btn-global-crawl");
  if (globalBtn) {
    globalBtn.addEventListener("click", async () => {
      const selectedCountry = scanCountry ? scanCountry.value : "ALL";
      const customKeyword = scanInput.value.trim();
      globalBtn.disabled = true;
      globalBtn.textContent = "⏳ Đang quét hạt giống...";
      try {
        const res = await fetchJson("/api/v1/crawler/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            countries: selectedCountry === "ALL" ? ["ALL"] : [selectedCountry],
            keywordsPerCountry: 1,
            maxChannelsPerKeyword: 5,
            customKeyword
          })
        });
        await loadMeta();
        await loadChannels();
        await loadOutliers();
        const added = res?.summary?.newChannelsCount || 0;
        const updated = res?.summary?.updatedChannelsCount || 0;
        showToast(`Hoàn tất job crawl: +${added} kênh mới, cập nhật ${updated} kênh.`);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        globalBtn.disabled = false;
        globalBtn.textContent = "🌍 Quét Hạt Giống Đa Thị Trường";
      }
    });
  }

  // Outlier Filters
  document.getElementById("outlier-days-filter")?.addEventListener("change", loadOutliers);
  document.getElementById("outlier-sub-filter")?.addEventListener("change", loadOutliers);
  document.getElementById("outlier-sample-toggle")?.addEventListener("change", loadOutliers);

  // Swipe Workflow Filters & New Idea Button
  document.getElementById("swipe-stage-filter")?.addEventListener("change", loadSwipeFile);
  document.getElementById("swipe-assignee-filter")?.addEventListener("change", loadSwipeFile);
  document.getElementById("btn-new-idea")?.addEventListener("click", async () => {
    const title = prompt("Nhập tiêu đề ý tưởng / công việc sản xuất mới:");
    if (!title || !title.trim()) return;
    try {
      await fetchJson("/api/v1/swipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          workflowStage: "discovered",
          ownerLabel: currentUser?.username || "admin"
        })
      });
      await loadMeta();
      await loadSwipeFile();
      showToast("Đã tạo ý tưởng mới trong thư viện chung!");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Thumbnail Lab Submit
  document.getElementById("thumbnail-lab-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    runThumbnailLab();
  });

  // Settings Submit (Never wipes keys when fields are empty)
  document.getElementById("settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const youtubeApiKey = document.getElementById("set-yt-key").value.trim();
    const geminiApiKey = document.getElementById("set-gemini-key").value.trim();
    const minOutlierSampleSize = Number(document.getElementById("set-min-sample").value || 3);
    try {
      await fetchJson("/api/v1/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtubeApiKey,
          geminiApiKey,
          minOutlierSampleSize
        })
      });
      document.getElementById("set-yt-key").value = "";
      document.getElementById("set-gemini-key").value = "";
      showToast("Đã lưu cấu hình thành công!");
      await loadSettingsAndCrawler();
      await loadMeta();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("btn-clear-keys")?.addEventListener("click", async () => {
    try {
      await fetchJson("/api/v1/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clearYoutubeApiKey: true,
          clearGeminiApiKey: true
        })
      });
      showToast("Đã xóa API Keys theo yêu cầu.");
      await loadSettingsAndCrawler();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Team User Creation (Manager Only)
  document.getElementById("create-user-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("new-user-username").value.trim();
    const displayName = document.getElementById("new-user-display").value.trim();
    const role = document.getElementById("new-user-role").value;
    const password = document.getElementById("new-user-pass").value;
    try {
      await fetchJson("/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName, role, password })
      });
      e.target.reset();
      showToast(`Đã tạo tài khoản nhân viên @${username}!`);
      await loadSettingsAndCrawler();
      await loadMeta();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Crawler Schedule & Cancel
  document.getElementById("btn-toggle-schedule")?.addEventListener("click", async () => {
    try {
      const currentEnabled = Boolean(metaInfo?.crawlerState?.autoScheduleEnabled);
      await fetchJson("/api/v1/crawler/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoScheduleEnabled: !currentEnabled,
          intervalMinutes: 15
        })
      });
      await loadSettingsAndCrawler();
      await loadMeta();
      showToast(`Đã ${!currentEnabled ? "BẬT" : "TẮT"} lịch quét tự động.`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("btn-cancel-crawl")?.addEventListener("click", async () => {
    try {
      await fetchJson("/api/v1/crawler/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      showToast("Đã gửi yêu cầu dừng job đang chạy.");
      await loadSettingsAndCrawler();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Login Modal & Quick Role Switch
  const loginModal = document.getElementById("login-modal");
  document.getElementById("btn-open-login")?.addEventListener("click", () => loginModal.showModal());
  document.getElementById("btn-close-login")?.addEventListener("click", () => loginModal.close());

  async function performLogin(username, password) {
    try {
      const res = await fetchJson("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      sessionToken = res.sessionToken || "";
      localStorage.setItem("nexlev_session_token", sessionToken);
      loginModal.close();
      showToast(`Xin chào ${res.user.displayName} (${res.user.role})!`);
      await loadMeta();
      await loadSwipeFile();
      await loadSettingsAndCrawler();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  document.getElementById("login-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    performLogin(
      document.getElementById("login-username").value,
      document.getElementById("login-password").value
    );
  });

  document.querySelectorAll("[data-quick-login]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [u, p] = btn.dataset.quickLogin.split(":");
      performLogin(u, p);
    });
  });

  // Bulk Import Modal
  const bulkModal = document.getElementById("bulk-import-modal");
  document.getElementById("btn-open-bulk-import")?.addEventListener("click", () => bulkModal.showModal());
  document.getElementById("btn-close-bulk")?.addEventListener("click", () => bulkModal.close());
  document.getElementById("btn-submit-bulk")?.addEventListener("click", async () => {
    const raw = document.getElementById("bulk-import-textarea").value;
    const resBox = document.getElementById("bulk-import-result");
    try {
      const res = await fetchJson("/api/v1/import/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: raw })
      });
      resBox.innerHTML = `
        <div class="info-item">
          <strong>✅ Kết quả nhập hàng loạt:</strong>
          <div class="ch-meta">Tổng dòng: ${escapeHtml(res.totalSubmitted)} • Hợp lệ &amp; Đã nhập: <strong>${escapeHtml(res.importedCount)}</strong> • Trùng lặp đã bỏ qua: ${escapeHtml(res.duplicateCount)} • Không hợp lệ: ${escapeHtml(res.invalidCount)}</div>
          ${
            (res.invalidLines || []).length
              ? `<div style="margin-top:0.35rem;color:#fca5a5;font-size:0.8rem;">Dòng lỗi: ${(res.invalidLines || []).map((l) => `${escapeHtml(l.input)} (${escapeHtml(l.reason)})`).join("; ")}</div>`
              : ""
          }
        </div>
      `;
      await loadMeta();
      await loadChannels();
      await loadTracker();
      await loadSwipeFile();
    } catch (err) {
      resBox.innerHTML = `<p style="color:#ef4444;">${escapeHtml(err.message)}</p>`;
    }
  });

  // Close Channel Modal
  const channelModal = document.getElementById("channel-modal");
  document.getElementById("btn-close-modal")?.addEventListener("click", () => channelModal.close());
  channelModal?.addEventListener("click", (e) => {
    if (e.target === channelModal) channelModal.close();
  });

  await loadMeta();
  await loadChannels();
  await loadOutliers();
  await loadTracker();
  await loadSwipeFile();
});
