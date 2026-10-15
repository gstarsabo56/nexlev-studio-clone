#!/usr/bin/env node
// Nexlev Team Studio MCP Server (Batch 4)
// Shares the same SQLite WAL database & Core Service Layer as the Web Dashboard and Chrome Extension.
// Enforces inputSchema validation, protocol version negotiation, consistent isError responses, and pagination.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureDbMigrated,
  queryChannels,
  queryOutlierVideos,
  getChannelDetail,
  getVideoTranscriptLive,
  generateVideoProductionOutline,
  auditThumbnailAndTitle,
  estimateChannelRpmAndRevenue,
  classifyFacelessAndNiche,
  createSwipeItem,
  updateSwipeItem,
  getSwipeData,
  SWIPE_WORKFLOW_STAGES
} from "../src/core/engine.mjs";
import {
  crawlMultiCountryBatch,
  scanYouTubeNicheLive
} from "../src/core/crawler.mjs";

export const SERVER_INFO = {
  name: "nexlev-studio-mcp",
  version: "2.0.0"
};

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18"
];

export const TOOLS = [
  {
    name: "find_youtube_niches",
    description:
      "Search and filter YouTube channels in SQLite with provenance metadata (observed vs legacy_unverified, sample size, outlierStatus, discoveryMarket vs channelCountry).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword, channel title, or @handle" },
        niche: { type: "string", description: "Niche category or 'all'" },
        format: {
          type: "string",
          enum: ["all", "documentary", "explainer", "tutorial", "commentary"]
        },
        isFaceless: { type: "string", enum: ["all", "true", "false"] },
        dataOrigin: {
          type: "string",
          enum: ["all", "observed", "legacy_unverified", "demo"]
        },
        outlierSampleFilter: {
          type: "string",
          enum: ["all", "sufficient", "insufficient"]
        },
        minOutlierScore: {
          type: "number",
          minimum: 0,
          maximum: 3,
          description: "0=All, 1=>=1.5x, 2=>=3x, 3=>=5x Exceptional Outlier"
        },
        maxSubscribers: {
          type: "number",
          minimum: 0,
          description: "Max verified subscribers (channels with unknown subscribers are excluded when > 0)"
        },
        maxAgeMonths: {
          type: "number",
          minimum: 0,
          description: "Max channel age in months"
        },
        minRpm: { type: "number", minimum: 0, description: "Minimum scenario RPM in USD" },
        country: { type: "string", description: "Country/Market code e.g. US, DE, JP, VN or 'all'" },
        sortBy: {
          type: "string",
          enum: ["outlier", "revenue", "rpm", "avgViews", "subscribers", "viewSubRatio", "newest"]
        },
        page: { type: "number", minimum: 1, description: "Page number (1-indexed)" },
        limit: { type: "number", minimum: 1, maximum: 50, description: "Page size (default 15, max 50)" }
      }
    }
  },
  {
    name: "scan_youtube_niche_live",
    description:
      "Live-scan YouTube for a niche keyword in a target market, persist discovered channels/videos into SQLite, and return the crawl jobId and honest metrics.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Non-empty YouTube niche keyword to scan live"
        },
        country: {
          type: "string",
          description: "2-letter market code (default 'US')"
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 25,
          description: "Max channels to discover (default 8)"
        }
      },
      required: ["keyword"]
    }
  },
  {
    name: "analyze_youtube_channel",
    description:
      "Get deep-dive channel analytics by exact channelId (UC...) or @handle, including provenance statuses, video-level outliers, and snapshot growth tracking.",
    inputSchema: {
      type: "object",
      properties: {
        channelIdOrHandle: {
          type: "string",
          description: "Channel ID (UC...) or @handle (Required, non-empty)"
        }
      },
      required: ["channelIdOrHandle"]
    }
  },
  {
    name: "find_viral_outliers",
    description:
      "Query verified viral outlier videos (same-channel, same-format baseline with n >= minOutlierSampleSize) from SQLite with pagination.",
    inputSchema: {
      type: "object",
      properties: {
        maxDaysAgo: { type: "number", minimum: 0, description: "Max published days ago (0 = all)" },
        maxChannelSubscribers: {
          type: "number",
          minimum: 0,
          description: "Filter for channels with known subscribers <= N"
        },
        minOutlierRatio: {
          type: "number",
          minimum: 1,
          description: "Minimum outlier multiplier (default 1.5)"
        },
        includeInsufficientSample: {
          type: "boolean",
          description: "Include videos from channels with <3 sample videos (default false)"
        },
        page: { type: "number", minimum: 1 },
        limit: { type: "number", minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: "extract_video_transcript",
    description:
      "Extract real captions/transcript of a YouTube video by videoId. Returns status='unavailable' if the video has no captions (never fabricates a transcript).",
    inputSchema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube Video ID (Required)" },
        offset: { type: "number", minimum: 0, description: "Segment start offset (default 0)" },
        limit: { type: "number", minimum: 1, maximum: 500, description: "Max segments to return (default 120)" }
      },
      required: ["videoId"]
    }
  },
  {
    name: "estimate_channel_rpm",
    description:
      "Simulate RPM and revenue scenario for a niche, average duration, and optional monthly views (explicitly marked as scenario estimation).",
    inputSchema: {
      type: "object",
      properties: {
        topicOrNiche: { type: "string", description: "Topic or niche description" },
        avgDurationMinutes: { type: "number", minimum: 0, description: "Average video length in minutes" },
        monthlyViews: { type: "number", minimum: 0, description: "Optional expected monthly views" }
      },
      required: ["topicOrNiche"]
    }
  },
  {
    name: "audit_thumbnail_and_title",
    description:
      "Evaluate a YouTube title for CTR readiness heuristics (length, curiosity gap, data anchor). Does not award fake points for unanalyzed image URLs.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Draft YouTube video title" },
        niche: { type: "string", description: "Target niche category" },
        thumbnailUrl: { type: "string", description: "Optional http/https thumbnail image URL" }
      },
      required: ["title"]
    }
  },
  {
    name: "save_to_swipe_file",
    description:
      "Save or assign an idea/video/channel into the shared company Idea Library (Swipe File) with 6-stage workflow support (discovered, approved, briefing, assigned, published, review).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Idea or video title (Required)" },
        videoId: { type: "string" },
        channelId: { type: "string" },
        canonicalUrl: { type: "string" },
        channelTitle: { type: "string" },
        channelHandle: { type: "string" },
        outlierRatio: { type: "number" },
        views: { type: "number" },
        estimatedRpm: { type: "number" },
        workflowStage: {
          type: "string",
          enum: SWIPE_WORKFLOW_STAGES
        },
        ownerLabel: { type: "string", description: "Assigned team member username or name" },
        deadline: { type: "string", description: "Deadline (YYYY-MM-DD)" },
        resultUrl: { type: "string", description: "Published result video URL" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["title"]
    }
  },
  {
    name: "crawl_global_youtube_markets",
    description:
      "Run a multi-country seed discovery job and persist results into SQLite crawl_jobs and channels.",
    inputSchema: {
      type: "object",
      properties: {
        countries: {
          type: "array",
          items: { type: "string" },
          description: "Country codes e.g. ['US','GB','DE','JP','KR','VN'] or ['ALL']"
        },
        customKeyword: {
          type: "string",
          description: "Optional custom keyword to search across selected countries"
        },
        keywordsPerCountry: {
          type: "number",
          minimum: 1,
          maximum: 5
        },
        maxChannelsPerKeyword: {
          type: "number",
          minimum: 1,
          maximum: 15
        }
      }
    }
  }
];

