#!/opt/homebrew/opt/node@24/bin/node
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
} from "../src/core/engine.mjs";
import { crawlMultiCountryBatch } from "../src/core/crawler.mjs";

const SERVER_INFO = {
  name: "nexlev-studio-mcp",
  version: "1.1.0"
};

const TOOLS = [
  {
    name: "find_youtube_niches",
    description:
      "Search and filter YouTube channels using Nexlev's 21 criteria (Faceless, confidence, RPM, Outlier Score 0-3, subscribers, channel age, format, contentType).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword, channel title, or topic" },
        niche: { type: "string", description: "Niche category or 'all'" },
        format: {
          type: "string",
          enum: ["all", "documentary", "explainer", "tutorial", "commentary"]
        },
        isFaceless: { type: "string", enum: ["all", "true", "false"] },
        minOutlierScore: {
          type: "number",
          description: "0=All, 1=>=1.5x, 2=>=3x, 3=>=5x Exceptional Outlier"
        },
        maxSubscribers: {
          type: "number",
          description: "Max subscribers to find small channels blowing up (e.g. 50000)"
        },
        maxAgeMonths: {
          type: "number",
          description: "Max channel age in months (e.g. 6 for new channels)"
        },
        minRpm: { type: "number", description: "Minimum estimated RPM in USD" },
        sortBy: {
          type: "string",
          enum: ["outlier", "revenue", "rpm", "viewSubRatio", "growth", "newest"]
        }
      }
    }
  },
  {
    name: "scan_youtube_niche_live",
    description:
      "Crawl YouTube in real time via InnerTube (0 API quota required) for a niche keyword, calculate Outlier Score, Faceless confidence, and RPM, and save discovered channels to the database.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "YouTube niche keyword to scan live (e.g. 'boring history for sleep', '3d crime documentary')"
        },
        limit: {
          type: "number",
          description: "Max channels to discover (default 8)"
        }
      },
      required: ["keyword"]
    }
  },
  {
    name: "analyze_youtube_channel",
    description:
      "Get deep-dive Nexlev analytics for a channel by ID or @handle, including Geography Revenue breakdown, Faceless score, Monetization signals, and Outlier videos.",
    inputSchema: {
      type: "object",
      properties: {
        channelIdOrHandle: {
          type: "string",
          description: "Channel ID (UC...) or handle (@...)"
        }
      },
      required: ["channelIdOrHandle"]
    }
  },
  {
    name: "find_viral_outliers",
    description:
      "Discover viral outlier videos (3x to 12x+ channel median views) on small or medium YouTube channels within the last 30/60/90 days.",
    inputSchema: {
      type: "object",
      properties: {
        maxDaysAgo: { type: "number", description: "Time window in days (30, 60, 90, 365)" },
        maxChannelSubscribers: {
          type: "number",
          description: "Filter for small channels under N subscribers (e.g. 50000)"
        },
        minOutlierRatio: {
          type: "number",
          description: "Minimum outlier multiplier (e.g. 3.0)"
        }
      }
    }
  },
  {
    name: "extract_video_transcript",
    description:
      "Extract the transcript / captions or script structure of a YouTube video by videoId using InnerTube (0 API quota).",
    inputSchema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube Video ID (11 characters)" }
      },
      required: ["videoId"]
    }
  },
  {
    name: "estimate_channel_rpm",
    description:
      "Estimate RPM and monthly revenue range for a YouTube niche based on geography Tier-1 share, video duration (mid-roll ads >=8m), and monthly views.",
    inputSchema: {
      type: "object",
      properties: {
        topicOrNiche: { type: "string", description: "Topic or niche description" },
        avgDurationMinutes: { type: "number", description: "Average video length in minutes" },
        monthlyViews: { type: "number", description: "Expected monthly views" }
      },
      required: ["topicOrNiche"]
    }
  },
  {
    name: "audit_thumbnail_and_title",
    description:
      "Score a YouTube video title & thumbnail concept for CTR readiness, curiosity gap, and outlier potential.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Draft YouTube video title" },
        niche: { type: "string", description: "Target niche category" },
        thumbnailUrl: { type: "string", description: "Optional thumbnail image URL" }
      },
      required: ["title"]
    }
  },
  {
    name: "save_to_swipe_file",
    description:
      "Save a high-performing YouTube channel, viral outlier video, or script idea into the Nexlev Studio Swipe File.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        channelTitle: { type: "string" },
        channelHandle: { type: "string" },
        outlierRatio: { type: "number" },
        estimatedRpm: { type: "number" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["title"]
    }
  },
  {
    name: "crawl_global_youtube_markets",
    description:
      "Batch crawl YouTube across multiple countries (US, GB, CA, AU, DE, FR, ES, JP, KR, VN, BR, IN or ALL) with localized niche keywords and country-adjusted RPM.",
    inputSchema: {
      type: "object",
      properties: {
        countries: {
          type: "array",
          items: { type: "string" },
          description: "Country codes e.g. ['US','GB','DE','JP','KR','VN','ES'] or ['ALL']"
        },
        customKeyword: {
          type: "string",
          description: "Optional custom keyword to search across selected countries"
        }
      }
    }
  }
];

