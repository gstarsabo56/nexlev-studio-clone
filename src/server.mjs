import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDb,
  saveDb,
  filterChannels,
  getViralOutlierVideos,
  scanYouTubeNicheLive,
  getVideoTranscriptLive,
  auditThumbnailAndTitle,
  estimateChannelRpmAndRevenue,
  classifyFacelessAndNiche
} from "./core/engine.mjs";
import { NICHE_CPM_TABLE } from "./core/seed-data.mjs";
import {
  GLOBAL_COUNTRIES,
  crawlerState,
  crawlMultiCountryBatch,
  startBackgroundAutoCrawler
} from "./core/crawler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 3088);

// Start periodic background multi-country crawler every 15 minutes by default
startBackgroundAutoCrawler(15);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, x-device-id, x-user-id, x-request-id, x-app-version, x-app-name"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const urlObj = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams.entries());

  try {
    // 1. Summary & Niches Metadata
    if (pathname === "/api/v1/meta" && req.method === "GET") {
      const db = loadDb();
      const countryCounts = {};
      for (const c of db.channels) {
        const code = c.country || "US";
        countryCounts[code] = (countryCounts[code] || 0) + 1;
      }
      return sendJson(res, 200, {
        totalChannels: db.channels.length,
        totalOutliers: getViralOutlierVideos({ maxDaysAgo: 365 }).length,
        trackedCount: (db.trackedChannelIds || []).length,
        swipeCount: (db.swipeItems || []).length,
        niches: Object.entries(NICHE_CPM_TABLE).map(([name, meta]) => ({
          name,
          ...meta
        })),
        countries: GLOBAL_COUNTRIES.map((c) => ({
          ...c,
          channelCount: countryCounts[c.code] || 0
        })),
        crawlerState,
        filterTemplates: db.filterTemplates || [],
        trendingKeywords: db.searchHistory || [],
        hasYoutubeApiKey: Boolean(db.settings?.youtubeApiKey),
        hasGeminiApiKey: Boolean(db.settings?.geminiApiKey)
      });
    }

    // 1b. Global Multi-Country Auto-Crawler Endpoints
    if (pathname === "/api/v1/crawler/status" && req.method === "GET") {
      const db = loadDb();
      return sendJson(res, 200, {
        crawlerState,
        countries: GLOBAL_COUNTRIES,
        totalChannelsInDb: db.channels.length
      });
    }

    if (pathname === "/api/v1/crawler/run" && req.method === "POST") {
      const body = await readJsonBody(req);
      const countries = Array.isArray(body.countries) && body.countries.length
        ? body.countries
        : body.country && body.country !== "ALL"
          ? [body.country]
          : ["ALL"];
      const summary = await crawlMultiCountryBatch({
        countries,
        keywordsPerCountry: Number(body.keywordsPerCountry || 2),
        maxChannelsPerKeyword: Number(body.maxChannelsPerKeyword || 5),
        customKeyword: String(body.customKeyword || "").trim()
      });
      return sendJson(res, 200, { ok: true, summary, crawlerState });
    }

    if (pathname === "/api/v1/crawler/schedule" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.autoScheduleEnabled === "boolean") {
        crawlerState.autoScheduleEnabled = body.autoScheduleEnabled;
      }
      if (Number(body.intervalMinutes) > 0) {
        startBackgroundAutoCrawler(Number(body.intervalMinutes));
      }
      return sendJson(res, 200, { ok: true, crawlerState });
    }

    // 2. 21-Filter Niche Finder
    if (pathname === "/api/v1/channels" && req.method === "GET") {
      const results = filterChannels(query);
      return sendJson(res, 200, {
        count: results.length,
        channels: results
      });
    }

    // 3. Live YouTube InnerTube Niche Scanner (Zero Quota, optional country)
    if (pathname === "/api/v1/niche/scan-live" && req.method === "POST") {
      const body = await readJsonBody(req);
      const keyword = String(body.keyword || query.keyword || "faceless documentary").trim();
      const country = String(body.country || "ALL").trim();
      const limit = Number(body.limit || 10);

      if (country && country !== "US") {
        const summary = await crawlMultiCountryBatch({
          countries: country === "ALL" ? ["US", "GB", "DE", "JP", "KR", "VN", "ES"] : [country],
          keywordsPerCountry: 1,
          maxChannelsPerKeyword: limit,
          customKeyword: keyword
        });
        return sendJson(res, 200, {
          source: "youtube-innertube-multi-country",
          keyword,
          discoveredCount: (summary.newChannelsCount || 0) + (summary.updatedChannelsCount || 0),
          summary
        });
      }

      const scanRes = await scanYouTubeNicheLive(keyword, limit);
      return sendJson(res, 200, scanRes);
    }

    // 4. Channel Deep-Dive Analytics + Similar Channels
    if (pathname.startsWith("/api/v1/channels/") && req.method === "GET") {
      const channelId = decodeURIComponent(pathname.replace("/api/v1/channels/", ""));
      const db = loadDb();
      const ch = db.channels.find(
        (c) =>
          c.id === channelId ||
          c.handle.toLowerCase() === channelId.toLowerCase()
      );
      if (!ch) {
        return sendJson(res, 404, { error: "Channel not found" });
      }
      const similarChannels = db.channels
        .filter((other) => other.id !== ch.id && (other.niche === ch.niche || other.format === ch.format))
        .slice(0, 4);

      return sendJson(res, 200, {
        channel: ch,
        similarChannels,
        shortVsLongSplit:
          ch.contentType === "shorts"
            ? { shortsShare: 0.92, longFormShare: 0.08 }
            : { shortsShare: 0.14, longFormShare: 0.86 }
      });
    }

    // 5. Viral Outliers on Small Channels Radar
    if (pathname === "/api/v1/outliers" && req.method === "GET") {
      const outliers = getViralOutlierVideos(query);
      return sendJson(res, 200, {
        count: outliers.length,
        outliers
      });
    }

    // 6. 48-Hour Realtime Channel Tracker
    if (pathname === "/api/v1/tracker" && req.method === "GET") {
      const db = loadDb();
      const trackedSet = new Set(db.trackedChannelIds || []);
      const trackedChannels = db.channels.filter((c) => trackedSet.has(c.id));
      return sendJson(res, 200, {
        count: trackedChannels.length,
        channels: trackedChannels
      });
    }

    if (pathname === "/api/v1/tracker/toggle" && req.method === "POST") {
      const body = await readJsonBody(req);
      const channelId = body.channelId;
      const db = loadDb();
      db.trackedChannelIds = db.trackedChannelIds || [];
      const idx = db.trackedChannelIds.indexOf(channelId);
      let tracked = false;
      if (idx >= 0) {
        db.trackedChannelIds.splice(idx, 1);
      } else {
        db.trackedChannelIds.unshift(channelId);
        tracked = true;
      }
      saveDb(db);
      return sendJson(res, 200, { ok: true, channelId, tracked, trackedChannelIds: db.trackedChannelIds });
    }

    // 7. Swipe File API
    if (pathname === "/api/v1/swipe" && req.method === "GET") {
      const db = loadDb();
      const folderId = query.folderId || "all";
      const items =
        folderId === "all"
          ? db.swipeItems || []
          : (db.swipeItems || []).filter((i) => i.folderId === folderId);
      return sendJson(res, 200, {
        folders: db.swipeFolders || [],
        items
      });
    }

    if (pathname === "/api/v1/swipe" && req.method === "POST") {
      const body = await readJsonBody(req);
      const db = loadDb();
      const newItem = {
        id: `swipe-${Date.now()}`,
        folderId: body.folderId || "folder-outliers",
        type: body.type || "video",
        title: body.title || "Untitled YouTube Idea",
        channelTitle: body.channelTitle || "YouTube Channel",
        channelHandle: body.channelHandle || "@creator",
        thumbnailUrl:
          body.thumbnailUrl ||
          "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg",
        outlierRatio: Number(body.outlierRatio || 3.5),
        views: Number(body.views || 100000),
        estimatedRpm: Number(body.estimatedRpm || 9.5),
        tags: Array.isArray(body.tags)
          ? body.tags
          : String(body.tags || "Outlier, Faceless")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
        notes: body.notes || "",
        savedAt: new Date().toISOString()
      };
      db.swipeItems = [newItem, ...(db.swipeItems || [])];
      saveDb(db);
      return sendJson(res, 201, { ok: true, item: newItem });
    }

    if (pathname.startsWith("/api/v1/swipe/") && req.method === "DELETE") {
      const id = decodeURIComponent(pathname.replace("/api/v1/swipe/", ""));
      const db = loadDb();
      db.swipeItems = (db.swipeItems || []).filter((i) => i.id !== id);
      saveDb(db);
      return sendJson(res, 200, { ok: true, deletedId: id });
    }

    // 8. Video Transcript Extractor (InnerTube 0 Quota)
    if (pathname.startsWith("/api/v1/videos/") && pathname.endsWith("/transcript") && req.method === "GET") {
      const videoId = decodeURIComponent(
        pathname.replace("/api/v1/videos/", "").replace("/transcript", "")
      );
      const transcript = await getVideoTranscriptLive(videoId);
      return sendJson(res, 200, transcript);
    }

    // 9. Thumbnail & Title Tester + AI Audit
    if (pathname === "/api/v1/thumbnail-lab/audit" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await auditThumbnailAndTitle(body);
      return sendJson(res, 200, result);
    }

    // 10. Settings & Optional API Keys
    if (pathname === "/api/v1/settings" && req.method === "GET") {
      const db = loadDb();
      return sendJson(res, 200, {
        youtubeApiKeyMasked: db.settings?.youtubeApiKey
          ? `${db.settings.youtubeApiKey.slice(0, 6)}...${db.settings.youtubeApiKey.slice(-4)}`
          : "",
        geminiApiKeyMasked: db.settings?.geminiApiKey
          ? `${db.settings.geminiApiKey.slice(0, 6)}...${db.settings.geminiApiKey.slice(-4)}`
          : "",
        hasYoutubeApiKey: Boolean(db.settings?.youtubeApiKey),
        hasGeminiApiKey: Boolean(db.settings?.geminiApiKey),
        defaultCurrency: db.settings?.defaultCurrency || "USD",
        autoTrackOutliers: db.settings?.autoTrackOutliers !== false
      });
    }

    if (pathname === "/api/v1/settings" && req.method === "POST") {
      const body = await readJsonBody(req);
      const db = loadDb();
      db.settings = {
        ...db.settings,
        ...(typeof body.youtubeApiKey === "string" ? { youtubeApiKey: body.youtubeApiKey.trim() } : {}),
        ...(typeof body.geminiApiKey === "string" ? { geminiApiKey: body.geminiApiKey.trim() } : {}),
        ...(body.defaultCurrency ? { defaultCurrency: body.defaultCurrency } : {})
      };
      saveDb(db);
      return sendJson(res, 200, {
        ok: true,
        hasYoutubeApiKey: Boolean(db.settings.youtubeApiKey),
        hasGeminiApiKey: Boolean(db.settings.geminiApiKey)
      });
    }

    // NEXLEV PUBLIC API COMPATIBLE MIRROR
    if (pathname === "/api/external/channels/outliers" && req.method === "GET") {
      const outliers = getViralOutlierVideos({
        minOutlierRatio: Number(query.outlierScore || 1) * 1.5
      });
      return sendJson(res, 200, { data: outliers });
    }

    if (pathname === "/api/external/videos/rpm" && req.method === "GET") {
      const cls = classifyFacelessAndNiche(query.title || query.niche || "");
      const rpm = estimateChannelRpmAndRevenue({
        niche: cls.niche,
        avgDurationMinutes: Number(query.durationMinutes || 15),
        monthlyViews: Number(query.views || 250000)
      });
      return sendJson(res, 200, { data: { ...cls, ...rpm } });
    }

    // Serve static frontend files
    let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: "Forbidden" });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    const indexHtml = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(indexHtml).pipe(res);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Nexlev Clone Server running at http://localhost:${PORT}`);
});
