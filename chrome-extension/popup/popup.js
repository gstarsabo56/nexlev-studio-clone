document.addEventListener("DOMContentLoaded", async () => {
  const { savedCount = 0 } = await chrome.storage.local.get("savedCount");
  const countEl = document.getElementById("saved-count");
  if (countEl) countEl.textContent = String(savedCount);

  const openBtn = document.getElementById("btn-open-dashboard");
  if (openBtn) {
    openBtn.addEventListener("click", async () => {
      await chrome.tabs.create({ url: "http://localhost:3088" });
    });
  }
});
