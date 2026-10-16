# Hướng dẫn Tích hợp vào Hệ thống / Công cụ Khác (`v2.1.0`)

Tài liệu này dành cho kỹ sư hoặc AI Agent (Claude, Codex, Antigravity) khi cần nhúng hoặc kết nối **Nexlev Internal Team Studio (`v2.1.0`)** vào một pipeline nội bộ khác (ví dụ: hệ thống tự động tạo kịch bản video, dựng video, quản lý kênh hoặc dashboard tổng hợp).

---

## 1. Ba Phương thức Tích hợp

Hệ thống hỗ trợ 3 giao thức tích hợp song song cùng dùng chung một cơ sở dữ liệu **SQLite WAL** (`data/nexlev.sqlite`):

| Phương thức | Khi nào nên dùng | Điểm vào (Entrypoint) |
| :--- | :--- | :--- |
| **A. Import trực tiếp ESM Module** | Công cụ đích viết bằng Node.js (`>= 22.5 / 24.x`) chạy cùng máy local | `src/core/engine.mjs`, `src/core/crawler.mjs`, `src/core/sqlite-repo.mjs` |
| **B. Gọi qua REST API (`/api/v1/*`)** | Công cụ đích viết bằng Python, Go, Rust, n8n, Make, hoặc Web App khác | `http://127.0.0.1:3088/api/v1/*` kèm header `X-API-Token` |
| **C. Kết nối qua MCP Server (stdio)** | Tích hợp vào Claude Code, Claude Desktop, Cursor, Antigravity | `node mcp-server/index.mjs` (JSON-RPC `2024-11-05`) |

---

## 2. Phương thức A: Import trực tiếp Node.js ESM Modules

Package đã khai báo `exports` trong `package.json`. Bạn có thể import trực tiếp các hàm nghiệp vụ mà không cần qua HTTP:

```js
import {
  queryChannels,
  queryOutlierVideos,
  getChannelDetail,
  getChannelGrowthTracking,
  extractVideoTranscript,
  generateVideoProductionOutline,
  auditThumbnailAndTitle,
  getSwipeData,
  createSwipeItem,
  updateSwipeItem,
  transitionSwipeItem,
  generateSwipeProductionBrief,
  bulkImportTargets,
  exportShortlist
} from "./src/core/engine.mjs";

import {
  scanYoutubeNicheLive,
  crawlGlobalMarketsBatch
} from "./src/core/crawler.mjs";
```

### Biến môi trường cấu hình đường dẫn dữ liệu
- `NEXLEV_SQLITE_PATH`: Đường dẫn file SQLite (mặc định: `./data/nexlev.sqlite`). Vì dùng `WAL` + `busy_timeout = 5000` + `BEGIN IMMEDIATE`, nhiều tiến trình Node.js có thể cùng đọc/ghi vào một file SQLite này một cách an toàn.
- `NEXLEV_SECRETS_PATH`: Đường dẫn file lưu `youtubeApiKey` và `geminiApiKey` (mặc định: `./data/.secrets.local.json`).

---

## 3. Phương thức B: Tích hợp qua HTTP REST API (`/api/v1/*`)

### 3.1. Xác thực (Authentication)
Mọi request tới `/api/v1/*` (trừ `/api/v1/health` và `/api/v1/auth/login`) bắt buộc gửi kèm một trong hai header:
- `X-API-Token: <api_token_của_user>` *(Khuyến nghị cho tích hợp máy-máy / tool-to-tool)*
- `Authorization: Bearer <sessionToken_hoặc_apiToken>`

Để lấy `api_token` lần đầu:
```bash
curl -s -X POST http://127.0.0.1:3088/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"nexlev-admin-2026"}'
```
Sau đó gọi `GET /api/v1/auth/token` với `sessionToken` vừa nhận để lấy `apiToken` cố định của tài khoản.

### 3.2. Các Endpoint Chính dành cho Tool Bên ngoài

