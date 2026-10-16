// ============================================================================
// NEXLEV STUDIO v2.1 — CLIENT APPLICATION
// Implements 4 Core Work Views + Manager Admin, Strict Auth, Server-Enforced
// RBAC, Per-Item Draft State with Optimistic Concurrency (T08), and Honest Metrics.
// ============================================================================

const STAGE_LABELS = {
  discovered: "1. Phát hiện",
  approved: "2. Đã duyệt",
  briefing: "3. Đang viết Brief",
  assigned: "4. Đã giao việc",
  published: "5. Đã đăng",
  review: "6. Đánh giá"
};

const STAGE_BADGE_CLASS = {
  discovered: "badge-warning",
  approved: "badge-accent",
  briefing: "badge-accent",
  assigned: "badge-positive",
  published: "badge-positive",
  review: "badge-neutral"
};

const appState = {
  currentUser: null,
  teamUsers: [],
  meta: null,
  route: "discover", // discover | watchlist | ideas | production | admin
  discoverMode: "channels", // channels | videos
  discoverFilters: {
    query: "",
    contentType: "all",
    niche: "all",
    minOutlierScore: 0,
    dataOrigin: "observed",
    outlierSampleFilter: "all",
    isFaceless: "all",
    country: "all",
    maxSubscribers: 0,
    minRpm: 0,
    includeUnknown: false,
    sortBy: "outlier",
    page: 1,
    limit: 20
  },
  discoverChannelsData: { channels: [], totalCount: 0, page: 1, totalPages: 1 },
  discoverVideosData: { outliers: [], totalCount: 0, page: 1, totalPages: 1 },
  watchlistChannels: [],
  watchlistQuery: "",
  swipeItems: [],
  ideasSubview: "discovered", // discovered | approved | all
  ideasQuery: "",
  productionStageFilter: "all",
  productionAssigneeFilter: "all",
  productionLayout: "split", // split | kanban
  selectedProductionItemId: null,
  activeProductionTab: "brief", // brief | title-check | activity
  conflictByItemId: new Map(), // itemId -> serverItem when 409 occurs
  draftStateByItemId: new Map(), // itemId -> { dirtyFields: {}, baseRevision: number }
  titleAuditByItemId: new Map(), // itemId -> auditResult
  drawerChannelId: null,
  drawerChannelDetail: null,
  drawerActiveTab: "overview", // overview | videos | provenance
  drawerVideoFormatFilter: "all",
  drawerVideoExtraById: new Map(), // videoId -> { type: 'transcript'|'outline', data }
  adminActiveTab: "users", // users | crawler | settings
  crawlerHealth: null,
  importTargets: [],
  personalTokenPlain: null,
  personalTokenRevealed: false
};

// ============================================================================
// UTILITIES & SAFE ESCAPING
// ============================================================================

function escapeHtml(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCompactNumber(num) {
  if (num === null || num === undefined || !Number.isFinite(Number(num))) {
    return null;
  }
  const n = Number(num);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}N`;
  return String(Math.round(n));
}

function formatDurationMinutes(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes)) || minutes <= 0) {
    return "—";
  }
  const totalSec = Math.round(Number(minutes) * 60);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatPublishedAge(daysAgo) {
  if (daysAgo === null || daysAgo === undefined || !Number.isFinite(Number(daysAgo))) {
    return "Chưa rõ ngày đăng";
  }
  const d = Number(daysAgo);
  if (d < 1) {
    const hrs = Math.max(1, Math.round(d * 24));
    return `${hrs} giờ trước`;
  }
  if (d < 30) return `${Math.round(d)} ngày trước`;
  if (d < 365) return `${Math.round(d / 30)} tháng trước`;
  return `${(d / 365).toFixed(1)} năm trước`;
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast-item ${type === "error" ? "toast-error" : type === "success" ? "toast-success" : ""}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3800);
}

// ============================================================================
// ACCESSIBLE FORM VALIDATION (:user-invalid + ARIA Sync per modern-web-guidance)
// ============================================================================

function initAccessibleFormValidation() {
  const dirtyState = new WeakMap();
  const supportsUserInvalid =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("selector(:user-invalid)");

  const syncControlState = (control) => {
    if (!control || typeof control.checkValidity !== "function") return;
    const isValid = control.checkValidity();
    if (!supportsUserInvalid) {
      control.classList.toggle("user-invalid-fallback", !isValid);
      control.classList.toggle("user-valid-fallback", isValid);
    }
    if (!isValid) {
      control.setAttribute("aria-invalid", "true");
    } else {
      control.removeAttribute("aria-invalid");
    }
  };

  document.addEventListener(
    "blur",
    (e) => {
      const target = e.target;
      if (!target || typeof target.matches !== "function") return;
      if (target.matches("input[required], textarea[required], select[required]")) {
        const st = dirtyState.get(target) || { interacted: false };
        if (st.interacted || target.value !== "") {
          syncControlState(target);
        }
      }
    },
    true
  );

  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!target || typeof target.matches !== "function") return;
    if (target.matches("input[required], textarea[required], select[required]")) {
      dirtyState.set(target, { interacted: true });
      if (target.hasAttribute("aria-invalid") && target.checkValidity()) {
        target.removeAttribute("aria-invalid");
        target.classList.remove("user-invalid-fallback");
      }
    }
  });
}

// ============================================================================
// API CLIENT WITH STRICT 401 HANDLING
// ============================================================================

function getStoredSessionToken() {
  try {
    return localStorage.getItem("nexlev_session_token") || "";
  } catch {
    return "";
  }
}

function setStoredSessionToken(token) {
  try {
    if (token) localStorage.setItem("nexlev_session_token", token);
    else localStorage.removeItem("nexlev_session_token");
  } catch {
    // ignore storage errors
  }
}

async function apiFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  const token = getStoredSessionToken();
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
    body:
      options.body && typeof options.body === "object" && !(options.body instanceof FormData)
        ? JSON.stringify(options.body)
        : options.body
  });

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    payload = { raw: await response.text() };
  }

  if (response.status === 401 && !url.includes("/api/v1/auth/login")) {
    openAuthModal();
    const err = new Error(payload?.error || "Vui lòng đăng nhập để tiếp tục.");
    err.status = 401;
    err.payload = payload;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(payload?.error || `Lỗi HTTP ${response.status}`);
    err.status = response.status;
    err.code = payload?.code;
    err.payload = payload;
    throw err;
  }

  return payload;
}

// ============================================================================
// AUTHENTICATION MODAL & USER PROFILE
// ============================================================================

function openAuthModal() {
  const modal = document.getElementById("auth-modal-backdrop");
  if (modal) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    const usernameInput = document.getElementById("login-username");
    if (usernameInput) usernameInput.focus();
  }
}

function closeAuthModal() {
  const modal = document.getElementById("auth-modal-backdrop");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

function renderCurrentUserSidebar() {
  const user = appState.currentUser;
  const nameEl = document.getElementById("sidebar-user-name");
  const roleEl = document.getElementById("sidebar-user-role");
  const adminGroup = document.getElementById("sidebar-admin-group");

  if (!user) {
    if (nameEl) nameEl.textContent = "Chưa đăng nhập";
    if (roleEl) {
      roleEl.textContent = "Khách";
      roleEl.className = "badge badge-neutral";
    }
    if (adminGroup) adminGroup.style.display = "none";
    return;
  }

  if (nameEl) nameEl.textContent = user.displayName || user.username;
  if (roleEl) {
    const isManager = user.role === "manager";
    roleEl.textContent = isManager ? "Quản lý" : "Thành viên";
    roleEl.className = `badge ${isManager ? "badge-accent" : "badge-neutral"}`;
  }
  if (adminGroup) {
    adminGroup.style.display = user.role === "manager" ? "block" : "none";
  }
}

// ============================================================================
// NAVIGATION & HASH ROUTING
// ============================================================================

const VIEW_METADATA = {
  discover: {
    title: "Khám phá",
    subtitle: "Kho dữ liệu kênh & video đối thủ có kiểm chứng nguồn (Observed vs Legacy)"
  },
  watchlist: {
    title: "Watchlist",
    subtitle: "Theo dõi biến động kênh đối thủ theo nhóm video cùng kỳ (Cohort Intersection)"
  },
  ideas: {
    title: "Ý tưởng",
    subtitle: "Đề xuất ý tưởng từ nghiên cứu và duyệt chuyển giao sang sản xuất"
  },
  production: {
    title: "Sản xuất",
    subtitle: "Điều phối quy trình 6 bước: Phát hiện → Duyệt → Brief → Giao việc → Đã đăng → Đánh giá"
  },
  admin: {
    title: "Quản trị hệ thống",
    subtitle: "Quản lý nhân sự, phân quyền, lịch thu thập 18 thị trường và kết nối API"
  }
};

function navigateTo(route, subMode = null) {
  if (route === "admin" && appState.currentUser?.role !== "manager") {
    showToast("Mục Quản trị chỉ dành cho Quản lý (Manager).", "error");
    route = "discover";
  }

  appState.route = route;
  if (route === "discover" && (subMode === "channels" || subMode === "videos")) {
    appState.discoverMode = subMode;
  }

  const targetHash =
    route === "discover" ? `#/discover/${appState.discoverMode}` : `#/${route}`;
  if (window.location.hash !== targetHash) {
    history.replaceState(null, "", targetHash);
  }

  // Update sidebar active state
  document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === route);
  });

  // Update active workspace section
  document.querySelectorAll(".workspace-view").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `view-${route}`);
  });

  // Update topbar title & subtitle
  const meta = VIEW_METADATA[route] || VIEW_METADATA.discover;
  const titleEl = document.getElementById("topbar-title");
  const subEl = document.getElementById("topbar-subtitle");
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.subtitle;

  // Trigger data load for active view
  if (route === "discover") {
    syncDiscoverModeUI();
    loadDiscoverData();
  } else if (route === "watchlist") {
    loadWatchlistData();
  } else if (route === "ideas") {
    loadSwipeAndRenderIdeas();
  } else if (route === "production") {
    loadSwipeAndRenderProduction();
  } else if (route === "admin") {
    loadAdminData();
  }
}

