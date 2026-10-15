# Nexlev Studio — Reverse-Engineered YouTube Niche Finder, Outlier Radar & Creator Toolkit

A full-stack, zero-API-quota YouTube Niche Research & Faceless Creator Intelligence suite inspired by and reverse-engineered from `nexlev.io` / `dashboard.nexlev.io`.

---

## 🏗️ Architecture & 3 Core Modules

1. **Web Dashboard & REST API (`src/server.mjs`, `public/`)**
   - **21-Filter Niche Finder**: Filter YouTube channels by Faceless status, Faceless confidence (`0..1`), AI-Assisted content, YPP Monetization status, Outlier Score tier (`0..3`), Subscriber range, Average views vs Median views, Video count, Duration (`>= 8m` mid-roll threshold), Estimated RPM, Monthly Revenue, Channel Age, Upload Frequency, Format (`documentary`, `explainer`, `tutorial`, `commentary`), Language, and **18 Global Country Markets**.
   - **Infinite Snowball Multi-Country Auto-Crawler (`src/core/crawler.mjs`)**: Uses YouTube InnerTube (`youtubei.js`) to crawl 18 countries (`US`, `GB`, `CA`, `AU`, `CH`, `DE`, `NL`, `SE`, `FR`, `IT`, `ES`, `JP`, `KR`, `TW`, `VN`, `BR`, `MX`, `IN`) with localized seed keywords (`0 API quota`). Automatically extracts new topic phrases from high-performing Outlier videos (`outlierRatio >= 3.2x`) into a persistent `snowballQueue` and tracks `crawledSeeds` so every background cycle discovers fresh channels.
   - **Viral Outliers Radar**: Identifies individual videos outperforming their channel's median views by `1.5x` to `12x+` on small/emerging channels.
   - **48h Realtime Channel Tracker**: Tracks hourly view velocity across pinned competitor channels.
   - **Thumbnail & Title Tester Lab**: Simulates the YouTube Homepage Grid (Dark Mode) with your draft thumbnail & title injected at slot #2 alongside viral competitor videos, plus an automated CTR Readiness & Curiosity Gap scorer (with optional `gemini-2.5-flash` enhancement).
   - **Swipe File**: Shared idea & script vault synced across the Web Dashboard, Chrome Extension, and MCP Server.

2. **Model Context Protocol (MCP) Server (`mcp-server/index.mjs`)**
   - JSON-RPC 2.0 stdio MCP server exposing 9 tools for Claude Code, Cursor, and Antigravity:
     - `find_youtube_niches`
     - `scan_youtube_niche_live`
     - `crawl_global_youtube_markets`
     - `analyze_youtube_channel`
     - `find_viral_outliers`
     - `extract_video_transcript`
     - `estimate_channel_rpm`
     - `audit_thumbnail_and_title`
     - `save_to_swipe_file`

3. **Chrome Extension Manifest V3 (`chrome-extension/`)**
   - Injects directly into `https://www.youtube.com/*` using `requestAnimationFrame` + `scheduler.yield()` batched DOM updates.
   - Displays **🔥 Outlier Multiplier Badges**, **💎 Estimated RPM & Revenue**, a **YouTube Homepage Outlier Filter Bar**, an in-page **Thumbnail & Title Tester**, and a 1-click **Save to Swipe File** button.

---

## 🧮 Reverse-Engineered Core Formulas (`src/core/engine.mjs`)

- **Outlier Score**:
  $$\text{Outlier Ratio} = \frac{\text{Video Views}}{\text{Channel Median Views}}$$
  Quantized into Nexlev's 4 tiers: `0` (`<1.5x`), `1` (`1.5x–3.0x` Above Avg), `2` (`3.0x–5.0x` Strong Outlier), `3` (`>=5.0x` Exceptional Outlier).
- **Multi-Variable RPM Estimation**:
  $$\text{Estimated RPM} = \text{BaseNicheCPM} \times \text{GeoTierWeight} \times \text{CountryMarketMultiplier} \times \text{DurationMidrollFactor} \times 0.55$$
- **Atomic & Cached Persistence**:
  `loadDb()` uses an `mtimeMs`-invalidated in-memory cache for `0ms` read latency, while `saveDb()` writes atomically via `.tmp` + `fs.renameSync` to prevent corruption across concurrent Server and MCP processes.

---

## 🚀 Quick Start

```bash
npm install
npm start
# Dashboard runs at http://localhost:3088
```
