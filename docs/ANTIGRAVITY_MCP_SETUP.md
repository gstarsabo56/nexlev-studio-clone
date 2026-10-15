# Hướng dẫn Cài đặt Antigravity MCP & Chrome Extension (`ANTIGRAVITY_MCP_SETUP.md`)

Hệ thống Nexlev Internal Studio kết nối trực tiếp cả **Google Antigravity (qua MCP)** và **Chrome Extension** vào cùng cơ sở dữ liệu SQLite WAL (`data/nexlev.sqlite`).

---

## 1. Cấu hình MCP Server cho Google Antigravity

MCP Server nằm tại `mcp-server/index.mjs` và sử dụng `#!/usr/bin/env node` (không khóa cứng đường dẫn máy cá nhân).

### 1.1. Cấu hình trong `mcp_config.json` của Antigravity
Thêm đoạn cấu hình sau vào file cấu hình MCP của bạn:

```json
{
  "mcpServers": {
    "nexlev-studio": {
      "command": "node",
      "args": [
        "/Users/loveminsu/Library/Mobile Documents/com~apple~CloudDocs/Antigrivity/nexlev-clone/mcp-server/index.mjs"
      ],
      "env": {
        "PATH": "/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

### 1.2. Danh sách 8 Tools Hỗ trợ & Cơ chế Bảo vệ
1. `find_youtube_niches`: Lọc kênh theo ngách, định dạng, khoảng subscriber/views, thị trường khám phá, hỗ trợ phân trang (`page`, `limit <= 50`). Mặc định luôn loại bỏ dữ liệu `demo`.
2. `scan_youtube_niche_live`: Quét trực tiếp từ khóa trên YouTube theo mã quốc gia (18 thị trường) và lưu vào SQLite.
3. `analyze_youtube_channel`: Phân tích chi tiết 1 kênh theo `channelId` (`UC...`), `@handle` hoặc tên kênh.
   - **Bảo vệ nghiêm ngặt**: Gọi với `{}` (thiếu `channelIdOrHandle`) sẽ bị từ chối với `isError: true` (tuyệt đối không trả về kênh đầu tiên trong DB).
   - Nếu tên tìm kiếm khớp nhiều kênh, trả về danh sách `candidates` (`AMBIGUOUS_CHANNEL`) để AI chọn đúng ID.
4. `find_viral_outliers`: Tìm các video có `outlierRatio` cao đã đủ mẫu baseline (`>= 3` video cùng định dạng trên cùng kênh).
5. `extract_video_transcript`: Trích xuất phụ đề thực tế từ YouTube (có phân trang `offset`, `limit`). Nếu video không có phụ đề, trả về `isError: true, code: "TRANSCRIPT_UNAVAILABLE"` chứ không trả về outline giả làm transcript.
6. `estimate_channel_rpm`: Mô phỏng kịch bản RPM & doanh thu với đầy đủ giả định (`status: "estimated"`).
7. `audit_thumbnail_and_title`: Chấm điểm cấu trúc tiêu đề (Title Readiness) trung thực; không cộng điểm ảo cho URL ảnh khi chưa phân tích thị giác.
8. `save_to_swipe_file`: Lưu ý tưởng/video trực tiếp vào bảng `swipe_items` dùng chung với Web Dashboard theo quy trình 6 bước (`discovered` → `approved` → `briefing` → `assigned` → `published` → `review`).

---

## 2. Cài đặt Chrome Extension (Manifest V3)

1. Mở trình duyệt Google Chrome, truy cập `chrome://extensions/`.
2. Bật chế độ **Developer mode (Chế độ dành cho nhà phát triển)** ở góc trên bên phải.
3. Nhấn **Load unpacked (Tải tiện ích đã giải nén)** và chọn thư mục:
   `.../nexlev-clone/chrome-extension`
4. Mở trang chủ hoặc trang tìm kiếm YouTube (`https://www.youtube.com`):
   - Extension tự động trích xuất đúng `videoId`, `channelId` / `channelHandle`, `canonicalUrl` và `thumbnailUrl`.
   - Gửi truy vấn theo lô về `/api/v1/extension/batch-metrics` để lấy đúng chỉ số Outlier từ baseline cùng kênh trong SQLite.
   - Nếu kênh chưa đủ `< 3` video mẫu trong DB, huy hiệu trên thẻ video sẽ hiển thị trung thực: **`⏳ Chưa đủ dữ liệu baseline`** (không bao giờ lấy median của các video ngẫu nhiên trên trang chủ YouTube làm outlier của kênh).
   - Nút **⚡ Lưu Swipe** kiểm tra phản hồi `response.ok` từ server trước khi báo **`✅ Đã lưu!`**, giúp toàn bộ nhân viên thấy ngay video vừa lưu trong tab **Quy trình & Swipe** trên Web Dashboard.
