// Chrome Extension Background Service Worker (v2.1)
// Handles authenticated API requests (Bearer + x-nexlev-token), session-backed TTL caching,
// and strict HTTP status checking before reporting saved status.

const DEFAULT_API_BASE = "http://127.0.0.1:3088";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const fallbackMemoryCache = new Map();

export async function getExtensionConfig(storageImpl = globalThis.chrome?.storage?.local) {
  if (!storageImpl) {
    return {
      apiBaseUrl: DEFAULT_API_BASE,
      apiToken: "",
      overlayEnabled: true,
      savedCount: 0
    };
  }
  const data = await storageImpl.get([
    "apiBaseUrl",
    "apiToken",
    "overlayEnabled",
    "savedCount"
  ]);
  return {
    apiBaseUrl: (data.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, ""),
    apiToken: data.apiToken || "",
    overlayEnabled: data.overlayEnabled !== false,
    savedCount: Number(data.savedCount || 0)
  };
}

function buildAuthHeaders(apiToken = "") {
  const headers = { "Content-Type": "application/json" };
  if (apiToken && String(apiToken).trim()) {
    const clean = String(apiToken).trim();
    headers.Authorization = `Bearer ${clean}`;
    headers["x-nexlev-token"] = clean;
  }
  return headers;
}

/**
 * Handles SAVE_SWIPE_ITEM and strictly verifies resp.ok before reporting success!
 */
export async function handleSaveSwipeMessage(
  payload = {},
  {
    fetchImpl = globalThis.fetch,
    storageImpl = globalThis.chrome?.storage?.local,
    actionImpl = globalThis.chrome?.action
  } = {}
) {
  const cfg = await getExtensionConfig(storageImpl);
  try {
    const resp = await fetchImpl(`${cfg.apiBaseUrl}/api/v1/swipe`, {
      method: "POST",
      headers: buildAuthHeaders(cfg.apiToken),
      body: JSON.stringify({
        ...payload,
        source: "chrome_extension"
      })
    });

    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }

    // CRITICAL: Never report ok: true if HTTP status is 4xx or 5xx!
    if (!resp.ok || !data?.ok) {
      return {
        ok: false,
        status: resp.status,
        error: data?.error || `Backend trả lỗi HTTP ${resp.status}`
      };
    }

    const nextCount = cfg.savedCount + 1;
    if (storageImpl) {
      await storageImpl.set({ savedCount: nextCount });
    }
    if (actionImpl) {
      await actionImpl.setBadgeText({ text: String(nextCount) });
      await actionImpl.setBadgeBackgroundColor({ color: "#3CCB7F" });
    }

    return {
      ok: true,
      status: resp.status,
      item: data.item
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.message || "Không kết nối được tới Nexlev Server local"
    };
  }
}

export async function handleBatchMetricsLookup(
  { videoIds = [], channelIds = [], handles = [] } = {},
  {
    fetchImpl = globalThis.fetch,
    storageImpl = globalThis.chrome?.storage?.local
  } = {}
) {
  const now = Date.now();
  const uncachedVideos = [];
  const cachedVideosResult = {};

  for (const vid of videoIds) {
    const hit = fallbackMemoryCache.get(`v:${vid}`);
    if (hit && now - hit.ts < CACHE_TTL_MS) {
      cachedVideosResult[vid] = hit.val;
    } else {
      uncachedVideos.push(vid);
    }
  }

  if (uncachedVideos.length === 0 && channelIds.length === 0 && handles.length === 0) {
    return { ok: true, videos: cachedVideosResult, channels: {} };
  }

  const cfg = await getExtensionConfig(storageImpl);
  try {
    const resp = await fetchImpl(`${cfg.apiBaseUrl}/api/v1/extension/batch-metrics`, {
      method: "POST",
      headers: buildAuthHeaders(cfg.apiToken),
      body: JSON.stringify({
        videoIds: uncachedVideos,
        channelIds,
        handles
      })
    });

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        videos: cachedVideosResult,
        channels: {}
      };
    }

    const data = await resp.json();
    const freshVideos = data?.videos || {};
    for (const [vid, val] of Object.entries(freshVideos)) {
      fallbackMemoryCache.set(`v:${vid}`, { ts: now, val });
      cachedVideosResult[vid] = val;
    }

    return {
      ok: true,
      videos: cachedVideosResult,
      channels: data?.channels || {}
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Network error",
      videos: cachedVideosResult,
      channels: {}
    };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(async () => {
    const existing = await chrome.storage.local.get([
      "overlayEnabled",
      "apiBaseUrl",
      "savedCount"
    ]);
    await chrome.storage.local.set({
      overlayEnabled: typeof existing.overlayEnabled === "boolean" ? existing.overlayEnabled : true,
      apiBaseUrl: existing.apiBaseUrl || DEFAULT_API_BASE,
      savedCount: Number(existing.savedCount || 0)
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === "SAVE_SWIPE_ITEM") {
        const res = await handleSaveSwipeMessage(message.payload || {});
        sendResponse(res);
        return;
      }
      if (message?.type === "FETCH_BATCH_METRICS") {
        const res = await handleBatchMetricsLookup(message.payload || {});
        sendResponse(res);
        return;
      }
      sendResponse({ ok: false, error: "Unknown message type" });
    })();
    return true;
  });
}