async function executeTool(name, args = {}) {
  switch (name) {
    case "crawl_global_youtube_markets": {
      return await crawlMultiCountryBatch({
        countries: args.countries || ["ALL"],
        customKeyword: args.customKeyword || "",
        keywordsPerCountry: 2,
        maxChannelsPerKeyword: 5
      });
    }
    case "find_youtube_niches": {
      const channels = filterChannels(args);
      return {
        count: channels.length,
        channels: channels.slice(0, 15)
      };
    }
    case "scan_youtube_niche_live": {
      return await scanYouTubeNicheLive(args.keyword, args.limit || 8);
    }
    case "analyze_youtube_channel": {
      const db = loadDb();
      const q = String(args.channelIdOrHandle || "").toLowerCase();
      const ch = db.channels.find(
        (c) =>
          c.id.toLowerCase() === q ||
          c.handle.toLowerCase() === q ||
          c.title.toLowerCase().includes(q)
      );
      if (!ch) {
        return { error: `Channel "${args.channelIdOrHandle}" not found in local index. Run scan_youtube_niche_live first.` };
      }
      return ch;
    }
    case "find_viral_outliers": {
      const outliers = getViralOutlierVideos(args);
      return {
        count: outliers.length,
        outliers: outliers.slice(0, 15)
      };
    }
    case "extract_video_transcript": {
      return await getVideoTranscriptLive(args.videoId);
    }
    case "estimate_channel_rpm": {
      const cls = classifyFacelessAndNiche(args.topicOrNiche || "");
      const rpm = estimateChannelRpmAndRevenue({
        niche: cls.niche,
        avgDurationMinutes: Number(args.avgDurationMinutes || 16),
        monthlyViews: Number(args.monthlyViews || 500000)
      });
      return { ...cls, ...rpm };
    }
    case "audit_thumbnail_and_title": {
      return await auditThumbnailAndTitle(args);
    }
    case "save_to_swipe_file": {
      const db = loadDb();
      const item = {
        id: `swipe-${Date.now()}`,
        folderId: "folder-outliers",
        type: "video",
        title: args.title,
        channelTitle: args.channelTitle || "YouTube Creator",
        channelHandle: args.channelHandle || "@creator",
        thumbnailUrl: "https://i.ytimg.com/vi/RlnD7RwfzbE/hqdefault.jpg",
        outlierRatio: Number(args.outlierRatio || 5.0),
        views: 250000,
        estimatedRpm: Number(args.estimatedRpm || 10.0),
        tags: args.tags || ["MCP Saved", "Outlier"],
        notes: args.notes || "",
        savedAt: new Date().toISOString()
      };
      db.swipeItems = [item, ...(db.swipeItems || [])];
      saveDb(db);
      return { saved: true, item };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id, code, message) {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
  process.stdout.write(msg + "\n");
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      return sendResponse(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: SERVER_INFO
      });
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      return sendResponse(id, {});
    }

    if (method === "tools/list") {
      return sendResponse(id, { tools: TOOLS });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const data = await executeTool(toolName, toolArgs);
      return sendResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ]
      });
    }

    if (id !== undefined) {
      return sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) {
      return sendError(id, -32000, err?.message || "MCP execution error");
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line || line.startsWith("Content-Length:")) continue;
    try {
      const parsed = JSON.parse(line);
      handleRpcMessage(parsed);
    } catch {
      // ignore partial non-JSON lines
    }
  }
});