function handleHashChange() {
  const raw = (window.location.hash || "#/discover/channels").replace(/^#\/?/, "");
  const parts = raw.split("/");
  const main = parts[0] || "discover";
  const sub = parts[1] || null;
  if (["discover", "watchlist", "ideas", "production", "admin"].includes(main)) {
    navigateTo(main, sub);
  } else {
    navigateTo("discover", "channels");
  }
}

// ============================================================================
// SYSTEM METADATA & CRAWLER PILL
// ============================================================================

async function loadSystemMeta() {
  const meta = await apiFetch("/api/v1/meta");
  appState.meta = meta;
  appState.currentUser = meta.currentUser;
  appState.teamUsers = meta.teamUsers || [];
  renderCurrentUserSidebar();

  // Populate Niche dropdown in Discover
  const nicheSelect = document.getElementById("discover-niche-select");
  if (nicheSelect && nicheSelect.options.length <= 1 && Array.isArray(meta.niches)) {
    for (const n of meta.niches) {
      const opt = document.createElement("option");
      opt.value = n.name;
      opt.textContent = `${n.name} (~$${n.baseRpm})`;
      nicheSelect.appendChild(opt);
    }
  }

  // Populate Country dropdowns in Filter Popover and Collect Modal
  const advCountry = document.getElementById("adv-country");
  const collectCountry = document.getElementById("collect-country-select");
  if (Array.isArray(meta.countries)) {
    if (advCountry && advCountry.options.length <= 1) {
      for (const c of meta.countries) {
        const opt = document.createElement("option");
        opt.value = c.code;
        opt.textContent = `${c.name} (${c.code}) · ${c.channelCount || 0}`;
        advCountry.appendChild(opt);
      }
    }
    if (collectCountry && collectCountry.options.length <= 2) {
      for (const c of meta.countries) {
        if (c.code === "US") continue;
        const opt = document.createElement("option");
        opt.value = c.code;
        opt.textContent = `${c.name} (${c.code})`;
        collectCountry.appendChild(opt);
      }
    }
  }

  // Populate Production Assignee Filter
  const prodAssignee = document.getElementById("prod-assignee-filter");
  if (prodAssignee) {
    const currentVal = prodAssignee.value;
    prodAssignee.innerHTML = `
      <option value="all">Tất cả nhân sự</option>
      <option value="mine">Việc của tôi (${escapeHtml(appState.currentUser?.username || "")})</option>
      ${appState.teamUsers
        .filter((u) => u.isActive !== false)
        .map(
          (u) =>
            `<option value="${escapeHtml(u.username)}">${escapeHtml(u.displayName)} (@${escapeHtml(u.username)})</option>`
        )
        .join("")}
    `;
    if ([...prodAssignee.options].some((o) => o.value === currentVal)) {
      prodAssignee.value = currentVal;
    }
  }

  updateSidebarBadges();
  updateCrawlerSidebarPill(meta.crawlerState);
}

function updateSidebarBadges() {
  const meta = appState.meta;
  if (!meta) return;
  const dBadge = document.getElementById("badge-discover-count");
  const wBadge = document.getElementById("badge-watchlist-count");
  const iBadge = document.getElementById("badge-ideas-count");
  const pBadge = document.getElementById("badge-production-count");

  if (dBadge) dBadge.textContent = String(meta.countsByOrigin?.observed ?? meta.totalChannels ?? 0);
  if (wBadge) wBadge.textContent = String(meta.trackedCount ?? 0);
  if (iBadge) iBadge.textContent = String(meta.pendingApprovalCount ?? 0);
  if (pBadge) pBadge.textContent = String(meta.activeProductionCount ?? 0);
}

function updateCrawlerSidebarPill(cState) {
  if (!cState) return;
  const dot = document.getElementById("sidebar-crawler-dot");
  const label = document.getElementById("sidebar-crawler-label");
  const meta = document.getElementById("sidebar-crawler-meta");

  if (dot) dot.classList.toggle("running", Boolean(cState.isRunning));
  if (label) {
    label.textContent = cState.isRunning
      ? `Đang quét: ${cState.currentMarket || "YouTube"}`
      : cState.autoScheduleEnabled
        ? `Tự động (${cState.intervalMinutes}p)`
        : "Trình thu thập: Rảnh";
  }
  if (meta) {
    meta.textContent = cState.totalRuns > 0 ? `${cState.totalRuns} phiên` : "18 TT";
  }
}

// ============================================================================
// VIEW 1: KHÁM PHÁ (CHANNELS & VIDEOS)
// ============================================================================

function syncDiscoverModeUI() {
  const isChannels = appState.discoverMode === "channels";
  const btnCh = document.getElementById("mode-btn-channels");
  const btnVid = document.getElementById("mode-btn-videos");
  const wrapCh = document.getElementById("discover-channels-table-wrap");
  const wrapVid = document.getElementById("discover-videos-table-wrap");

  if (btnCh) {
    btnCh.classList.toggle("active", isChannels);
    btnCh.setAttribute("aria-selected", isChannels ? "true" : "false");
  }
  if (btnVid) {
    btnVid.classList.toggle("active", !isChannels);
    btnVid.setAttribute("aria-selected", !isChannels ? "true" : "false");
  }
  if (wrapCh) wrapCh.style.display = isChannels ? "block" : "none";
  if (wrapVid) wrapVid.style.display = !isChannels ? "block" : "none";
}

function renderActiveFilterChips() {
  const f = appState.discoverFilters;
  const chips = [];

  if (f.dataOrigin !== "observed") {
    const labelMap = {
      all: "Nguồn: Mọi nguồn (kèm dữ liệu cũ)",
      legacy_unverified: "Nguồn: Dữ liệu cũ (chưa xác minh)",
      demo: "Nguồn: Dữ liệu mẫu (Demo)"
    };
    chips.push({ key: "dataOrigin", resetVal: "observed", text: labelMap[f.dataOrigin] || f.dataOrigin });
  }
  if (f.outlierSampleFilter !== "all") {
    chips.push({
      key: "outlierSampleFilter",
      resetVal: "all",
      text: f.outlierSampleFilter === "sufficient" ? "Chỉ kênh đủ mẫu (n≥3)" : "Kênh thiếu mẫu (<3)"
    });
  }
  if (f.isFaceless !== "all") {
    chips.push({
      key: "isFaceless",
      resetVal: "all",
      text: f.isFaceless === "true" ? "Không lộ mặt (Faceless)" : "Có người dẫn"
    });
  }
  if (f.country !== "all") {
    chips.push({ key: "country", resetVal: "all", text: `Thị trường: ${f.country}` });
  }
  if (Number(f.maxSubscribers) > 0) {
    chips.push({
      key: "maxSubscribers",
      resetVal: 0,
      text: `Subs ≤ ${formatCompactNumber(f.maxSubscribers)}`
    });
  }
  if (Number(f.minRpm) > 0) {
    chips.push({ key: "minRpm", resetVal: 0, text: `RPM ≥ $${f.minRpm}` });
  }
  if (f.includeUnknown) {
    chips.push({ key: "includeUnknown", resetVal: false, text: "Kèm kênh chưa rõ chỉ số" });
  }

  const badge = document.getElementById("active-filter-badge");
  if (badge) {
    badge.style.display = chips.length > 0 ? "inline-flex" : "none";
    badge.textContent = String(chips.length);
  }

  const container = document.getElementById("discover-active-chips");
  if (!container) return;
  if (chips.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  container.innerHTML = chips
    .map(
      (c) => `
      <span class="filter-chip">
        <span>${escapeHtml(c.text)}</span>
        <button type="button" data-remove-chip="${escapeHtml(c.key)}" title="Gỡ bộ lọc">×</button>
      </span>
    `
    )
    .join("");
}

function renderOutlierBadge(ratio, status, sampleSize, minSample = 3) {
  if (status === "demo") {
    return `<span class="badge badge-neutral" title="Dữ liệu mẫu">Mẫu Demo</span>`;
  }
  if (status === "unverified_source") {
    return `<span class="badge badge-neutral" title="Dữ liệu lịch sử chưa xác minh nguồn gốc">Nguồn cũ</span>`;
  }
  if (status === "insufficient_data" || ratio === null || ratio === undefined) {
    const n = Number(sampleSize || 0);
    return `<span class="badge badge-neutral" title="Cần tối thiểu ${minSample} video cùng định dạng đã xác minh để tính trung vị">Chưa đủ mẫu (${n}/${minSample})</span>`;
  }
  const r = Number(ratio);
  const cls = r >= 3 ? "badge-positive" : r >= 1.5 ? "badge-warning" : "badge-neutral";
  return `<span class="badge ${cls} num">${r.toFixed(1)}x</span>`;
}

async function loadDiscoverData() {
  renderActiveFilterChips();
  const f = appState.discoverFilters;

  if (appState.discoverMode === "channels") {
    const params = new URLSearchParams({
      query: f.query,
      niche: f.niche,
      contentType: f.contentType,
      minOutlierScore: String(f.minOutlierScore),
      dataOrigin: f.dataOrigin,
      includeDemo: f.dataOrigin === "demo" ? "true" : "false",
      outlierSampleFilter: f.outlierSampleFilter,
      isFaceless: f.isFaceless,
      country: f.country,
      maxSubscribers: String(f.maxSubscribers || 0),
      minRpm: String(f.minRpm || 0),
      includeUnknown: f.includeUnknown ? "true" : "false",
      sortBy: f.sortBy,
      page: String(f.page),
      limit: String(f.limit)
    });

    const data = await apiFetch(`/api/v1/channels?${params.toString()}`);
    appState.discoverChannelsData = data;
    const chCountEl = document.getElementById("discover-tab-channels-count");
    if (chCountEl) chCountEl.textContent = String(data.totalCount || 0);
    renderDiscoverChannelsTable(data);
    renderDiscoverPagination(data.page, data.totalPages, data.totalCount, data.channels.length);
  } else {
    const minRatioMap = { 0: 1.0, 1: 1.5, 2: 3.0, 3: 5.0 };
    const params = new URLSearchParams({
      query: f.query,
      niche: f.niche,
      contentType: f.contentType,
      minOutlierRatio: String(minRatioMap[f.minOutlierScore] || 1.0),
      includeDemo: f.dataOrigin === "demo" ? "true" : "false",
      includeInsufficientSample: f.outlierSampleFilter !== "sufficient" ? "true" : "false",
      maxChannelSubscribers: String(f.maxSubscribers || 0),
      includeUnknownSubscribers: f.includeUnknown ? "true" : "false",
      page: String(f.page),
      limit: String(f.limit)
    });

    const data = await apiFetch(`/api/v1/outliers?${params.toString()}`);
    appState.discoverVideosData = data;
    const vidCountEl = document.getElementById("discover-tab-videos-count");
    if (vidCountEl) vidCountEl.textContent = String(data.totalCount || 0);
    renderDiscoverVideosTable(data);
    renderDiscoverPagination(data.page, data.totalPages, data.totalCount, data.outliers.length);
  }
}

function renderDiscoverPagination(page, totalPages, totalCount, shownCount) {
  const sumEl = document.getElementById("discover-pagination-summary");
  const indEl = document.getElementById("discover-page-indicator");
  const prevBtn = document.getElementById("btn-discover-prev");
  const nextBtn = document.getElementById("btn-discover-next");

  if (sumEl) {
    sumEl.textContent = `Hiển thị ${shownCount} / ${totalCount} kết quả`;
  }
  if (indEl) {
    indEl.textContent = `${page} / ${Math.max(1, totalPages)}`;
  }
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
}

function renderDiscoverChannelsTable(data) {
  const tbody = document.getElementById("discover-channels-tbody");
  if (!tbody) return;
  const rows = data.channels || [];
  const minSample = appState.meta?.minOutlierSampleSize || 3;

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 36px 16px; color: var(--text-secondary);">
          Không tìm thấy kênh nào khớp bộ lọc hiện tại. Nhấn <strong>Thu thập</strong> để quét trực tiếp từ YouTube hoặc nới rộng bộ lọc.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map((c) => {
      const initials = (c.title || "NX").slice(0, 2).toUpperCase();
      const subsFormatted = formatCompactNumber(c.subscribers);
      const avgViewsFormatted = formatCompactNumber(c.avgViews);
      const medianFormatted = formatCompactNumber(c.medianViews);
      const originTag =
        c.dataOrigin === "legacy_unverified"
          ? `<span class="badge badge-neutral" title="Dữ liệu lịch sử chưa xác minh nguồn">Nguồn cũ</span>`
          : c.dataOrigin === "demo"
            ? `<span class="badge badge-neutral">Demo</span>`
            : "";

      const facelessTag =
        c.isFaceless === true
          ? `<span class="badge badge-neutral" title="Phân loại tự động từ từ khóa tiêu đề/mô tả">Faceless (Gợi ý)</span>`
          : "";

      const countryDisplay = c.channelCountry
        ? `${escapeHtml(c.channelCountry)}`
        : `TT: ${escapeHtml(c.discoveryMarket || "US")}`;

      return `
        <tr class="clickable-row" data-open-channel="${escapeHtml(c.id)}">
          <td>
            <div class="entity-cell">
              <div class="channel-avatar">${escapeHtml(initials)}</div>
              <div class="entity-info">
                <div class="entity-title">${escapeHtml(c.title)}</div>
                <div class="entity-sub">
                  <span class="mono">${escapeHtml(c.handle || c.id)}</span>
                  <span>·</span>
                  <span>${countryDisplay}</span>
                  <span>·</span>
                  <span>${escapeHtml(c.niche || "General")}</span>
                  ${facelessTag}
                  ${originTag}
                </div>
              </div>
            </div>
          </td>
          <td class="num">
            ${
              subsFormatted !== null
                ? `<div class="cell-primary num">${subsFormatted}</div><div class="cell-sub">Quan sát trực tiếp</div>`
                : `<span class="badge badge-neutral" title="YouTube không trả về số người đăng ký trên luồng tìm kiếm">Chưa rõ</span>`
            }
          </td>
          <td class="num">
            ${
              avgViewsFormatted !== null
                ? `<div class="cell-primary num">${avgViewsFormatted}</div>
                   <div class="cell-sub num">Trung vị: ${medianFormatted || "—"} · n=${c.observedVideoSampleCount || 0}</div>`
                : `<span class="badge badge-neutral">Chưa rõ</span>`
            }
          </td>
          <td class="num">
            <div>${renderOutlierBadge(c.topOutlierRatio, c.outlierStatus, c.observedVideoSampleCount, minSample)}</div>
            <div class="cell-sub">
              ${
                c.outlierStatus === "derived"
                  ? `Trên ${c.observedVideoSampleCount} video quan sát`
                  : c.outlierStatus === "unverified_source"
                    ? "Không tính từ nguồn cũ"
                    : `Cần ≥ ${minSample} video cùng loại`
              }
            </div>
          </td>
          <td class="num">
            <div class="cell-primary num">~$${Number(c.estimatedRpm || 0).toFixed(2)}</div>
            <div class="cell-sub">Kịch bản ước tính</div>
          </td>
          <td class="num" onclick="event.stopPropagation();">
            <div class="row-actions">
              <button
                type="button"
                class="btn btn-sm ${c.isTracked ? "btn-positive" : ""}"
                data-toggle-watchlist="${escapeHtml(c.id)}"
                title="${c.isTracked ? "Đang theo dõi trong Watchlist" : "Thêm vào Watchlist"}"
              >
                ${c.isTracked ? "Đang theo dõi" : "+ Watchlist"}
              </button>
              <button
                type="button"
                class="btn btn-sm"
                data-save-channel-idea="${escapeHtml(c.id)}"
                title="Lưu vào kho Ý tưởng"
              >
                + Ý tưởng
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderDiscoverVideosTable(data) {
  const tbody = document.getElementById("discover-videos-tbody");
  if (!tbody) return;
  const rows = data.outliers || [];
  const minSample = appState.meta?.minOutlierSampleSize || 3;

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 36px 16px; color: var(--text-secondary);">
          Chưa có video nào khớp bộ lọc hiện tại. Hãy chọn "Mọi mức" Outlier hoặc quét thêm từ khóa mới.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map((v) => {
      const viewsFormatted = formatCompactNumber(v.views);
      const baselineFormatted = formatCompactNumber(v.baselineMedianViews);
      const subsFormatted = formatCompactNumber(v.channelSubscribers);
      const formatLabel =
        v.contentType === "shorts"
          ? "Shorts"
          : v.contentType === "long"
            ? "Video dài"
            : v.contentType === "live"
              ? "Livestream"
              : "Chưa rõ";

      return `
        <tr class="clickable-row" data-open-channel="${escapeHtml(v.channelId)}">
          <td>
            <div class="entity-cell">
              <div class="video-thumb-wrap">
                ${
                  v.thumbnailUrl
                    ? `<img src="${escapeHtml(v.thumbnailUrl)}" alt="" loading="lazy" />`
                    : ""
                }
                <span class="thumb-duration">${escapeHtml(formatDurationMinutes(v.durationMinutes))}</span>
              </div>
              <div class="entity-info">
                <div class="entity-title">${escapeHtml(v.title)}</div>
                <div class="entity-sub">
                  <span>${escapeHtml(v.channelTitle)}</span>
                  <span>·</span>
                  <span class="mono">${escapeHtml(v.channelHandle || "")}</span>
                  <span>·</span>
                  <span>${escapeHtml(formatPublishedAge(v.publishedDaysAgo))}</span>
                </div>
              </div>
            </div>
          </td>
          <td>
            <span class="badge badge-neutral">${escapeHtml(formatLabel)}</span>
          </td>
          <td class="num">
            <div class="cell-primary num">${viewsFormatted ?? "Chưa rõ"}</div>
            <div class="cell-sub num">Subs: ${subsFormatted ?? "Chưa rõ"}</div>
          </td>
          <td class="num">
            <div>${renderOutlierBadge(v.outlierRatio, v.outlierStatus, v.baselineSampleSize, minSample)}</div>
            <div class="cell-sub num">
              ${
                v.outlierStatus === "derived" && baselineFormatted
                  ? `Trung vị: ${baselineFormatted} (n=${v.baselineSampleSize})`
                  : v.outlierStatus === "unverified_source"
                    ? "Nguồn cũ chưa xác minh"
                    : `Mẫu n=${v.baselineSampleSize || 0}/${minSample}`
              }
            </div>
          </td>
          <td class="num">
            <div class="cell-primary num">~$${Number(v.estimatedRpm || 0).toFixed(2)}</div>
            <div class="cell-sub">${escapeHtml(v.niche || "General")}</div>
          </td>
          <td class="num" onclick="event.stopPropagation();">
            <div class="row-actions">
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-save-video-idea="${escapeHtml(v.videoId)}"
              >
                + Lưu ý tưởng
              </button>
              <a
                href="${escapeHtml(v.canonicalUrl || `https://www.youtube.com/watch?v=${v.videoId}`)}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-sm btn-ghost"
                title="Mở trên YouTube"
              >
                YT ↗
              </a>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

// ============================================================================
// CHANNEL DETAIL DRAWER (640px Slide-Over with 3 Tabs — Section 7)
// ============================================================================

async function openChannelDrawer(channelId) {
  if (!channelId) return;
  appState.drawerChannelId = channelId;
  appState.drawerActiveTab = "overview";
  const backdrop = document.getElementById("channel-drawer-backdrop");
  if (backdrop) {
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
  }

  const contentEl = document.getElementById("drawer-tab-content");
  if (contentEl) {
    contentEl.innerHTML = `<div style="color: var(--text-muted); padding: 20px 0;">Đang tải chi tiết kênh...</div>`;
  }

  try {
    const detail = await apiFetch(`/api/v1/channels/${encodeURIComponent(channelId)}`);
    appState.drawerChannelDetail = detail;
    renderChannelDrawer();
  } catch (err) {
    showToast(err.message || "Không thể tải thông tin kênh", "error");
  }
}

function closeChannelDrawer() {
  const backdrop = document.getElementById("channel-drawer-backdrop");
  if (backdrop) {
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
  }
  appState.drawerChannelId = null;
}

function renderChannelDrawer() {
  const detail = appState.drawerChannelDetail;
  if (!detail || !detail.channel) return;
  const c = detail.channel;
  const g = detail.growthTracking || {};
  const minSample = appState.meta?.minOutlierSampleSize || 3;

  const avatarEl = document.getElementById("drawer-channel-avatar");
  const titleEl = document.getElementById("drawer-channel-title");
  const metaEl = document.getElementById("drawer-channel-meta");
  const watchBtn = document.getElementById("btn-drawer-watchlist");
  const vidCountEl = document.getElementById("drawer-video-count");

  if (avatarEl) avatarEl.textContent = (c.title || "NX").slice(0, 2).toUpperCase();
  if (titleEl) titleEl.textContent = c.title;
  if (metaEl) {
    metaEl.innerHTML = `
      <span class="mono">${escapeHtml(c.handle || c.id)}</span>
      <span>·</span>
      <span>${escapeHtml(c.niche || "General")}</span>
      <span>·</span>
      <a href="${escapeHtml(c.canonicalUrl || `https://www.youtube.com/channel/${c.id}`)}" target="_blank" rel="noopener noreferrer">Mở YouTube ↗</a>
    `;
  }
  if (watchBtn) {
    watchBtn.textContent = c.isTracked ? "Đang theo dõi (Watchlist)" : "+ Theo dõi";
    watchBtn.className = `btn btn-sm ${c.isTracked ? "btn-positive" : ""}`;
  }
  if (vidCountEl) {
    vidCountEl.textContent = String((c.videos || []).length);
  }

  // Render 4 KPI mini cards
  const kpiStrip = document.getElementById("drawer-kpi-strip");
  if (kpiStrip) {
    const subsVal = formatCompactNumber(c.subscribers);
    const avgVal = formatCompactNumber(c.avgViews);
    const medVal = formatCompactNumber(c.medianViews);
    kpiStrip.innerHTML = `
      <div class="kpi-mini-card">
        <div class="kpi-mini-label">Người đăng ký</div>
        <div class="kpi-mini-value num">${subsVal ?? "Chưa rõ"}</div>
        <div class="kpi-mini-sub">${subsVal ? "Quan sát trực tiếp" : "YouTube ẩn trên luồng quét"}</div>
      </div>
      <div class="kpi-mini-card">
        <div class="kpi-mini-label">Lượt xem TB / Trung vị</div>
        <div class="kpi-mini-value num">${avgVal ?? "—"} <span style="font-weight:400;color:var(--text-muted)">/ ${medVal ?? "—"}</span></div>
        <div class="kpi-mini-sub num">Cỡ mẫu: n=${c.observedVideoSampleCount || 0} video</div>
      </div>
      <div class="kpi-mini-card">
        <div class="kpi-mini-label">Outlier cao nhất</div>
        <div class="kpi-mini-value num">${c.topOutlierRatio ? `${Number(c.topOutlierRatio).toFixed(1)}x` : "Chưa đủ mẫu"}</div>
        <div class="kpi-mini-sub">${c.outlierStatus === "derived" ? "So với trung vị cùng loại" : `Cần ≥ ${minSample} video xác minh`}</div>
      </div>
      <div class="kpi-mini-card">
        <div class="kpi-mini-label">RPM kịch bản</div>
        <div class="kpi-mini-value num">~$${Number(c.estimatedRpm || 0).toFixed(2)}</div>
        <div class="kpi-mini-sub">Kịch bản ước tính (${escapeHtml(c.niche)})</div>
      </div>
    `;
  }

  // Sync active tab button
  document.querySelectorAll("[data-drawer-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.drawerTab === appState.drawerActiveTab);
  });

  const contentEl = document.getElementById("drawer-tab-content");
  if (!contentEl) return;

  if (appState.drawerActiveTab === "overview") {
    const growthHtml = g.comparable
      ? `<div class="badge badge-positive num">+${formatCompactNumber(g.viewsDelta) || 0} views (${g.viewsGrowthPct !== null ? `${g.viewsGrowthPct}%` : "—"})</div>
         <div class="form-hint" style="margin-top:4px;">So sánh chính xác trên ${g.commonVideoCount || "tổng"} video quan sát chung qua ${g.snapshotsCount} lần chụp (${g.elapsedDays} ngày).</div>`
      : `<div class="badge badge-neutral">Chưa đủ lịch sử so sánh (${g.snapshotsCount || 0} lần chụp)</div>
         <div class="form-hint" style="margin-top:4px;">Hệ thống chỉ tính tốc độ tăng trưởng khi có ≥ 2 lần chụp khác thời điểm trên cùng tập video (T05).</div>`;

    contentEl.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <div class="panel-card">
          <h3 class="panel-card-title">Ghi chú Watchlist &amp; Đánh giá của Team</h3>
          <div style="display: flex; gap: 8px;">
            <input
              type="text"
              class="input"
              id="drawer-watchlist-note-input"
              value="${escapeHtml(c.notes || "")}"
              placeholder="Ghi chú góc ngách, tần suất đăng hoặc cấu trúc thumbnail của kênh này..."
              style="flex: 1;"
            />
            <button type="button" class="btn btn-primary" id="btn-save-drawer-note">Lưu ghi chú</button>
          </div>
        </div>

        <div class="panel-card">
          <h3 class="panel-card-title">Theo dõi tăng trưởng thực tế (Cohort Snapshot Tracking)</h3>
          <div>${growthHtml}</div>
        </div>

        <div class="panel-card">
          <h3 class="panel-card-title">Mô phỏng kịch bản doanh thu (Scenario Simulator)</h3>
          <div class="form-hint">
            Doanh thu đối thủ là kịch bản ước lượng dựa trên giả định RPM ngách <strong>${escapeHtml(c.niche)}</strong> (~$${Number(c.estimatedRpm || 0).toFixed(2)} / 1.000 views), không phải số liệu từ YouTube Studio của đối thủ.
          </div>
          <div class="form-grid" style="align-items: end; margin-top: 6px;">
            <div class="form-field">
              <label class="form-label" for="drawer-sim-views">Giả định lượt xem / tháng</label>
              <input type="number" class="input num" id="drawer-sim-views" value="${Number(c.viewsOfObservedRecentUploads || 300000)}" step="50000" min="0" />
            </div>
            <div id="drawer-sim-output" class="kpi-mini-card num"></div>
          </div>
        </div>
      </div>
    `;
    updateDrawerSimulatorOutput(c.estimatedRpm || 4);
  } else if (appState.drawerActiveTab === "videos") {
    const videos = (c.videos || []).filter((v) =>
      appState.drawerVideoFormatFilter === "all"
        ? true
        : v.contentType === appState.drawerVideoFormatFilter
    );

    contentEl.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div class="segmented">
            <button type="button" class="segmented-btn ${appState.drawerVideoFormatFilter === "all" ? "active" : ""}" data-drawer-vf="all">Tất cả (${(c.videos || []).length})</button>
            <button type="button" class="segmented-btn ${appState.drawerVideoFormatFilter === "long" ? "active" : ""}" data-drawer-vf="long">Video dài</button>
            <button type="button" class="segmented-btn ${appState.drawerVideoFormatFilter === "shorts" ? "active" : ""}" data-drawer-vf="shorts">Shorts</button>
            <button type="button" class="segmented-btn ${appState.drawerVideoFormatFilter === "unknown" ? "active" : ""}" data-drawer-vf="unknown">Chưa rõ loại</button>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${videos
            .map((v) => {
              const extra = appState.drawerVideoExtraById.get(v.videoId);
              return `
                <div class="panel-card" style="padding: 12px;">
                  <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
                    <div class="entity-cell" style="flex: 1;">
                      <div class="video-thumb-wrap">
                        ${v.thumbnailUrl ? `<img src="${escapeHtml(v.thumbnailUrl)}" alt="" loading="lazy" />` : ""}
                        <span class="thumb-duration">${escapeHtml(formatDurationMinutes(v.durationMinutes))}</span>
                      </div>
                      <div class="entity-info">
                        <div class="entity-title">${escapeHtml(v.title)}</div>
                        <div class="entity-sub">
                          <span class="badge badge-neutral">${escapeHtml(v.contentType || "unknown")}</span>
                          <span class="num">${formatCompactNumber(v.views) ?? "Chưa rõ"} views</span>
                          <span>·</span>
                          <span>${escapeHtml(formatPublishedAge(v.publishedDaysAgo))}</span>
                        </div>
                      </div>
                    </div>
                    <div style="text-align: right; flex-shrink: 0;">
                      ${renderOutlierBadge(v.outlierRatio, v.outlierStatus, v.baselineSampleSize, minSample)}
                      <div class="cell-sub num" style="margin-top: 3px;">
                        ${v.baselineMedianViews ? `Trung vị: ${formatCompactNumber(v.baselineMedianViews)}` : "Chưa có trung vị"}
                      </div>
                    </div>
                  </div>
                  <div style="display: flex; align-items: center; justify-content: flex-end; gap: 6px; border-top: 1px solid var(--border-subtle); padding-top: 8px;">
                    <button type="button" class="btn btn-sm btn-ghost" data-drawer-transcript="${escapeHtml(v.videoId)}">Phụ đề gốc (Transcript)</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-drawer-outline="${escapeHtml(v.videoId)}">Gợi ý dàn ý (Metadata)</button>
                    <button type="button" class="btn btn-sm btn-primary" data-drawer-save-video="${escapeHtml(v.videoId)}">+ Lưu ý tưởng</button>
                  </div>
                  ${
                    extra
                      ? `<div style="padding: 10px; border-radius: 6px; background: var(--bg-canvas); border: 1px solid var(--border-subtle); font-size: 12px;">
                           ${extra.html}
                         </div>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  } else if (appState.drawerActiveTab === "provenance") {
    contentEl.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div class="panel-card">
          <h3 class="panel-card-title">Phân tách Nguồn gốc Địa lý &amp; Ngôn ngữ</h3>
          <div class="table-wrap">
            <table class="data-table" style="min-width: 480px;">
              <thead>
                <tr>
                  <th>Trường thông tin</th>
                  <th>Giá trị</th>
                  <th>Trạng thái xác minh</th>
                  <th>Giải thích</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Thị trường tìm kiếm (Discovery Market)</td>
                  <td class="mono">${escapeHtml(c.discoveryMarket?.country || "US")} (${escapeHtml(c.discoveryMarket?.language || "en")})</td>
                  <td><span class="badge badge-positive">observed</span></td>
                  <td>Tham số gl/hl dùng khi truy vấn tìm kiếm</td>
                </tr>
                <tr>
                  <td>Quốc gia đăng ký kênh (Channel Country)</td>
                  <td class="mono">${escapeHtml(c.channelCountry || "Chưa xác định")}</td>
                  <td><span class="badge badge-neutral">${escapeHtml(c.channelCountryStatus || "unknown")}</span></td>
                  <td>Không tự suy từ thị trường tìm kiếm</td>
                </tr>
                <tr>
                  <td>Ngôn ngữ nội dung (Content Language)</td>
                  <td class="mono">${escapeHtml(c.contentLanguage || "Chưa xác định")}</td>
                  <td><span class="badge badge-neutral">${escapeHtml(c.contentLanguageStatus || "unknown")}</span></td>
                  <td>Chỉ xác nhận khi có metadata ngôn ngữ rõ ràng</td>
                </tr>
                <tr>
                  <td>Địa lý khán giả (Audience Geography)</td>
                  <td class="mono">Chưa xác định</td>
                  <td><span class="badge badge-neutral">unknown</span></td>
                  <td>Dữ liệu riêng tư trong YouTube Analytics của chủ kênh</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="panel-card">
          <h3 class="panel-card-title">Nguồn gốc Chỉ số &amp; Phương pháp Tính</h3>
          <div class="table-wrap">
            <table class="data-table" style="min-width: 480px;">
              <thead>
                <tr>
                  <th>Chỉ số</th>
                  <th>Giá trị</th>
                  <th>Trạng thái</th>
                  <th>Chi tiết / Giới hạn</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Nguồn bản ghi (Data Origin)</td>
                  <td class="mono">${escapeHtml(c.dataOrigin)}</td>
                  <td><span class="badge ${c.dataOrigin === "observed" ? "badge-positive" : "badge-warning"}">${escapeHtml(c.dataOrigin)}</span></td>
                  <td>Nguồn: ${escapeHtml(c.source || "unknown")}</td>
                </tr>
                <tr>
                  <td>Outlier cao nhất</td>
                  <td class="num">${c.topOutlierRatio ? `${c.topOutlierRatio}x` : "null"}</td>
                  <td><span class="badge badge-neutral">${escapeHtml(c.outlierStatus)}</span></td>
                  <td>Phương pháp: ${escapeHtml(c.outlierMethodVersion || "v2.1")} · Lý do: ${escapeHtml(c.outlierReason || "ok")}</td>
                </tr>
                <tr>
                  <td>Trạng thái kiếm tiền (YPP)</td>
                  <td>Chưa xác định</td>
                  <td><span class="badge badge-neutral">${escapeHtml(c.monetizationStatus || "unknown")}</span></td>
                  <td>Không suy diễn YPP từ số người đăng ký ≥ 1.000</td>
                </tr>
                <tr>
                  <td>Phân loại Faceless</td>
                  <td>${escapeHtml(c.facelessLabel || "unknown")}</td>
                  <td><span class="badge badge-neutral">${escapeHtml(c.facelessStatus || "unknown")}</span></td>
                  <td>Gợi ý heuristic từ từ khóa: ${(c.facelessKeywordsMatched || []).join(", ") || "Không khớp"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
}

function updateDrawerSimulatorOutput(baseRpm) {
  const input = document.getElementById("drawer-sim-views");
  const out = document.getElementById("drawer-sim-output");
  if (!input || !out) return;
  const views = Math.max(0, Number(input.value || 0));
  const rpm = Math.max(0.5, Number(baseRpm || 4));
  const low = Math.round((views / 1000) * rpm * 0.65);
  const base = Math.round((views / 1000) * rpm);
  const high = Math.round((views / 1000) * rpm * 1.35);
  out.innerHTML = `
    <div class="kpi-mini-label">Kịch bản doanh thu tháng (Thấp / Cơ sở / Cao)</div>
    <div class="kpi-mini-value num">$${low.toLocaleString("en-US")} · <span style="color:var(--status-positive)">$${base.toLocaleString("en-US")}</span> · $${high.toLocaleString("en-US")}</div>
  `;
}

// ============================================================================
// VIEW 2: WATCHLIST (#/watchlist)
// ============================================================================

async function loadWatchlistData() {
  const data = await apiFetch(
    `/api/v1/tracker?query=${encodeURIComponent(appState.watchlistQuery || "")}`
  );
  appState.watchlistChannels = data.channels || [];
  renderWatchlistTable();
}

function renderWatchlistTable() {
  const tbody = document.getElementById("watchlist-tbody");
  if (!tbody) return;
  const rows = appState.watchlistChannels || [];

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 36px 16px; color: var(--text-secondary);">
          Watchlist hiện đang trống. Hãy bấm <strong>+ Watchlist</strong> ở mục Khám phá để theo dõi kênh đối thủ cùng team.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map((c) => {
      const g = c.growthTracking || {};
      const subsFormatted = formatCompactNumber(c.subscribers);
      const avgFormatted = formatCompactNumber(c.avgViews);

      const cohortHtml = g.comparable
        ? `<span class="badge badge-positive num">+${formatCompactNumber(g.viewsDelta) || 0} (${g.viewsGrowthPct !== null ? `${g.viewsGrowthPct}%` : "—"})</span>
           <div class="cell-sub num">${g.basis === "video_cohort_intersection" ? `Cùng kỳ n=${g.commonVideoCount} video` : "Tổng view kênh"} · ${g.elapsedDays} ngày</div>`
        : `<span class="badge badge-neutral">Chưa đủ lịch sử (${g.snapshotsCount || 0} lần chụp)</span>
           <div class="cell-sub">Cần ≥ 2 lần quét để so sánh cùng kỳ</div>`;

      return `
        <tr class="clickable-row" data-open-channel="${escapeHtml(c.id)}">
          <td>
            <div class="entity-cell">
              <div class="channel-avatar">${escapeHtml((c.title || "NX").slice(0, 2).toUpperCase())}</div>
              <div class="entity-info">
                <div class="entity-title">${escapeHtml(c.title)}</div>
                <div class="entity-sub">
                  <span class="mono">${escapeHtml(c.handle || c.id)}</span>
                  <span>·</span>
                  <span>${escapeHtml(c.niche || "General")}</span>
                </div>
              </div>
            </div>
          </td>
          <td class="num">
            <div class="cell-primary num">${subsFormatted ?? "Chưa rõ"}</div>
          </td>
          <td class="num">
            <div class="cell-primary num">${avgFormatted ?? "Chưa rõ"}</div>
            <div class="cell-sub num">n=${c.observedVideoSampleCount || 0} video</div>
          </td>
          <td class="num">${cohortHtml}</td>
          <td onclick="event.stopPropagation();">
            <div style="display: flex; gap: 6px;">
              <input
                type="text"
                class="input"
                style="height: 28px; flex: 1;"
                data-watchlist-note-input="${escapeHtml(c.id)}"
                value="${escapeHtml(c.notes || "")}"
                placeholder="Ghi chú theo dõi..."
              />
              <button type="button" class="btn btn-sm" data-save-watchlist-note="${escapeHtml(c.id)}">Lưu</button>
            </div>
          </td>
          <td class="num" onclick="event.stopPropagation();">
            <div class="row-actions">
              <button type="button" class="btn btn-sm btn-danger" data-remove-watchlist="${escapeHtml(c.id)}">Bỏ theo dõi</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

// ============================================================================
// VIEW 3: Ý TƯỞNG (#/ideas)
// ============================================================================

async function loadSwipeAndRenderIdeas() {
  const data = await apiFetch("/api/v1/swipe");
  appState.swipeItems = data.items || [];
  renderIdeasView();
}

function renderIdeasView() {
  const allItems = appState.swipeItems || [];
  const discoveredCount = allItems.filter((i) => i.workflowStage === "discovered").length;
  const approvedCount = allItems.filter((i) => i.workflowStage === "approved").length;

  const cDisc = document.getElementById("ideas-count-discovered");
  const cAppr = document.getElementById("ideas-count-approved");
  const cAll = document.getElementById("ideas-count-all");
  if (cDisc) cDisc.textContent = String(discoveredCount);
  if (cAppr) cAppr.textContent = String(approvedCount);
  if (cAll) cAll.textContent = String(allItems.length);

  const q = (appState.ideasQuery || "").trim().toLowerCase();
  const filtered = allItems.filter((item) => {
    if (appState.ideasSubview !== "all" && item.workflowStage !== appState.ideasSubview) {
      return false;
    }
    if (q) {
      const hay = `${item.title} ${item.channelTitle} ${item.channelHandle} ${item.notes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("ideas-tbody");
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 36px 16px; color: var(--text-secondary);">
          Không có ý tưởng nào trong phân mục này. Lưu video từ mục <strong>Khám phá</strong> hoặc bấm <strong>+ Thêm ý tưởng thủ công</strong>.
        </td>
      </tr>
    `;
    return;
  }

  const isManager = appState.currentUser?.role === "manager";

  tbody.innerHTML = filtered
    .map((item) => {
      const stageCls = STAGE_BADGE_CLASS[item.workflowStage] || "badge-neutral";
      const stageLabel = STAGE_LABELS[item.workflowStage] || item.workflowStage;
      const canDelete =
        isManager ||
        (item.createdBy === appState.currentUser?.username && item.workflowStage === "discovered");

      let actionButtons = "";
      if (item.workflowStage === "discovered") {
        if (isManager) {
          actionButtons = `
            <button type="button" class="btn btn-sm btn-positive" data-approve-idea="${escapeHtml(item.id)}">
              Duyệt ý tưởng
            </button>
          `;
        } else {
          actionButtons = `<span class="badge badge-neutral">Chờ Quản lý duyệt</span>`;
        }
      } else if (item.workflowStage === "approved") {
        actionButtons = `
          <button type="button" class="btn btn-sm btn-primary" data-create-brief-idea="${escapeHtml(item.id)}">
            Tạo Brief &amp; Sản xuất →
          </button>
        `;
      } else {
        actionButtons = `
          <button type="button" class="btn btn-sm" data-open-in-production="${escapeHtml(item.id)}">
            Mở trong Sản xuất →
          </button>
        `;
      }

      return `
        <tr>
          <td>
            <div class="entity-cell">
              ${
                item.thumbnailUrl
                  ? `<div class="video-thumb-wrap" style="width:80px;height:45px;"><img src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" /></div>`
                  : ""
              }
              <div class="entity-info">
                <div class="entity-title">${escapeHtml(item.title)}</div>
                <div class="entity-sub">
                  <span>${escapeHtml(item.channelTitle || "Đề xuất nội bộ")}</span>
                  ${
                    item.canonicalUrl
                      ? `<span>·</span><a href="${escapeHtml(item.canonicalUrl)}" target="_blank" rel="noopener noreferrer">Video gốc ↗</a>`
                      : ""
                  }
                </div>
              </div>
            </div>
          </td>
          <td class="num">
            ${
              item.outlierRatio
                ? `<span class="badge badge-positive num">${Number(item.outlierRatio).toFixed(1)}x</span>`
                : `<span class="badge badge-neutral">—</span>`
            }
            <div class="cell-sub num">${formatCompactNumber(item.views) ? `${formatCompactNumber(item.views)} views` : ""}</div>
          </td>
          <td>
            <span class="badge ${stageCls}">${escapeHtml(stageLabel)}</span>
          </td>
          <td>
            <div style="font-size: 12px; color: var(--text-primary);">${escapeHtml(item.notes || "Chưa có ghi chú")}</div>
            <div class="cell-sub">Đề xuất bởi: @${escapeHtml(item.createdBy || "team")}</div>
          </td>
          <td class="num">
            <div class="row-actions">
              ${actionButtons}
              ${
                canDelete
                  ? `<button type="button" class="btn btn-sm btn-ghost" data-delete-swipe="${escapeHtml(item.id)}" title="Xóa mục">Xóa</button>`
                  : ""
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

// ============================================================================
// VIEW 4: SẢN XUẤT (#/production — Table + Split Detail + Per-Item Draft State)
// ============================================================================

async function loadSwipeAndRenderProduction() {
  const data = await apiFetch("/api/v1/swipe");
  appState.swipeItems = data.items || [];
  if (
    !appState.selectedProductionItemId &&
    appState.swipeItems.length > 0
  ) {
    appState.selectedProductionItemId = appState.swipeItems[0].id;
  }
  renderProductionView();
}

function getEffectiveItemState(item) {
  if (!item) return null;
  const draft = appState.draftStateByItemId.get(item.id);
  if (!draft) {
    return {
      ...item,
      isDirty: false,
      baseRevision: item.revision || 1
    };
  }
  return {
    ...item,
    ...draft.dirtyFields,
    isDirty: Object.keys(draft.dirtyFields || {}).length > 0,
    baseRevision: draft.baseRevision || item.revision || 1
  };
}

function setItemDraftField(itemId, field, value) {
  const baseItem = (appState.swipeItems || []).find((i) => i.id === itemId);
  if (!baseItem) return;
  const existing = appState.draftStateByItemId.get(itemId) || {
    dirtyFields: {},
    baseRevision: baseItem.revision || 1
  };
  existing.dirtyFields[field] = value;
  appState.draftStateByItemId.set(itemId, existing);
  const dirtyEl = document.getElementById("prod-dirty-indicator");
  if (dirtyEl) dirtyEl.style.display = "inline-flex";
}

function clearItemDraft(itemId) {
  appState.draftStateByItemId.delete(itemId);
  appState.conflictByItemId.delete(itemId);
}

function getFilteredProductionItems() {
  return (appState.swipeItems || []).filter((item) => {
    if (
      appState.productionStageFilter !== "all" &&
      item.workflowStage !== appState.productionStageFilter
    ) {
      return false;
    }
    if (appState.productionAssigneeFilter === "mine") {
      const me = (appState.currentUser?.username || "").toLowerCase();
      const myName = (appState.currentUser?.displayName || "").toLowerCase();
      const owner = `${item.assigneeId || ""} ${item.ownerLabel || ""}`.toLowerCase();
      if (!owner.includes(me) && (!myName || !owner.includes(myName))) return false;
    } else if (appState.productionAssigneeFilter !== "all") {
      const target = appState.productionAssigneeFilter.toLowerCase();
      const owner = `${item.assigneeId || ""} ${item.ownerLabel || ""}`.toLowerCase();
      if (!owner.includes(target)) return false;
    }
    return true;
  });
}

function renderProductionView() {
  const isSplit = appState.productionLayout === "split";
  const splitContainer = document.getElementById("production-split-container");
  const kanbanContainer = document.getElementById("production-kanban-container");
  if (splitContainer) splitContainer.style.display = isSplit ? "grid" : "none";
  if (kanbanContainer) kanbanContainer.style.display = !isSplit ? "grid" : "none";

  const items = getFilteredProductionItems();

  if (isSplit) {
    renderProductionTable(items);
    renderProductionDetailPane();
  } else {
    renderProductionKanban(items);
  }
}

function renderProductionTable(items) {
  const tbody = document.getElementById("production-table-tbody");
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 32px 12px; color: var(--text-secondary);">
          Chưa có công việc nào khớp bộ lọc.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items
    .map((item) => {
      const eff = getEffectiveItemState(item);
      const isSelected = item.id === appState.selectedProductionItemId;
      const stageCls = STAGE_BADGE_CLASS[item.workflowStage] || "badge-neutral";
      const stageLabel = STAGE_LABELS[item.workflowStage] || item.workflowStage;

      return `
        <tr class="clickable-row ${isSelected ? "selected-row" : ""}" data-select-prod-item="${escapeHtml(item.id)}">
          <td>
            <div class="entity-title">
              ${escapeHtml(eff.title)}
              ${eff.isDirty ? `<span style="color:var(--status-warning)" title="Có thay đổi chưa lưu">●</span>` : ""}
            </div>
            <div class="entity-sub">
              <span>${escapeHtml(item.channelTitle || "Nội bộ")}</span>
              <span>·</span>
              <span class="mono">Rev #${item.revision || 1}</span>
            </div>
          </td>
          <td>
            <span class="badge ${stageCls}">${escapeHtml(stageLabel)}</span>
          </td>
          <td>
            <div style="font-size: 12px; font-weight: 500;">${escapeHtml(eff.ownerLabel || "Chưa phân công")}</div>
            <div class="cell-sub mono">${escapeHtml(eff.deadline || "Chưa đặt hạn")}</div>
          </td>
          <td class="num">
            ${
              item.outlierRatio
                ? `<span class="badge badge-positive num">${Number(item.outlierRatio).toFixed(1)}x</span>`
                : `<span class="badge badge-neutral">—</span>`
            }
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderProductionKanban(items) {
  const container = document.getElementById("production-kanban-container");
  if (!container) return;
  const stages = ["discovered", "approved", "briefing", "assigned", "published", "review"];

  container.innerHTML = stages
    .map((st) => {
      const colItems = items.filter((i) => i.workflowStage === st);
      return `
        <div class="kanban-col">
          <div class="kanban-col-header">
            <span>${escapeHtml(STAGE_LABELS[st])}</span>
            <span class="badge badge-neutral num">${colItems.length}</span>
          </div>
          <div class="kanban-col-body">
            ${colItems
              .map(
                (item) => `
                <div class="kanban-card ${item.id === appState.selectedProductionItemId ? "selected" : ""}" data-kanban-select="${escapeHtml(item.id)}">
                  <div style="font-weight: 600; font-size: 12.5px;">${escapeHtml(item.title)}</div>
                  <div class="cell-sub">${escapeHtml(item.channelTitle || "Nội bộ")}</div>
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                    <span class="badge badge-neutral">${escapeHtml(item.ownerLabel || "Chưa giao")}</span>
                    <span class="mono" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(item.deadline || "")}</span>
                  </div>
                </div>
              `
              )
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");
}

function getAllowedNextStagesForUser(currentStage, userRole) {
  const policy = appState.meta?.workflowPolicy || {
    discovered: { approved: ["manager"] },
    approved: { briefing: ["manager", "member"], discovered: ["manager"] },
    briefing: { assigned: ["manager"], approved: ["manager"] },
    assigned: { published: ["manager", "member"], briefing: ["manager", "member"] },
    published: { review: ["manager", "member"], assigned: ["manager"] },
    review: { published: ["manager"] }
  };
  const stageMap = policy[currentStage] || {};
  return Object.entries(stageMap)
    .filter(([, allowedRoles]) => allowedRoles.includes(userRole))
    .map(([toStage]) => toStage);
}

function renderProductionDetailPane() {
  const headerEl = document.getElementById("prod-detail-header");
  const tabsEl = document.getElementById("prod-detail-tabs");
  const bodyEl = document.getElementById("prod-detail-body");
  const footerEl = document.getElementById("prod-detail-footer");

  const baseItem = (appState.swipeItems || []).find(
    (i) => i.id === appState.selectedProductionItemId
  );

  if (!baseItem) {
    if (headerEl) {
      headerEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12.5px;">Chọn một công việc ở bảng bên trái để xem và biên tập Brief, phân công hoặc cập nhật kết quả.</div>`;
    }
    if (tabsEl) tabsEl.style.display = "none";
    if (bodyEl) bodyEl.style.display = "none";
    if (footerEl) footerEl.style.display = "none";
    return;
  }

  const eff = getEffectiveItemState(baseItem);
  const isManager = appState.currentUser?.role === "manager";
  const userRole = appState.currentUser?.role || "member";
  const nextStages = getAllowedNextStagesForUser(baseItem.workflowStage, userRole);
  const conflictServerItem = appState.conflictByItemId.get(baseItem.id);

  if (tabsEl) tabsEl.style.display = "flex";
  if (bodyEl) bodyEl.style.display = "flex";
  if (footerEl) footerEl.style.display = "flex";

  const actCountEl = document.getElementById("prod-activity-count");
  if (actCountEl) actCountEl.textContent = String((baseItem.activityLog || []).length);

  const revBadge = document.getElementById("prod-revision-badge");
  if (revBadge) revBadge.textContent = `Rev #${baseItem.revision || 1}`;

  const dirtyInd = document.getElementById("prod-dirty-indicator");
  if (dirtyInd) dirtyInd.style.display = eff.isDirty ? "inline-flex" : "none";

  // Sync active tab
  document.querySelectorAll("[data-prod-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.prodTab === appState.activeProductionTab);
  });

  if (headerEl) {
    headerEl.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
        <div>
          <h2 style="margin: 0; font-size: 14.5px; font-weight: 600;">${escapeHtml(eff.title)}</h2>
          <div class="entity-sub" style="margin-top: 3px;">
            <span class="badge ${STAGE_BADGE_CLASS[baseItem.workflowStage] || "badge-neutral"}">${escapeHtml(STAGE_LABELS[baseItem.workflowStage])}</span>
            <span>·</span>
            <span>Kênh mẫu: ${escapeHtml(baseItem.channelTitle || "Nội bộ")}</span>
            ${
              baseItem.canonicalUrl
                ? `<span>·</span><a href="${escapeHtml(baseItem.canonicalUrl)}" target="_blank" rel="noopener noreferrer">Video gốc ↗</a>`
                : ""
            }
          </div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
        <span style="font-size: 11.5px; color: var(--text-muted);">Chuyển bước hợp lệ:</span>
        ${
          nextStages.length > 0
            ? nextStages
                .map(
                  (toSt) => `
                  <button type="button" class="btn btn-sm btn-primary" data-transition-stage="${escapeHtml(toSt)}">
                    → ${escapeHtml(STAGE_LABELS[toSt])}
                  </button>
                `
                )
                .join("")
            : `<span class="badge badge-neutral">Chỉ Quản lý mới có quyền chuyển bước tiếp theo</span>`
        }
      </div>
    `;
  }

  if (!bodyEl) return;

  const conflictHtml = conflictServerItem
    ? `
      <div class="conflict-banner">
        <div><strong>Xung đột phiên bản (409 Conflict):</strong> Công việc này vừa được cập nhật bởi <strong>@${escapeHtml(conflictServerItem.updatedBy || "đồng nghiệp")}</strong> lên <strong>Rev #${conflictServerItem.revision}</strong>.</div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-sm" id="btn-conflict-accept-server">Tải bản mới nhất từ máy chủ</button>
          <button type="button" class="btn btn-sm btn-danger" id="btn-conflict-force-overwrite">Ghi đè bằng bản đang sửa</button>
        </div>
      </div>
    `
    : "";

  if (appState.activeProductionTab === "brief") {
    const revisions = baseItem.briefRevisions || [];
    const briefBadge =
      baseItem.briefStatus === "user_edited"
        ? `<span class="badge badge-positive">Đã biên tập thủ công</span>`
        : baseItem.briefStatus === "template_draft"
          ? `<span class="badge badge-warning">Bản thảo tự động (Template Draft)</span>`
          : `<span class="badge badge-neutral">Chưa có Brief</span>`;

    bodyEl.innerHTML = `
      ${conflictHtml}
      <div class="form-grid">
        <div class="form-field">
          <label class="form-label" for="prod-input-assignee">Người phụ trách ${!isManager ? "(Chỉ Quản lý giao)" : ""}</label>
          <select class="select" id="prod-input-assignee" ${!isManager ? "disabled" : ""}>
            <option value="">-- Chưa phân công --</option>
            ${appState.teamUsers
              .filter((u) => u.isActive !== false)
              .map((u) => {
                const selected =
                  eff.assigneeId === u.id || eff.ownerLabel === u.displayName || eff.ownerLabel === u.username;
                return `<option value="${escapeHtml(u.id)}" data-owner-label="${escapeHtml(u.displayName)}" ${selected ? "selected" : ""}>${escapeHtml(u.displayName)} (@${escapeHtml(u.username)})</option>`;
              })
              .join("")}
          </select>
        </div>
        <div class="form-field">
          <label class="form-label" for="prod-input-deadline">Hạn hoàn thành (Deadline)</label>
          <input type="date" class="input mono" id="prod-input-deadline" value="${escapeHtml(eff.deadline || "")}" ${!isManager ? "disabled" : ""} />
        </div>
      </div>

      <div class="form-field">
        <label class="form-label" for="prod-input-result-url">Link Video Kết quả (Bắt buộc trước khi chuyển sang "5. Đã đăng")</label>
        <input
          type="url"
          class="input mono"
          id="prod-input-result-url"
          value="${escapeHtml(eff.resultUrl || "")}"
          placeholder="https://www.youtube.com/watch?v=..."
        />
      </div>

      <div class="form-field">
        <label class="form-label" for="prod-input-notes">Ghi chú sản xuất &amp; Nhận xét</label>
        <textarea class="textarea" id="prod-input-notes" rows="2">${escapeHtml(eff.notes || "")}</textarea>
      </div>

      <div class="form-field">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <label class="form-label" for="prod-input-brief">Nội dung Production Brief (Markdown)</label>
            ${briefBadge}
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${
              revisions.length > 0
                ? `<select class="select" id="prod-brief-revision-select" style="height: 26px; font-size: 11.5px;">
                     <option value="">Khôi phục phiên bản cũ (${revisions.length})...</option>
                     ${revisions
                       .map(
                         (r) =>
                           `<option value="${escapeHtml(String(r.id))}">Rev #${r.revisionNumber} · ${escapeHtml(r.source)} (${escapeHtml((r.createdAt || "").slice(0, 16))})</option>`
                       )
                       .join("")}
                   </select>`
                : ""
            }
            <button type="button" class="btn btn-sm" id="btn-prod-generate-brief">
              ${eff.briefMarkdown ? "Tạo lại Brief mẫu" : "Tạo Brief mẫu"}
            </button>
          </div>
        </div>
        <textarea
          class="textarea mono"
          id="prod-input-brief"
          rows="11"
          placeholder="Nhấn 'Tạo Brief mẫu' hoặc soạn trực tiếp kịch bản khung, Hook 30s đầu, bố cục hình ảnh..."
        >${escapeHtml(eff.briefMarkdown || "")}</textarea>
      </div>
    `;
  } else if (appState.activeProductionTab === "title-check") {
    const cachedAudit = appState.titleAuditByItemId.get(baseItem.id);
    bodyEl.innerHTML = `
      <div class="form-hint">
        Công cụ kiểm tra nhanh cấu trúc Tiêu đề cho đề tài đang sản xuất. Hệ thống chấm điểm dựa trên heuristic văn bản (độ dài, khoảng trống tò mò, con số) và <strong>không cộng điểm giả</strong> cho URL ảnh chưa phân tích thị giác.
      </div>
      <div class="form-field">
        <label class="form-label" for="prod-audit-title">Tiêu đề dự kiến phát hành</label>
        <input type="text" class="input" id="prod-audit-title" value="${escapeHtml(eff.title || "")}" />
      </div>
      <div>
        <button type="button" class="btn btn-primary" id="btn-run-prod-title-audit">Phân tích Tiêu đề</button>
      </div>
      <div id="prod-title-audit-result">
        ${
          cachedAudit
            ? renderTitleAuditResultHtml(cachedAudit)
            : `<div class="form-hint">Nhấn "Phân tích Tiêu đề" để xem checklist tối ưu CTR.</div>`
        }
      </div>
    `;
  } else if (appState.activeProductionTab === "activity") {
    const logs = baseItem.activityLog || [];
    bodyEl.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${
          logs.length === 0
            ? `<div class="form-hint">Chưa có lịch sử hoạt động nào.</div>`
            : logs
                .map(
                  (l) => `
                  <div style="padding: 8px 10px; border-radius: 6px; background: var(--bg-raised); border: 1px solid var(--border-subtle); font-size: 12px;">
                    <div style="display: flex; justify-content: space-between;">
                      <strong>@${escapeHtml(l.actorUsername)} (${escapeHtml(l.actorRole)})</strong>
                      <span class="mono" style="color: var(--text-muted);">${escapeHtml((l.createdAt || "").replace("T", " ").slice(0, 19))}</span>
                    </div>
                    <div style="color: var(--text-secondary); margin-top: 3px;">
                      Hành động: <span class="mono">${escapeHtml(l.action)}</span>
                      ${l.fromStage || l.toStage ? ` · ${escapeHtml(l.fromStage || "—")} → <strong>${escapeHtml(l.toStage || "—")}</strong>` : ""}
                    </div>
                  </div>
                `
                )
                .join("")
        }
      </div>
    `;
  }
}

function renderTitleAuditResultHtml(audit) {
  return `
    <div class="panel-card" style="margin-top: 8px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <div style="font-size: 12px; color: var(--text-muted);">Điểm cấu trúc tiêu đề (Heuristic)</div>
          <div class="num" style="font-size: 20px; font-weight: 700;">${audit.ctrScore} / ${audit.maxPossibleTitleScore || 100}</div>
        </div>
        <span class="badge badge-neutral">${escapeHtml(audit.readinessLabel || audit.scoreStatus)}</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
        ${(audit.checks || [])
          .map(
            (ch) => `
            <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 6px 8px; border-radius: 4px; background: var(--bg-canvas);">
              <span>${escapeHtml(ch.factor)}: <span style="color:var(--text-secondary)">${escapeHtml(ch.tip)}</span></span>
              <span class="badge ${ch.status === "pass" ? "badge-positive" : ch.status === "warn" ? "badge-warning" : "badge-neutral"}">${escapeHtml(ch.status)}</span>
            </div>
          `
          )
          .join("")}
      </div>
    </div>
  `;
}

async function saveCurrentProductionItem(forceLatestRevision = false) {
  const itemId = appState.selectedProductionItemId;
  const baseItem = (appState.swipeItems || []).find((i) => i.id === itemId);
  if (!baseItem) return;

  const eff = getEffectiveItemState(baseItem);
  const conflictItem = appState.conflictByItemId.get(itemId);
  const expectedRevision = forceLatestRevision && conflictItem
    ? conflictItem.revision
    : eff.baseRevision;

  try {
    const res = await apiFetch(`/api/v1/swipe/${encodeURIComponent(itemId)}`, {
      method: "PUT",
      body: {
        title: eff.title,
        assigneeId: eff.assigneeId,
        ownerLabel: eff.ownerLabel,
        deadline: eff.deadline,
        resultUrl: eff.resultUrl,
        notes: eff.notes,
        briefMarkdown: eff.briefMarkdown,
        expectedRevision
      }
    });
    clearItemDraft(itemId);
    const idx = appState.swipeItems.findIndex((i) => i.id === itemId);
    if (idx !== -1) appState.swipeItems[idx] = res.item;
    renderProductionView();
    showToast("Đã lưu công việc thành công.", "success");
  } catch (err) {
    if (err.status === 409 && err.payload?.serverItem) {
      appState.conflictByItemId.set(itemId, err.payload.serverItem);
      renderProductionDetailPane();
      showToast("Phát hiện xung đột phiên bản (409). Vui lòng chọn cách xử lý.", "error");
      return;
    }
    showToast(err.message || "Không thể lưu thay đổi", "error");
  }
}

// ============================================================================
// VIEW 5: QUẢN TRỊ (#/admin — Manager Only)
// ============================================================================

async function loadAdminData() {
  if (appState.currentUser?.role !== "manager") return;

  // Sync active tab
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.adminTab === appState.adminActiveTab);
  });
  const pUsers = document.getElementById("admin-panel-users");
  const pCrawler = document.getElementById("admin-panel-crawler");
  const pSettings = document.getElementById("admin-panel-settings");
  if (pUsers) pUsers.style.display = appState.adminActiveTab === "users" ? "grid" : "none";
  if (pCrawler) pCrawler.style.display = appState.adminActiveTab === "crawler" ? "grid" : "none";
  if (pSettings) pSettings.style.display = appState.adminActiveTab === "settings" ? "grid" : "none";

  if (appState.adminActiveTab === "users") {
    const res = await apiFetch("/api/v1/users");
    appState.teamUsers = res.users || [];
    renderAdminUsersTable();
  } else if (appState.adminActiveTab === "crawler") {
    const [health, imp] = await Promise.all([
      apiFetch("/api/v1/crawler/status"),
      apiFetch("/api/v1/import/targets")
    ]);
    appState.crawlerHealth = health;
    appState.importTargets = imp.targets || [];
    renderAdminCrawlerPanel();
  } else if (appState.adminActiveTab === "settings") {
    const [settings, tokenRes] = await Promise.all([
      apiFetch("/api/v1/settings"),
      apiFetch("/api/v1/auth/token")
    ]);
    appState.personalTokenPlain = tokenRes.apiToken || "";
    renderAdminSettingsPanel(settings, tokenRes.apiTokenPreview);
  }
}

function renderAdminUsersTable() {
  const tbody = document.getElementById("admin-users-tbody");
  if (!tbody) return;
  const users = appState.teamUsers || [];

  tbody.innerHTML = users
    .map((u) => {
      const isMe = u.id === appState.currentUser?.id;
      return `
        <tr>
          <td class="mono"><strong>@${escapeHtml(u.username)}</strong></td>
          <td>${escapeHtml(u.displayName)}</td>
          <td>
            <span class="badge ${u.role === "manager" ? "badge-accent" : "badge-neutral"}">
              ${u.role === "manager" ? "Quản lý" : "Thành viên"}
            </span>
          </td>
          <td>
            <span class="badge ${u.isActive ? "badge-positive" : "badge-danger"}">
              ${u.isActive ? "Đang hoạt động" : "Đã khóa"}
            </span>
          </td>
          <td class="mono">${escapeHtml(u.apiTokenPreview || "Chưa có")}</td>
          <td class="num">
            <div class="row-actions">
              <button type="button" class="btn btn-sm" data-admin-rotate-token="${escapeHtml(u.id)}">Đổi Token</button>
              <button type="button" class="btn btn-sm" data-admin-reset-pw="${escapeHtml(u.id)}">Đặt lại MK</button>
              ${
                !isMe
                  ? `<button type="button" class="btn btn-sm ${u.isActive ? "btn-danger" : "btn-positive"}" data-admin-toggle-active="${escapeHtml(u.id)}" data-current-active="${u.isActive ? "1" : "0"}">
                       ${u.isActive ? "Khóa" : "Mở khóa"}
                     </button>`
                  : ""
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderAdminCrawlerPanel() {
  const h = appState.crawlerHealth;
  if (!h) return;
  const summaryEl = document.getElementById("admin-crawler-summary");
  const enabledChk = document.getElementById("admin-schedule-enabled");
  const intervalInp = document.getElementById("admin-schedule-interval");

  if (summaryEl) {
    const sc = h.seedStats || {};
    summaryEl.innerHTML = `
      Tổng hạt giống (Seeds): <strong>${sc.total || 0}</strong> ·
      Chưa quét: <strong>${sc.unseen || 0}</strong> ·
      Thành công: <strong>${sc.succeeded || 0}</strong> ·
      Lỗi: <strong>${sc.failed || 0}</strong>
    `;
  }
  if (enabledChk) enabledChk.checked = Boolean(h.crawlerState?.autoScheduleEnabled);
  if (intervalInp) intervalInp.value = String(h.crawlerState?.intervalMinutes || 30);

  const jobsTbody = document.getElementById("admin-crawl-jobs-tbody");
  if (jobsTbody) {
    const jobs = h.recentJobs || [];
    jobsTbody.innerHTML = jobs
      .map((j) => {
        const p = j.progress || {};
        const progText =
          p.marketsTotal || p.seedsTotal
            ? `TT: ${p.marketsDone || 0}/${p.marketsTotal || 0} · Seeds: ${p.seedsDone || 0}/${p.seedsTotal || 0}`
            : j.status;
        return `
          <tr>
            <td class="mono">${escapeHtml(j.jobId)}</td>
            <td>${escapeHtml(j.jobType)} (${escapeHtml((j.markets || []).join(","))})</td>
            <td><span class="badge ${j.status === "completed" ? "badge-positive" : j.status === "running" ? "badge-accent" : "badge-warning"}">${escapeHtml(j.status)}</span></td>
            <td class="mono">${escapeHtml(progText)}</td>
            <td class="num">+${j.newChannelsCount || 0} / ~${j.updatedChannelsCount || 0}</td>
            <td class="mono" style="font-size:11px;">${escapeHtml((j.startedAt || "").slice(0, 19))}</td>
          </tr>
        `;
      })
      .join("");
  }

  const impTbody = document.getElementById("admin-import-targets-tbody");
  if (impTbody) {
    const targets = appState.importTargets || [];
    impTbody.innerHTML =
      targets.length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">Chưa có mục nào trong hàng đợi.</td></tr>`
        : targets
            .map(
              (t) => `
              <tr>
                <td class="mono">${escapeHtml(t.normalizedValue || t.rawInput)}</td>
                <td><span class="badge badge-neutral">${escapeHtml(t.kind)}</span></td>
                <td><span class="badge ${t.status === "resolved" ? "badge-positive" : "badge-warning"}">${escapeHtml(t.status)}</span></td>
                <td class="mono" style="font-size:11px;">${escapeHtml((t.createdAt || "").slice(0, 16))}</td>
              </tr>
            `
            )
            .join("");
  }
}

function renderAdminSettingsPanel(settings, tokenPreview) {
  const tokenInput = document.getElementById("personal-api-token-input");
  if (tokenInput) {
    tokenInput.value = appState.personalTokenRevealed
      ? appState.personalTokenPlain
      : tokenPreview || "••••••••";
  }

  const minSampleInp = document.getElementById("setting-min-sample");
  const demoChk = document.getElementById("setting-include-demo");
  const ytStatus = document.getElementById("status-yt-key");
  const gemStatus = document.getElementById("status-gemini-key");

  if (minSampleInp) minSampleInp.value = String(Math.max(3, Number(settings.minOutlierSampleSize || 3)));
  if (demoChk) demoChk.checked = Boolean(settings.includeDemo);
  if (ytStatus) {
    ytStatus.textContent = settings.hasYoutubeApiKey
      ? `Đã lưu (${settings.youtubeApiKeyMasked})`
      : "Chưa cấu hình";
  }
  if (gemStatus) {
    gemStatus.textContent = settings.hasGeminiApiKey
      ? `Đã lưu (${settings.geminiApiKeyMasked})`
      : "Chưa cấu hình";
  }
}

// ============================================================================
// EVENT LISTENERS & INITIALIZATION
// ============================================================================

function bindEvents() {
  // Sidebar navigation
  document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const route = btn.dataset.route;
      if (route) navigateTo(route);
    });
  });

  window.addEventListener("hashchange", handleHashChange);

  // Keyboard shortcut "/" or Cmd+K to focus Discover search
  document.addEventListener("keydown", (e) => {
    if (
      (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")
    ) {
      e.preventDefault();
      if (appState.route !== "discover") navigateTo("discover");
      const inp = document.getElementById("discover-search-input");
      if (inp) inp.focus();
    } else if (e.key === "Escape") {
      closeChannelDrawer();
      document.getElementById("collect-modal-backdrop")?.classList.remove("open");
      document.getElementById("idea-modal-backdrop")?.classList.remove("open");
      document.getElementById("discover-filter-popover")?.classList.remove("open");
    }
  });

  // Login Form
  const loginForm = document.getElementById("form-login");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = document.getElementById("login-server-error");
      if (errBox) errBox.style.display = "none";

      if (!loginForm.checkValidity()) {
        loginForm.querySelectorAll("input[required]").forEach((el) => {
          el.setAttribute("aria-invalid", !el.checkValidity() ? "true" : "false");
        });
        return;
      }

      const username = document.getElementById("login-username").value.trim();
      const password = document.getElementById("login-password").value;

      try {
        const res = await apiFetch("/api/v1/auth/login", {
          method: "POST",
          body: { username, password }
        });
        setStoredSessionToken(res.sessionToken);
        document.getElementById("login-password").value = "";
        closeAuthModal();
        await loadSystemMeta();
        handleHashChange();
        showToast(`Xin chào, ${res.user.displayName}!`, "success");
      } catch (err) {
        if (errBox) {
          errBox.textContent = err.message || "Đăng nhập thất bại.";
          errBox.style.display = "flex";
        }
      }
    });
  }

  // Logout & Copy Personal API Token in Sidebar
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setStoredSessionToken("");
    appState.currentUser = null;
    renderCurrentUserSidebar();
    openAuthModal();
  });

  document.getElementById("btn-copy-own-token")?.addEventListener("click", async () => {
    try {
      const res = await apiFetch("/api/v1/auth/token");
      if (res.apiToken && navigator.clipboard) {
        await navigator.clipboard.writeText(res.apiToken);
        showToast("Đã sao chép API Token cá nhân vào bộ nhớ tạm.", "success");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("btn-sidebar-crawler")?.addEventListener("click", () => {
    if (appState.currentUser?.role === "manager") {
      appState.adminActiveTab = "crawler";
      navigateTo("admin");
    } else {
      document.getElementById("collect-modal-backdrop")?.classList.add("open");
    }
  });

  // Topbar Export & Collect buttons
  document.getElementById("btn-export-current")?.addEventListener("click", () => {
    const f = appState.discoverFilters;
    const target =
      appState.route === "watchlist"
        ? "watchlist"
        : appState.route === "ideas"
          ? "ideas"
          : appState.route === "production"
            ? "production"
            : appState.discoverMode === "videos"
              ? "videos"
              : "channels";
    const params = new URLSearchParams({
      format: "csv",
      target,
      query: f.query || "",
      niche: f.niche || "all",
      contentType: f.contentType || "all",
      dataOrigin: f.dataOrigin || "observed"
    });
    window.open(`/api/v1/export?${params.toString()}`, "_blank");
  });

  const openCollectModal = () => {
    const m = document.getElementById("collect-modal-backdrop");
    if (m) {
      m.classList.add("open");
      m.setAttribute("aria-hidden", "false");
      document.getElementById("collect-keyword-input")?.focus();
    }
  };
  document.getElementById("btn-open-collect")?.addEventListener("click", openCollectModal);
  document.getElementById("btn-open-collect-top")?.addEventListener("click", openCollectModal);
  document.getElementById("btn-close-collect-modal")?.addEventListener("click", () => {
    document.getElementById("collect-modal-backdrop")?.classList.remove("open");
  });
  document.getElementById("btn-cancel-collect-1")?.addEventListener("click", () => {
    document.getElementById("collect-modal-backdrop")?.classList.remove("open");
  });
  document.getElementById("btn-cancel-collect-2")?.addEventListener("click", () => {
    document.getElementById("collect-modal-backdrop")?.classList.remove("open");
  });

  // Collect Dialog Tabs
  document.querySelectorAll("[data-collect-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.collectTab;
      document.querySelectorAll("[data-collect-tab]").forEach((b) =>
        b.classList.toggle("active", b.dataset.collectTab === tab)
      );
      document.getElementById("form-collect-keyword").style.display =
        tab === "keyword" ? "flex" : "none";
      document.getElementById("form-collect-import").style.display =
        tab === "import" ? "flex" : "none";
    });
  });

  // Collect Form 1: Live Keyword Scan
  document.getElementById("form-collect-keyword")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kwInput = document.getElementById("collect-keyword-input");
    const keyword = kwInput.value.trim();
    if (!keyword) {
      kwInput.setAttribute("aria-invalid", "true");
      return;
    }
    const country = document.getElementById("collect-country-select").value;
    const limit = Number(document.getElementById("collect-limit-input").value || 8);
    const submitBtn = document.getElementById("btn-submit-collect-keyword");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Đang quét YouTube...";
    }
    try {
      const res = await apiFetch("/api/v1/niche/scan-live", {
        method: "POST",
        body: { keyword, country, limit }
      });
      showToast(
        `Đã quét "${keyword}": phát hiện/cập nhật ${res.discoveredCount || 0} kênh.`,
        "success"
      );
      document.getElementById("collect-modal-backdrop")?.classList.remove("open");
      await loadSystemMeta();
      await loadDiscoverData();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Bắt đầu quét trực tiếp";
      }
    }
  });

  // Collect Form 2: Bulk Import Queue (T10)
  document.getElementById("form-collect-import")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ta = document.getElementById("collect-import-textarea");
    const raw = ta.value.trim();
    if (!raw) {
      ta.setAttribute("aria-invalid", "true");
      return;
    }
    try {
      const res = await apiFetch("/api/v1/import/bulk", {
        method: "POST",
        body: { input: raw }
      });
      const box = document.getElementById("collect-import-result-box");
      if (box) {
        box.innerHTML = `
          Đã kiểm tra <strong>${res.totalLines}</strong> dòng:
          Khớp trong kho: <strong>${res.resolvedCount}</strong> ·
          Đưa vào hàng đợi thu thập: <strong>${res.queuedCount}</strong> ·
          Từ chối (URL không hợp lệ): <strong>${res.rejectedCount}</strong>
        `;
      }
      showToast(
        `Đã xử lý ${res.totalLines} dòng (${res.queuedCount} vào hàng đợi, ${res.rejectedCount} từ chối).`,
        "success"
      );
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Discover Mode Switch (Kênh | Video)
  document.querySelectorAll("[data-discover-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.discoverFilters.page = 1;
      navigateTo("discover", btn.dataset.discoverMode);
    });
  });

  // Discover Debounced Search
  let searchTimer = null;
  document.getElementById("discover-search-input")?.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      appState.discoverFilters.query = e.target.value.trim();
      appState.discoverFilters.page = 1;
      loadDiscoverData();
    }, 260);
  });

  // Quick Filters: Format, Niche, Outlier, Sort
  document.querySelectorAll("[data-qf-format]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.discoverFilters.contentType = btn.dataset.qfFormat;
      appState.discoverFilters.page = 1;
      document.querySelectorAll("[data-qf-format]").forEach((b) =>
        b.classList.toggle("active", b.dataset.qfFormat === btn.dataset.qfFormat)
      );
      loadDiscoverData();
    });
  });

  document.getElementById("discover-niche-select")?.addEventListener("change", (e) => {
    appState.discoverFilters.niche = e.target.value;
    appState.discoverFilters.page = 1;
    loadDiscoverData();
  });

  document.querySelectorAll("[data-qf-outlier]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.discoverFilters.minOutlierScore = Number(btn.dataset.qfOutlier || 0);
      appState.discoverFilters.page = 1;
      document.querySelectorAll("[data-qf-outlier]").forEach((b) =>
        b.classList.toggle("active", b.dataset.qfOutlier === btn.dataset.qfOutlier)
      );
      loadDiscoverData();
    });
  });

  document.getElementById("discover-sort-select")?.addEventListener("change", (e) => {
    appState.discoverFilters.sortBy = e.target.value;
    appState.discoverFilters.page = 1;
    loadDiscoverData();
  });

  // Advanced Filter Popover
  document.getElementById("btn-toggle-filter-popover")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = document.getElementById("discover-filter-popover");
    if (pop) pop.classList.toggle("open");
  });

  const bindAdvFilter = (id, key, isCheckbox = false) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      appState.discoverFilters[key] = isCheckbox ? e.target.checked : e.target.value;
      appState.discoverFilters.page = 1;
      loadDiscoverData();
    });
  };
  bindAdvFilter("adv-data-origin", "dataOrigin");
  bindAdvFilter("adv-sample-filter", "outlierSampleFilter");
  bindAdvFilter("adv-faceless", "isFaceless");
  bindAdvFilter("adv-country", "country");
  bindAdvFilter("adv-max-subs", "maxSubscribers");
  bindAdvFilter("adv-min-rpm", "minRpm");
  bindAdvFilter("adv-include-unknown", "includeUnknown", true);

  document.getElementById("btn-reset-discover-filters")?.addEventListener("click", () => {
    appState.discoverFilters = {
      ...appState.discoverFilters,
      dataOrigin: "observed",
      outlierSampleFilter: "all",
      isFaceless: "all",
      country: "all",
      maxSubscribers: 0,
      minRpm: 0,
      includeUnknown: false,
      page: 1
    };
    document.getElementById("adv-data-origin").value = "observed";
    document.getElementById("adv-sample-filter").value = "all";
    document.getElementById("adv-faceless").value = "all";
    document.getElementById("adv-country").value = "all";
    document.getElementById("adv-max-subs").value = "0";
    document.getElementById("adv-min-rpm").value = "0";
    document.getElementById("adv-include-unknown").checked = false;
    loadDiscoverData();
  });

  document.getElementById("discover-active-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-chip]");
    if (!btn) return;
    const key = btn.dataset.removeChip;
    const defaults = {
      dataOrigin: "observed",
      outlierSampleFilter: "all",
      isFaceless: "all",
      country: "all",
      maxSubscribers: 0,
      minRpm: 0,
      includeUnknown: false
    };
    appState.discoverFilters[key] = defaults[key];
    appState.discoverFilters.page = 1;
    loadDiscoverData();
  });

  // Pagination buttons
  document.getElementById("btn-discover-prev")?.addEventListener("click", () => {
    if (appState.discoverFilters.page > 1) {
      appState.discoverFilters.page -= 1;
      loadDiscoverData();
    }
  });
  document.getElementById("btn-discover-next")?.addEventListener("click", () => {
    appState.discoverFilters.page += 1;
    loadDiscoverData();
  });

  // Watchlist search & refresh
  document.getElementById("watchlist-search-input")?.addEventListener("input", (e) => {
    appState.watchlistQuery = e.target.value.trim();
    loadWatchlistData();
  });
  document.getElementById("btn-refresh-watchlist")?.addEventListener("click", loadWatchlistData);

  // Ideas Sub-views & Manual Idea Modal
  document.querySelectorAll("[data-ideas-subview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.ideasSubview = btn.dataset.ideasSubview;
      document.querySelectorAll("[data-ideas-subview]").forEach((b) =>
        b.classList.toggle("active", b.dataset.ideasSubview === appState.ideasSubview)
      );
      renderIdeasView();
    });
  });

  document.getElementById("ideas-search-input")?.addEventListener("input", (e) => {
    appState.ideasQuery = e.target.value;
    renderIdeasView();
  });

  document.getElementById("btn-open-new-idea")?.addEventListener("click", () => {
    document.getElementById("idea-modal-backdrop")?.classList.add("open");
    document.getElementById("idea-title-input")?.focus();
  });
  document.getElementById("btn-close-idea-modal")?.addEventListener("click", () => {
    document.getElementById("idea-modal-backdrop")?.classList.remove("open");
  });
  document.getElementById("btn-cancel-idea-modal")?.addEventListener("click", () => {
    document.getElementById("idea-modal-backdrop")?.classList.remove("open");
  });

  document.getElementById("form-create-idea")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const titleInp = document.getElementById("idea-title-input");
    const title = titleInp.value.trim();
    if (!title) {
      titleInp.setAttribute("aria-invalid", "true");
      return;
    }
    try {
      await apiFetch("/api/v1/swipe", {
        method: "POST",
        body: {
          title,
          canonicalUrl: document.getElementById("idea-url-input").value.trim(),
          channelTitle: document.getElementById("idea-channel-input").value.trim(),
          notes: document.getElementById("idea-notes-input").value.trim()
        }
      });
      document.getElementById("idea-modal-backdrop")?.classList.remove("open");
      e.target.reset();
      showToast("Đã thêm ý tưởng mới vào bước 1. Phát hiện (Cần duyệt).", "success");
      await loadSystemMeta();
      await loadSwipeAndRenderIdeas();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Production Filters & Layout Switch
  document.querySelectorAll("[data-prod-stage]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.productionStageFilter = btn.dataset.prodStage;
      document.querySelectorAll("[data-prod-stage]").forEach((b) =>
        b.classList.toggle("active", b.dataset.prodStage === appState.productionStageFilter)
      );
      renderProductionView();
    });
  });

  document.getElementById("prod-assignee-filter")?.addEventListener("change", (e) => {
    appState.productionAssigneeFilter = e.target.value;
    renderProductionView();
  });

  document.querySelectorAll("[data-prod-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.productionLayout = btn.dataset.prodLayout;
      document.querySelectorAll("[data-prod-layout]").forEach((b) =>
        b.classList.toggle("active", b.dataset.prodLayout === appState.productionLayout)
      );
      renderProductionView();
    });
  });

  // Production Detail Pane Tabs & Save/Discard Buttons
  document.querySelectorAll("[data-prod-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.activeProductionTab = btn.dataset.prodTab;
      renderProductionDetailPane();
    });
  });

  document.getElementById("btn-prod-save")?.addEventListener("click", () => {
    saveCurrentProductionItem(false);
  });

  document.getElementById("btn-prod-discard-draft")?.addEventListener("click", () => {
    if (appState.selectedProductionItemId) {
      clearItemDraft(appState.selectedProductionItemId);
      renderProductionView();
      showToast("Đã hoàn tác các thay đổi chưa lưu.");
    }
  });

  // Production Detail Pane delegated input & click events
  document.getElementById("production-detail-pane")?.addEventListener("input", (e) => {
    const itemId = appState.selectedProductionItemId;
    if (!itemId) return;
    if (e.target.id === "prod-input-deadline") setItemDraftField(itemId, "deadline", e.target.value);
    if (e.target.id === "prod-input-result-url") setItemDraftField(itemId, "resultUrl", e.target.value);
    if (e.target.id === "prod-input-notes") setItemDraftField(itemId, "notes", e.target.value);
    if (e.target.id === "prod-input-brief") setItemDraftField(itemId, "briefMarkdown", e.target.value);
  });

  document.getElementById("production-detail-pane")?.addEventListener("change", (e) => {
    const itemId = appState.selectedProductionItemId;
    if (!itemId) return;
    if (e.target.id === "prod-input-assignee") {
      const selOpt = e.target.selectedOptions[0];
      setItemDraftField(itemId, "assigneeId", e.target.value || null);
      setItemDraftField(itemId, "ownerLabel", selOpt?.dataset?.ownerLabel || "");
    }
    if (e.target.id === "prod-brief-revision-select" && e.target.value) {
      const baseItem = (appState.swipeItems || []).find((i) => i.id === itemId);
      const rev = (baseItem?.briefRevisions || []).find((r) => String(r.id) === e.target.value);
      if (rev) {
        setItemDraftField(itemId, "briefMarkdown", rev.briefMarkdown);
        renderProductionDetailPane();
        showToast(`Đã nạp nội dung Brief từ Rev #${rev.revisionNumber}. Nhấn Lưu để áp dụng.`);
      }
    }
  });

  // Drawer Close & Tabs
  document.getElementById("btn-close-drawer")?.addEventListener("click", closeChannelDrawer);
  document.getElementById("channel-drawer-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "channel-drawer-backdrop") closeChannelDrawer();
  });

  document.querySelectorAll("[data-drawer-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.drawerActiveTab = btn.dataset.drawerTab;
      renderChannelDrawer();
    });
  });

  // Admin Sub-tabs & Forms
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.adminActiveTab = btn.dataset.adminTab;
      loadAdminData();
    });
  });

  document.getElementById("form-create-user")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!e.target.checkValidity()) return;
    try {
      const res = await apiFetch("/api/v1/users", {
        method: "POST",
        body: {
          username: document.getElementById("new-user-username").value.trim(),
          displayName: document.getElementById("new-user-display").value.trim(),
          role: document.getElementById("new-user-role").value,
          password: document.getElementById("new-user-password").value
        }
      });
      e.target.reset();
      showToast(`Đã tạo tài khoản @${res.user.username}.`, "success");
      await loadAdminData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("btn-save-schedule")?.addEventListener("click", async () => {
    try {
      await apiFetch("/api/v1/crawler/schedule", {
        method: "POST",
        body: {
          autoScheduleEnabled: document.getElementById("admin-schedule-enabled").checked,
          intervalMinutes: Number(document.getElementById("admin-schedule-interval").value || 30)
        }
      });
      showToast("Đã cập nhật lịch quét định kỳ.", "success");
      await loadSystemMeta();
      await loadAdminData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("btn-trigger-batch-crawl")?.addEventListener("click", async () => {
    try {
      showToast("Đang chạy phiên quét mẫu đa thị trường...");
      await apiFetch("/api/v1/crawler/run", {
        method: "POST",
        body: { countries: ["US", "GB"], keywordsPerCountry: 1, maxChannelsPerKeyword: 4 }
      });
      showToast("Đã hoàn tất phiên quét.", "success");
      await loadSystemMeta();
      await loadAdminData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("btn-cancel-crawl")?.addEventListener("click", async () => {
    try {
      await apiFetch("/api/v1/crawler/cancel", { method: "POST", body: {} });
      showToast("Đã gửi yêu cầu dừng phiên quét.");
      await loadAdminData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("btn-reveal-personal-token")?.addEventListener("click", () => {
    appState.personalTokenRevealed = !appState.personalTokenRevealed;
    const inp = document.getElementById("personal-api-token-input");
    if (inp) {
      inp.value = appState.personalTokenRevealed
        ? appState.personalTokenPlain
        : appState.currentUser?.apiTokenPreview || "••••••••";
    }
  });

  document.getElementById("btn-copy-personal-token")?.addEventListener("click", async () => {
    if (appState.personalTokenPlain && navigator.clipboard) {
      await navigator.clipboard.writeText(appState.personalTokenPlain);
      showToast("Đã sao chép API Token cá nhân.", "success");
    }
  });

  document.getElementById("btn-rotate-personal-token")?.addEventListener("click", async () => {
    try {
      const res = await apiFetch("/api/v1/auth/token/rotate", { method: "POST", body: {} });
      appState.personalTokenPlain = res.apiToken;
      appState.personalTokenRevealed = true;
      const inp = document.getElementById("personal-api-token-input");
      if (inp) inp.value = res.apiToken;
      showToast("Đã xoay vòng API Token cá nhân mới.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("form-admin-settings")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const minOutlierSampleSize = Math.max(
        3,
        Number(document.getElementById("setting-min-sample").value || 3)
      );
      const includeDemo = document.getElementById("setting-include-demo").checked;
      const youtubeApiKey = document.getElementById("setting-yt-key").value;
      const geminiApiKey = document.getElementById("setting-gemini-key").value;

      await apiFetch("/api/v1/settings", {
        method: "POST",
        body: {
          minOutlierSampleSize,
          includeDemo,
          youtubeApiKey,
          geminiApiKey
        }
      });
      document.getElementById("setting-yt-key").value = "";
      document.getElementById("setting-gemini-key").value = "";
      showToast("Đã lưu cấu hình và tính toán lại toàn bộ chỉ số Outlier (T07).", "success");
      await loadSystemMeta();
      await loadAdminData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Global Delegated Click Handler for Dynamic Rows & Actions
  document.addEventListener("click", async (e) => {
    // Close filter popover when clicking outside
    const pop = document.getElementById("discover-filter-popover");
    if (
      pop?.classList.contains("open") &&
      !e.target.closest("#discover-filter-popover") &&
      !e.target.closest("#btn-toggle-filter-popover")
    ) {
      pop.classList.remove("open");
    }

    // Open Channel Drawer
    const openChRow = e.target.closest("[data-open-channel]");
    if (openChRow) {
      openChannelDrawer(openChRow.dataset.openChannel);
      return;
    }

    // Toggle Watchlist from Discover
    const toggleWlBtn = e.target.closest("[data-toggle-watchlist]");
    if (toggleWlBtn) {
      const channelId = toggleWlBtn.dataset.toggleWatchlist;
      try {
        const res = await apiFetch("/api/v1/tracker/toggle", {
          method: "POST",
          body: { channelId }
        });
        showToast(res.isTracked ? "Đã thêm kênh vào Watchlist." : "Đã gỡ kênh khỏi Watchlist.", "success");
        await loadSystemMeta();
        await loadDiscoverData();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Save Channel as Idea
    const saveChBtn = e.target.closest("[data-save-channel-idea]");
    if (saveChBtn) {
      const channelId = saveChBtn.dataset.saveChannelIdea;
      const ch = (appState.discoverChannelsData.channels || []).find((c) => c.id === channelId);
      if (!ch) return;
      try {
        await apiFetch("/api/v1/swipe", {
          method: "POST",
          body: {
            channelId: ch.id,
            title: `Nghiên cứu kênh: ${ch.title}`,
            channelTitle: ch.title,
            channelHandle: ch.handle,
            canonicalUrl: ch.canonicalUrl,
            outlierRatio: ch.topOutlierRatio,
            views: ch.avgViews,
            estimatedRpm: ch.estimatedRpm,
            notes: `Lưu từ bảng Khám phá Kênh (n=${ch.observedVideoSampleCount} video).`
          }
        });
        showToast(`Đã lưu "${ch.title}" vào mục Ý tưởng (Cần duyệt).`, "success");
        await loadSystemMeta();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Save Video as Idea
    const saveVidBtn = e.target.closest("[data-save-video-idea]");
    if (saveVidBtn) {
      const videoId = saveVidBtn.dataset.saveVideoIdea;
      const v = (appState.discoverVideosData.outliers || []).find((x) => x.videoId === videoId);
      if (!v) return;
      try {
        await apiFetch("/api/v1/swipe", {
          method: "POST",
          body: {
            videoId: v.videoId,
            channelId: v.channelId,
            title: v.title,
            channelTitle: v.channelTitle,
            channelHandle: v.channelHandle,
            canonicalUrl: v.canonicalUrl,
            thumbnailUrl: v.thumbnailUrl,
            outlierRatio: v.outlierRatio,
            views: v.views,
            estimatedRpm: v.estimatedRpm,
            notes: `Video Outlier ${v.outlierRatio ? `${v.outlierRatio}x` : "chưa đủ mẫu"} trên kênh ${v.channelTitle}.`
          }
        });
        showToast(`Đã lưu video vào mục Ý tưởng (Cần duyệt).`, "success");
        await loadSystemMeta();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Watchlist Save Note & Remove
    const saveWlNoteBtn = e.target.closest("[data-save-watchlist-note]");
    if (saveWlNoteBtn) {
      const channelId = saveWlNoteBtn.dataset.saveWatchlistNote;
      const inp = document.querySelector(`[data-watchlist-note-input="${CSS.escape(channelId)}"]`);
      try {
        await apiFetch(`/api/v1/channels/${encodeURIComponent(channelId)}/watchlist`, {
          method: "PUT",
          body: { isTracked: true, note: inp ? inp.value : "" }
        });
        showToast("Đã cập nhật ghi chú Watchlist.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const rmWlBtn = e.target.closest("[data-remove-watchlist]");
    if (rmWlBtn) {
      const channelId = rmWlBtn.dataset.removeWatchlist;
      try {
        await apiFetch(`/api/v1/channels/${encodeURIComponent(channelId)}/watchlist`, {
          method: "PUT",
          body: { isTracked: false }
        });
        showToast("Đã bỏ theo dõi kênh.");
        await loadSystemMeta();
        await loadWatchlistData();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Drawer Actions
    if (e.target.id === "btn-drawer-watchlist" && appState.drawerChannelDetail?.channel) {
      const c = appState.drawerChannelDetail.channel;
      try {
        const res = await apiFetch(`/api/v1/channels/${encodeURIComponent(c.id)}/watchlist`, {
          method: "PUT",
          body: { isTracked: !c.isTracked }
        });
        appState.drawerChannelDetail.channel.isTracked = res.isTracked;
        renderChannelDrawer();
        await loadSystemMeta();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    if (e.target.id === "btn-save-drawer-note" && appState.drawerChannelDetail?.channel) {
      const c = appState.drawerChannelDetail.channel;
      const note = document.getElementById("drawer-watchlist-note-input")?.value || "";
      try {
        const res = await apiFetch(`/api/v1/channels/${encodeURIComponent(c.id)}/watchlist`, {
          method: "PUT",
          body: { isTracked: true, note }
        });
        appState.drawerChannelDetail.channel.isTracked = true;
        appState.drawerChannelDetail.channel.notes = res.notes;
        renderChannelDrawer();
        showToast("Đã lưu ghi chú kênh vào Watchlist.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const drawerVfBtn = e.target.closest("[data-drawer-vf]");
    if (drawerVfBtn) {
      appState.drawerVideoFormatFilter = drawerVfBtn.dataset.drawerVf;
      renderChannelDrawer();
      return;
    }

    const trBtn = e.target.closest("[data-drawer-transcript]");
    if (trBtn) {
      const videoId = trBtn.dataset.drawerTranscript;
      try {
        const tr = await apiFetch(`/api/v1/videos/${encodeURIComponent(videoId)}/transcript?limit=40`);
        const html = tr.available
          ? `<strong>Phụ đề gốc (${escapeHtml(tr.language || "auto")}):</strong><div style="margin-top:4px;max-height:140px;overflow-y:auto;">${escapeHtml(tr.fullText || "")}</div>`
          : `<span class="badge badge-warning">Không có phụ đề công khai (${escapeHtml(tr.reason)})</span> — Hệ thống không tự bịa transcript.`;
        appState.drawerVideoExtraById.set(videoId, { type: "transcript", html });
        renderChannelDrawer();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const outBtn = e.target.closest("[data-drawer-outline]");
    if (outBtn) {
      const videoId = outBtn.dataset.drawerOutline;
      try {
        const out = await apiFetch(`/api/v1/videos/${encodeURIComponent(videoId)}/outline`, {
          method: "POST",
          body: {}
        });
        const html = `<strong>Dàn ý gợi ý từ tiêu đề (KHÔNG phải phụ đề gốc):</strong><ul style="margin:4px 0 0 16px;padding:0;">${(out.sections || [])
          .map((s) => `<li><strong>${escapeHtml(s.phase)} (${escapeHtml(s.timeWindow)}):</strong> ${escapeHtml(s.directive)}</li>`)
          .join("")}</ul>`;
        appState.drawerVideoExtraById.set(videoId, { type: "outline", html });
        renderChannelDrawer();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const drSaveVid = e.target.closest("[data-drawer-save-video]");
    if (drSaveVid && appState.drawerChannelDetail?.channel) {
      const c = appState.drawerChannelDetail.channel;
      const v = (c.videos || []).find((x) => x.videoId === drSaveVid.dataset.drawerSaveVideo);
      if (v) {
        try {
          await apiFetch("/api/v1/swipe", {
            method: "POST",
            body: {
              videoId: v.videoId,
              channelId: c.id,
              title: v.title,
              channelTitle: c.title,
              channelHandle: c.handle,
              canonicalUrl: v.canonicalUrl,
              thumbnailUrl: v.thumbnailUrl,
              outlierRatio: v.outlierRatio,
              views: v.views,
              estimatedRpm: c.estimatedRpm
            }
          });
          showToast("Đã lưu video vào kho Ý tưởng.", "success");
          await loadSystemMeta();
        } catch (err) {
          showToast(err.message, "error");
        }
      }
      return;
    }

    // Ideas View Actions: Approve, Create Brief, Open in Production, Delete
    const approveBtn = e.target.closest("[data-approve-idea]");
    if (approveBtn) {
      const id = approveBtn.dataset.approveIdea;
      try {
        await apiFetch(`/api/v1/swipe/${encodeURIComponent(id)}/transition`, {
          method: "POST",
          body: { toStage: "approved" }
        });
        showToast("Đã duyệt ý tưởng (Chuyển sang 2. Đã duyệt).", "success");
        await loadSystemMeta();
        await loadSwipeAndRenderIdeas();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const createBriefBtn = e.target.closest("[data-create-brief-idea]");
    if (createBriefBtn) {
      const id = createBriefBtn.dataset.createBriefIdea;
      try {
        await apiFetch(`/api/v1/swipe/${encodeURIComponent(id)}/generate-brief`, {
          method: "POST",
          body: {}
        });
        await apiFetch(`/api/v1/swipe/${encodeURIComponent(id)}/transition`, {
          method: "POST",
          body: { toStage: "briefing" }
        });
        appState.selectedProductionItemId = id;
        showToast("Đã khởi tạo Brief mẫu và chuyển sang mục Sản xuất.", "success");
        await loadSystemMeta();
        navigateTo("production");
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const openProdBtn = e.target.closest("[data-open-in-production]");
    if (openProdBtn) {
      appState.selectedProductionItemId = openProdBtn.dataset.openInProduction;
      navigateTo("production");
      return;
    }

    const delSwipeBtn = e.target.closest("[data-delete-swipe]");
    if (delSwipeBtn) {
      const id = delSwipeBtn.dataset.deleteSwipe;
      try {
        await apiFetch(`/api/v1/swipe/${encodeURIComponent(id)}`, { method: "DELETE" });
        showToast("Đã xóa mục khỏi kho Ý tưởng.");
        await loadSystemMeta();
        await loadSwipeAndRenderIdeas();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Production Item Selection & Stage Transition
    const selProdRow = e.target.closest("[data-select-prod-item]");
    if (selProdRow) {
      appState.selectedProductionItemId = selProdRow.dataset.selectProdItem;
      renderProductionView();
      return;
    }

    const selKanbanCard = e.target.closest("[data-kanban-select]");
    if (selKanbanCard) {
      appState.selectedProductionItemId = selKanbanCard.dataset.kanbanSelect;
      appState.productionLayout = "split";
      document.querySelectorAll("[data-prod-layout]").forEach((b) =>
        b.classList.toggle("active", b.dataset.prodLayout === "split")
      );
      renderProductionView();
      return;
    }

    const transBtn = e.target.closest("[data-transition-stage]");
    if (transBtn && appState.selectedProductionItemId) {
      const id = appState.selectedProductionItemId;
      const toStage = transBtn.dataset.transitionStage;
      const baseItem = (appState.swipeItems || []).find((i) => i.id === id);
      const eff = getEffectiveItemState(baseItem);
      try {
        const res = await apiFetch(`/api/v1/swipe/${encodeURIComponent(id)}/transition`, {
          method: "POST",
          body: {
            toStage,
            resultUrl: eff.resultUrl,
            expectedRevision: eff.baseRevision
          }
        });
        clearItemDraft(id);
        const idx = appState.swipeItems.findIndex((i) => i.id === id);
        if (idx !== -1) appState.swipeItems[idx] = res.item;
        renderProductionView();
        await loadSystemMeta();
        showToast(`Đã chuyển trạng thái sang ${STAGE_LABELS[toStage]}.`, "success");
      } catch (err) {
        if (err.status === 409 && err.payload?.serverItem) {
          appState.conflictByItemId.set(id, err.payload.serverItem);
          renderProductionDetailPane();
        }
        showToast(err.message, "error");
      }
      return;
    }

    // Production Generate Brief button (with overwrite protection T08)
    if (e.target.id === "btn-prod-generate-brief" && appState.selectedProductionItemId) {
      const id = appState.selectedProductionItemId;
      const baseItem = (appState.swipeItems || []).find((i) => i.id === id);
      const needsConfirm = baseItem?.briefStatus === "user_edited" && baseItem?.briefMarkdown;
      if (needsConfirm) {
        const ok = window.confirm(
          "Brief này đã được biên tập thủ công. Tạo lại Brief mẫu sẽ lưu bản hiện tại vào lịch sử phiên bản và ghi đè bằng khung mẫu mới. Tiếp tục?"
        );
        if (!ok) return;
      }
      try {
        const res = await apiFetch(`/api/v1/swipe/${encodeURIComponent(id)}/generate-brief`, {
          method: "POST",
          body: { overwrite: true }
        });
        clearItemDraft(id);
        const idx = appState.swipeItems.findIndex((i) => i.id === id);
        if (idx !== -1) appState.swipeItems[idx] = res.item;
        renderProductionDetailPane();
        showToast("Đã tạo Brief mẫu (Bản trước đó được lưu trong lịch sử phiên bản).", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Conflict Resolution Buttons (T08)
    if (e.target.id === "btn-conflict-accept-server" && appState.selectedProductionItemId) {
      const id = appState.selectedProductionItemId;
      const serverItem = appState.conflictByItemId.get(id);
      if (serverItem) {
        const idx = appState.swipeItems.findIndex((i) => i.id === id);
        if (idx !== -1) appState.swipeItems[idx] = serverItem;
      }
      clearItemDraft(id);
      renderProductionView();
      showToast("Đã nạp phiên bản mới nhất từ máy chủ.");
      return;
    }

    if (e.target.id === "btn-conflict-force-overwrite") {
      await saveCurrentProductionItem(true);
      return;
    }

    // Integrated Title Audit in Production
    if (e.target.id === "btn-run-prod-title-audit" && appState.selectedProductionItemId) {
      const id = appState.selectedProductionItemId;
      const title = document.getElementById("prod-audit-title")?.value || "";
      try {
        const audit = await apiFetch("/api/v1/thumbnail-lab/audit", {
          method: "POST",
          body: { title }
        });
        appState.titleAuditByItemId.set(id, audit);
        renderProductionDetailPane();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    // Admin User Actions (Rotate token, Reset Password, Lock/Unlock)
    const rotBtn = e.target.closest("[data-admin-rotate-token]");
    if (rotBtn) {
      const userId = rotBtn.dataset.adminRotateToken;
      try {
        const res = await apiFetch("/api/v1/auth/token/rotate", {
          method: "POST",
          body: { userId }
        });
        showToast(`Đã xoay vòng API Token mới (${res.apiTokenPreview}).`, "success");
        await loadAdminData();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const pwBtn = e.target.closest("[data-admin-reset-pw]");
    if (pwBtn) {
      const userId = pwBtn.dataset.adminResetPw;
      const newPassword = window.prompt("Nhập mật khẩu mới (tối thiểu 6 ký tự) — sẽ thu hồi mọi phiên đang đăng nhập của tài khoản này:");
      if (!newPassword) return;
      try {
        await apiFetch(`/api/v1/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: { password: newPassword }
        });
        showToast("Đã đặt lại mật khẩu và thu hồi toàn bộ phiên cũ (T01).", "success");
        await loadAdminData();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }

    const actBtn = e.target.closest("[data-admin-toggle-active]");
    if (actBtn) {
      const userId = actBtn.dataset.adminToggleActive;
      const currentlyActive = actBtn.dataset.currentActive === "1";
      try {
        await apiFetch(`/api/v1/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: { isActive: !currentlyActive }
        });
        showToast(!currentlyActive ? "Đã mở khóa tài khoản." : "Đã khóa tài khoản và thu hồi mọi phiên.", "success");
        await loadAdminData();
      } catch (err) {
        showToast(err.message, "error");
      }
      return;
    }
  });

  // Simulator input inside Drawer
  document.addEventListener("input", (e) => {
    if (e.target.id === "drawer-sim-views" && appState.drawerChannelDetail?.channel) {
      updateDrawerSimulatorOutput(appState.drawerChannelDetail.channel.estimatedRpm || 4);
    }
  });
}

async function bootstrapApp() {
  initAccessibleFormValidation();
  bindEvents();
  try {
    await loadSystemMeta();
    handleHashChange();
  } catch (err) {
    if (err.status === 401) {
      openAuthModal();
    }
  }
}

document.addEventListener("DOMContentLoaded", bootstrapApp);
