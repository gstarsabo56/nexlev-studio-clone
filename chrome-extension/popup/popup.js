document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get([
    "savedCount",
    "overlayEnabled",
    "apiBaseUrl",
    "apiToken"
  ]);

  const countEl = document.getElementById("saved-count");
  if (countEl) countEl.textContent = String(data.savedCount || 0);

  const toggleEl = document.getElementById("toggle-overlay");
  const statusPill = document.getElementById("status-pill");
  if (toggleEl) {
    toggleEl.checked = data.overlayEnabled !== false;
    statusPill.textContent = toggleEl.checked ? "Active" : "Paused";
    toggleEl.addEventListener("change", async () => {
      await chrome.storage.local.set({ overlayEnabled: toggleEl.checked });
      statusPill.textContent = toggleEl.checked ? "Active" : "Paused";
    });
  }

  const baseInput = document.getElementById("ext-api-base");
  const tokenInput = document.getElementById("ext-api-token");
  if (baseInput) baseInput.value = data.apiBaseUrl || "http://127.0.0.1:3088";
  if (tokenInput) tokenInput.value = data.apiToken || "";

  document.getElementById("btn-save-config")?.addEventListener("click", async () => {
    const apiBaseUrl = (baseInput.value || "http://127.0.0.1:3088").trim().replace(/\/+$/, "");
    const apiToken = (tokenInput.value || "").trim();
    await chrome.storage.local.set({ apiBaseUrl, apiToken });
    const msgEl = document.getElementById("config-msg");
    if (msgEl) msgEl.textContent = "✅ Đã lưu cấu hình kết nối!";
  });

  document.getElementById("btn-open-dashboard")?.addEventListener("click", async () => {
    const base = (baseInput?.value || "http://127.0.0.1:3088").trim();
    await chrome.tabs.create({ url: base });
  });
});