/**
 * Validates tool arguments against the tool's JSON Schema before execution.
 */
export function validateToolArguments(schema, args) {
  if (!schema) return { valid: true };
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return {
      valid: false,
      error: "Arguments must be a JSON object.",
      remediation: "Pass an object matching the tool inputSchema."
    };
  }

  const requiredList = schema.required || [];
  for (const reqKey of requiredList) {
    const val = args[reqKey];
    if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
      return {
        valid: false,
        error: `Missing or empty required parameter: "${reqKey}".`,
        remediation: `Provide a non-empty value for "${reqKey}".`
      };
    }
  }

  const props = schema.properties || {};
  for (const [k, val] of Object.entries(args)) {
    if (val === undefined || val === null) continue;
    const propSchema = props[k];
    if (!propSchema) continue;

    if (propSchema.type === "string" && typeof val !== "string") {
      return {
        valid: false,
        error: `Parameter "${k}" must be of type string (got ${typeof val}).`,
        remediation: `Pass a string for "${k}".`
      };
    }
    if (propSchema.type === "number" && (typeof val !== "number" || !Number.isFinite(val))) {
      return {
        valid: false,
        error: `Parameter "${k}" must be a finite number (got ${typeof val}).`,
        remediation: `Pass a valid number for "${k}".`
      };
    }
    if (propSchema.type === "boolean" && typeof val !== "boolean") {
      return {
        valid: false,
        error: `Parameter "${k}" must be a boolean.`,
        remediation: `Pass true or false for "${k}".`
      };
    }
    if (propSchema.type === "array" && !Array.isArray(val)) {
      return {
        valid: false,
        error: `Parameter "${k}" must be an array.`,
        remediation: `Pass an array for "${k}".`
      };
    }
    if (propSchema.enum && !propSchema.enum.includes(val)) {
      return {
        valid: false,
        error: `Parameter "${k}" has invalid value "${val}". Allowed values: ${propSchema.enum.join(", ")}.`,
        remediation: `Use one of: ${propSchema.enum.join(", ")}.`
      };
    }
    if (typeof propSchema.minimum === "number" && val < propSchema.minimum) {
      return {
        valid: false,
        error: `Parameter "${k}" (${val}) is below minimum (${propSchema.minimum}).`,
        remediation: `Provide "${k}" >= ${propSchema.minimum}.`
      };
    }
    if (typeof propSchema.maximum === "number" && val > propSchema.maximum) {
      return {
        valid: false,
        error: `Parameter "${k}" (${val}) exceeds maximum (${propSchema.maximum}).`,
        remediation: `Provide "${k}" <= ${propSchema.maximum}.`
      };
    }
  }

  return { valid: true };
}

