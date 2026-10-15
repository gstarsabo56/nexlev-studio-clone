const API_BASE = "http://localhost:3088";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["overlayEnabled", "minOutlierFilter"]);
  if (typeof existing.overlayEnabled !== "boolean") {
    await chrome.storage.local.set({
      overlayEnabled: true,
      minOutlierFilter: 0,
      savedCount: 0
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === "SAVE_SWIPE_ITEM") {
        const resp = await fetch(`${API_BASE}/api/v1/swipe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload || {})
        });
        const data = await resp.json();
        const { savedCount = 0 } = await chrome.storage.local.get("savedCount");
        await chrome.storage.local.set({ savedCount: savedCount + 1 });
        await chrome.action.setBadgeText({ text: String(savedCount + 1) });
        await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
        sendResponse({ ok: true, data });
        return;
      }

      if (message?.type === "ESTIMATE_VIDEO_RPM") {
        const q = new URLSearchParams({
          title: message.payload?.title || "",
          durationMinutes: String(message.payload?.durationMinutes || 14),
          views: String(message.payload?.views || 100000)
        });
        const resp = await fetch(`${API_BASE}/api/external/videos/rpm?${q.toString()}`);
        const data = await resp.json();
        sendResponse({ ok: true, data: data.data });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || "Background fetch error" });
    }
  })();
  return true;
});
