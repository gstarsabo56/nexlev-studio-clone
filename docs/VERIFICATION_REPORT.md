# Báo cáo Kiểm chứng & Đối chiếu Audit (`VERIFICATION_REPORT.md`)

Báo cáo này đối chiếu toàn bộ các vấn đề được phát hiện tại commit `926bda77adc247667ac4ebb188f00115b009fd88` cùng yêu cầu phạm vi nội bộ công ty, và ghi nhận kết quả kiểm thử tự động (`npm test`).

---

## 1. Bảng Đối chiếu Khắc phục Lỗi (Audit Resolution Matrix)

| Khu vực | Vấn đề trong bản cũ (`926bda7`) | Giải pháp đã triển khai (`v2.0`) | Trạng thái |
| :--- | :--- | :--- | :--- |
| **`src/core/engine.mjs`** | `deriveChannelStatsFromVideos` tự bịa `subscribers`, `videoCount=26`, `channelAgeMonths=5.5`, `growth` từ vài video; đầu vào `[]` vẫn sinh chỉ số. | Trả về `null` và `status: "unknown"` cho mọi chỉ số cấp kênh khi không có nguồn cấp kênh. Đầu vào `[]` trả về toàn bộ `null`. | ✅ Đã sửa & Có Test (#3) |
| **`src/core/metrics.mjs`** | Kênh 1 video tính outlier bằng hàm băm tên kênh (`hash(channel.title)`); đổi tên kênh làm đổi outlier. | Áp dụng `minOutlierSampleSize = 3` cùng định dạng trên cùng kênh. Kênh `< 3` video trả về `outlierRatio = null, outlierStatus = "insufficient_data"`. Không dùng hash tên kênh. | ✅ Đã sửa & Có Test (#4) |
| **`src/core/metrics.mjs`** | Faceless confidence dùng số cố định (`0.94` / `0.55`); chuỗi rỗng vẫn thành faceless. | Chuỗi rỗng trả về `isFaceless: null, facelessStatus: "unknown"`. Khi khớp từ khóa chỉ gắn nhãn heuristic (`likely_faceless` / `likely_on_camera`) + danh sách tín hiệu khớp. | ✅ Đã sửa & Có Test (#5) |
| **`src/core/engine.mjs`** | Transcript thất bại trả về outline tổng hợp giả làm transcript; Thumbnail audit cộng `+4` điểm cho mọi URL ảnh. | `getVideoTranscriptLive` trả về `status: "unavailable"` khi thiếu phụ đề. Tách riêng hàm `generateVideoProductionOutline`. `auditThumbnailAndTitle` gắn `imageAnalysisStatus: "not_analyzed"` và không cộng điểm cho URL ảnh. | ✅ Đã sửa & Có Test (#9, #10) |
| **`src/core/sqlite-repo.mjs`** | Ghi file JSON đơn lẻ gây mất dữ liệu khi Web Server, Crawler và MCP ghi đồng thời. | Chuyển sang SQLite (`node:sqlite` `DatabaseSync`) chế độ `WAL` + `busy_timeout = 5000` + giao dịch `BEGIN IMMEDIATE`. | ✅ Đã sửa & Có Test (#6) |
| **`src/core/parsers.mjs`** | Đọc `"1B"` thành 100 triệu; sai dấu thập phân đa ngôn ngữ; ngày đăng FR/PT/NL bị gán thành `12` ngày. | Viết lại `parseCountTextStrict` (`"1B"` = $10^9$, `"억"` = $10^8$, hỗ trợ 11 ngôn ngữ) và `parsePublishedTextStrict` (hỗ trợ FR/PT/NL/DE/ES/IT/JA/KO/ZH/VI, trả `null`/`unknown` khi không khớp, không bao giờ gán `12` ngày). | ✅ Đã sửa & Có Test (#1, #2) |
| **`src/core/crawler.mjs`** | Gán quốc gia tìm kiếm làm quốc gia kênh; ghi đè làm mất video cũ khi quét lại; lặp lại seed đầu; seed lỗi vẫn đánh dấu đã quét; gửi `disable` kèm `interval` làm bật lại lịch chạy. | Tách `discovery_country` khỏi `channel_country` (`unknown` nếu chưa xác minh). Quét lại gộp (`UPSERT`) video mới vào video cũ. Chọn seed chưa quét trước rồi xoay vòng theo `last_success_at ASC`. Seed lỗi giữ `last_success_at = NULL`. Lưu lịch vào SQLite và tôn trọng `autoScheduleEnabled: false`. | ✅ Đã sửa & Có Test (#6, #7, #8) |
| **`src/server.mjs` & `public/app.js`** | CORS wildcard; không giới hạn loopback; lỗi XSS qua `innerHTML`; JSON lỗi vẫn trả 200; `/api/*` không tồn tại trả HTML 200; gửi form rỗng xóa mất API key. | Mặc định bind `127.0.0.1`; CORS allowlist; đăng nhập nội bộ & phân quyền `manager`/`member`; bọc `escapeHtml` & `safeHttpUrl`; JSON lỗi trả `400`; `/api/*` lạ trả `404 JSON`; tách `.secrets.local.json` với cơ chế `'keep' | 'replace' | 'clear'`. | ✅ Đã sửa & Có Test (#11, #12, #13, #15) |
| **`mcp-server/index.mjs`** | Không kiểm tra `inputSchema`; gọi `analyze_youtube_channel({})` trả kênh đầu tiên; phản hồi `protocolVersion` bất kỳ. | Thương lượng `protocolVersion` chuẩn (`2024-11-05`), kiểm tra schema nghiêm ngặt, từ chối `analyze_youtube_channel({})` với `isError: true`, trả danh sách `candidates` khi trùng tên. | ✅ Đã sửa & Có Test (#14) |
| **`chrome-extension/`** | Tính outlier bằng median các video trên trang chủ; thiếu `videoId`/`channelId`; báo đã lưu dù server lỗi. | Truy vấn `/api/v1/extension/batch-metrics` để lấy baseline thật của kênh; hiển thị `⏳ Chưa đủ dữ liệu baseline` khi `< 3` video; kiểm tra `response.ok` trước khi báo đã lưu; hỗ trợ điều hướng SPA `yt-navigate-finish`. | ✅ Đã sửa & Có Test (#15, #17) |

---

## 2. Kết quả Chạy Bộ Kiểm thử Tự động (`npm test`)

Chạy lệnh `npm test` (`node --test test/*.test.mjs`) trên Node.js `v24.20.0`:
- **Tổng số bài kiểm thử (Test Suites)**: `14 / 14 PASS` (`0 FAIL`).
- **Thời gian thực thi**: `~1.26s`.

---

## 3. Ghi chú Về Phần Đã Xác minh Offline vs Live

- **Đã xác minh đầy đủ bằng Test & Cơ sở dữ liệu thật (`data/nexlev.sqlite`)**:
  - Toàn bộ bộ phân tích cú pháp 11 ngôn ngữ, bộ tính toán Outlier, di trú 591 kênh & 999 video từ JSON sang SQLite WAL, bảo mật REST API, xác thực/phân quyền nội bộ (`manager` / `member`), quy trình sản xuất 6 bước, MCP JSON-RPC protocol và API đối chiếu của Chrome Extension.
- **Tích hợp Live phụ thuộc khóa API bên ngoài**:
  - Adapter `enrichChannelViaYouTubeDataApi` (YouTube Data API v3) và gợi ý tiêu đề qua Gemini API đã được hoàn thiện đầy đủ trong mã nguồn. Khi chưa cấu hình `youtubeApiKey` hoặc `geminiApiKey` trong `data/.secrets.local.json`, hệ thống tự động vận hành ở chế độ InnerTube & Heuristic định sẵn và ghi rõ nguồn gốc `source` / `status`.