export async function executeTool(name, args = {}, customDb = null) {
  const toolDef = TOOLS.find((t) => t.name === name);
  if (!toolDef) {
    return {
      isError: true,
      payload: {
        error: `Unknown tool: "${name}"`,
        remediation: `Call tools/list to see available tools: ${TOOLS.map((t) => t.name).join(", ")}`
      }
    };
  }

  const validation = validateToolArguments(toolDef.inputSchema, args);
  if (!validation.valid) {
    return {
      isError: true,
      payload: {
        error: validation.error,
        code: "INVALID_ARGUMENTS",
        remediation: validation.remediation
      }
    };
  }

  const db = ensureDbMigrated(customDb);

  try {
    switch (name) {
      case "find_youtube_niches": {
        const res = queryChannels(
          {
            ...args,
            page: args.page || 1,
            limit: Math.min(50, Math.max(1, Number(args.limit || 15)))
          },
          db
        );
        // Return concise channel summaries with explicit provenance
        const conciseChannels = res.channels.map((c) => ({
          id: c.id,
          handle: c.handle,
          title: c.title,
          dataOrigin: c.dataOrigin,
          discoveryMarket: c.discoveryMarket,
          channelCountry: c.channelCountry,
          channelCountryStatus: c.channelCountryStatus,
          niche: c.niche,
          format: c.format,
          facelessLabel: c.facelessLabel,
          facelessStatus: c.facelessStatus,
          subscribers: c.subscribers,
          subscribersStatus: c.subscribersStatus,
          observedVideoSampleCount: c.observedVideoSampleCount,
          avgViews: c.avgViews,
          medianViews: c.medianViews,
          topOutlierRatio: c.topOutlierRatio,
          maxOutlierScore: c.maxOutlierScore,
          outlierStatus: c.outlierStatus,
          outlierReason: c.outlierReason,
          estimatedRpm: c.estimatedRpm,
          rpmStatus: c.rpmStatus,
          lastUpdatedAt: c.lastUpdatedAt
        }));
        return {
          isError: false,
          payload: {
            totalCount: res.totalCount,
            count: conciseChannels.length,
            page: res.page,
            limit: res.limit,
            totalPages: res.totalPages,
            hasMore: res.hasMore,
            nextCursor: res.nextCursor,
            channels: conciseChannels
          }
        };
      }

      case "scan_youtube_niche_live": {
        const res = await scanYouTubeNicheLive(
          args.keyword,
          args.limit || 8,
          { country: args.country || "US" },
          db
        );
        return {
          isError: false,
          payload: res
        };
      }

      case "analyze_youtube_channel": {
        const detail = getChannelDetail(args.channelIdOrHandle, db);
        if (detail.ambiguous) {
          return {
            isError: true,
            payload: {
              error: detail.message,
              code: "AMBIGUOUS_CHANNEL",
              candidates: detail.candidates,
              remediation: "Call analyze_youtube_channel again with one of the exact candidate 'id' values."
            }
          };
        }
        if (!detail.found) {
          return {
            isError: true,
            payload: {
              error: detail.message,
              code: "CHANNEL_NOT_FOUND",
              remediation: "Run scan_youtube_niche_live with the channel's niche keyword or check the channelId/handle."
            }
          };
        }
        return {
          isError: false,
          payload: detail
        };
      }

      case "find_viral_outliers": {
        const res = queryOutlierVideos(
          {
            ...args,
            includeInsufficientSample: args.includeInsufficientSample ? "true" : "false",
            page: args.page || 1,
            limit: Math.min(50, Math.max(1, Number(args.limit || 15)))
          },
          db
        );
        return {
          isError: false,
          payload: res
        };
      }

      case "extract_video_transcript": {
        const tr = await getVideoTranscriptLive(args.videoId, {
          offset: args.offset || 0,
          limit: args.limit || 120
        });
        if (!tr.available || tr.status === "unavailable") {
          return {
            isError: true,
            payload: {
              ...tr,
              error: tr.reason || "Transcript unavailable",
              code: "TRANSCRIPT_UNAVAILABLE",
              remediation:
                "This video does not have public captions available. Do not treat synthetic outlines as transcripts."
            }
          };
        }
        return {
          isError: false,
          payload: tr
        };
      }

      case "estimate_channel_rpm": {
        const cls = classifyFacelessAndNiche(args.topicOrNiche || "");
        const rpm = estimateChannelRpmAndRevenue({
          niche: cls.niche,
          avgDurationMinutes:
            typeof args.avgDurationMinutes === "number" ? args.avgDurationMinutes : null,
          monthlyViews: typeof args.monthlyViews === "number" ? args.monthlyViews : null
        });
        return {
          isError: false,
          payload: { ...cls, ...rpm }
        };
      }

      case "audit_thumbnail_and_title": {
        const res = await auditThumbnailAndTitle(args);
        return {
          isError: false,
          payload: res
        };
      }

      case "save_to_swipe_file": {
        const item = createSwipeItem(
          {
            title: args.title,
            videoId: args.videoId || null,
            channelId: args.channelId || null,
            canonicalUrl: args.canonicalUrl || null,
            channelTitle: args.channelTitle || "",
            channelHandle: args.channelHandle || "",
            outlierRatio: typeof args.outlierRatio === "number" ? args.outlierRatio : null,
            views: typeof args.views === "number" ? args.views : null,
            estimatedRpm: typeof args.estimatedRpm === "number" ? args.estimatedRpm : null,
            workflowStage: args.workflowStage || "discovered",
            ownerLabel: args.ownerLabel || "",
            deadline: args.deadline || "",
            resultUrl: args.resultUrl || "",
            notes: args.notes || "",
            tags: args.tags || ["MCP Saved"],
            source: "mcp",
            createdBy: "mcp-agent"
          },
          db
        );
        return {
          isError: false,
          payload: { saved: true, item }
        };
      }

      case "crawl_global_youtube_markets": {
        const summary = await crawlMultiCountryBatch(
          {
            countries: args.countries || ["ALL"],
            customKeyword: args.customKeyword || "",
            keywordsPerCountry: args.keywordsPerCountry || 2,
            maxChannelsPerKeyword: args.maxChannelsPerKeyword || 5
          },
          db
        );
        return {
          isError: summary.status === "failed",
          payload: summary
        };
      }

      default:
        return {
          isError: true,
          payload: { error: `Unhandled tool: ${name}` }
        };
    }
  } catch (err) {
    return {
      isError: true,
      payload: {
        error: err?.message || "Tool execution failed",
        code: err?.code || "EXECUTION_ERROR"
      }
    };
  }
}

export function negotiateProtocolVersion(requestedVersion) {
  if (
    typeof requestedVersion === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
  ) {
    return requestedVersion;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
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

export async function handleRpcMessage(msg, customDb = null) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      const negotiated = negotiateProtocolVersion(params?.protocolVersion);
      const res = {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: SERVER_INFO
      };
      if (id !== undefined) sendResponse(id, res);
      return res;
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "ping") {
      if (id !== undefined) sendResponse(id, {});
      return {};
    }

    if (method === "tools/list") {
      const res = { tools: TOOLS };
      if (id !== undefined) sendResponse(id, res);
      return res;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      const { isError, payload } = await executeTool(toolName, toolArgs, customDb);
      const res = {
        isError: Boolean(isError),
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2)
          }
        ]
      };
      if (id !== undefined) sendResponse(id, res);
      return res;
    }

    if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
    return null;
  } catch (err) {
    if (id !== undefined) {
      sendError(id, -32000, err?.message || "MCP execution error");
    }
    return null;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
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
}