| Method & Path | Mô tả |
| :--- | :--- |
| `GET /api/v1/health` | Kiểm tra trạng thái server & SQLite WAL (`200 OK`, không cần auth). |
| `GET /api/v1/channels` | Truy vấn danh sách kênh có phân trang & bộ lọc (`query`, `niche`, `format`, `isFaceless`, `minSubscribers`, `minOutlierRatio`, `dataOrigin`, `trackedOnly`, `sortBy`, `page`, `limit`). |
| `GET /api/v1/channels/:id` | Chi tiết kênh, danh sách video, phân tách Shorts/Long, lịch sử tăng trưởng cohort (`growthTracking`) và chỉ số nguồn gốc (`provenance`). |
| `PUT /api/v1/channels/:id/watchlist` | Đặt trạng thái theo dõi kênh (`{ "tracked": true, "note": "..." }`). |
| `GET /api/v1/outliers` | Truy vấn video bứt phá (`query`, `niche`, `contentType`, `minOutlierRatio`, `maxPublishedDaysAgo`, `dataOrigin`, `page`, `limit`). |
| `GET /api/v1/videos/:id/transcript` | Trích xuất phụ đề thực tế từ YouTube (`status: 'observed'`) hoặc trả về `available: false, status: 'unavailable'` kèm lý do rõ ràng. |
| `POST /api/v1/videos/:id/outline` | Sinh khung kịch bản giữ chân (Production Outline) từ metadata video (`status: 'derived'`). |
| `POST /api/v1/audit-thumbnail` | Chấm điểm cấu trúc tiêu đề (`Title Readiness Score`) và gợi ý 3 biến thể tiêu đề. |
| `POST /api/v1/crawler/scan-live` | Quét trực tiếp một ngách/từ khóa trên thị trường chỉ định (`{ "keyword": "...", "countryCode": "US", "maxChannels": 8 }`). |
| `POST /api/v1/import/bulk` | Nhập hàng loạt `@handle`, `UC...` hoặc URL YouTube vào hàng đợi `import_targets` (`{ "lines": [...] }`). |
| `GET /api/v1/swipe` | Lấy danh sách ý tưởng & công việc trong quy trình 6 bước (`stage`, `folderId`, `assignee`). |
| `POST /api/v1/swipe` | Lưu video/kênh vào hộp chờ Ý tưởng (`discovered`). |
| `PUT /api/v1/swipe/:id` | Cập nhật nội dung công việc/Brief (hỗ trợ `expectedRevision` chống ghi đè `409 REVISION_CONFLICT`). |
| `POST /api/v1/swipe/:id/transition` | Chuyển bước quy trình (`discovered` → `approved` → `briefing` → `assigned` → `published` → `review`) có kiểm tra RBAC. |
| `POST /api/v1/swipe/:id/generate-brief` | Sinh bản nháp Production Brief (`template_draft`), bảo vệ bản sửa tay trừ khi truyền `{ "overwrite": true }`. |

---

## 4. Phương thức C: Tích hợp qua MCP Server (`mcp-server/index.mjs`)

Cấu hình trong `mcp_config.json` hoặc `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nexlev-studio": {
      "command": "node",
      "args": [
        "/duong/dan/tuyet/doi/nexlev-clone/mcp-server/index.mjs"
      ],
      "env": {
        "NEXLEV_SQLITE_PATH": "/duong/dan/tuyet/doi/nexlev-clone/data/nexlev.sqlite"
      }
    }
  }
}
```

### Danh sách 9 MCP Tools hỗ trợ sẵn:
1. `find_youtube_niches`: Lọc ngách và kênh theo tiêu chí nghiên cứu.
2. `scan_youtube_niche_live`: Quét dữ liệu thật từ YouTube theo từ khóa & quốc gia.
3. `analyze_youtube_channel`: Phân tích sâu 1 kênh cụ thể (`channelId` hoặc `handle`).
4. `find_viral_outliers`: Tìm các video có `outlierRatio` cao vượt baseline kênh.
5. `extract_video_transcript`: Lấy transcript thật (hỗ trợ phân trang `offset`/`limit`) hoặc tạo `includeOutline`.
6. `estimate_channel_rpm`: Mô phỏng kịch bản doanh thu & RPM có nêu giả định rõ ràng.
7. `audit_thumbnail_and_title`: Đánh giá tiêu đề và tạo 3 phương án thay thế.
8. `save_to_swipe_file`: Đẩy ý tưởng trực tiếp vào quy trình sản xuất 6 bước của team.
9. `crawl_global_youtube_markets`: Kích hoạt quét đa thị trường (18 quốc gia).
