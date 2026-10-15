# Nexlev Internal Team Studio (`v2.0` — Honest Provenance & SQLite WAL Edition)

Hệ thống nội bộ phục vụ đội ngũ nghiên cứu ngách YouTube (Niche Finder), phát hiện video bứt phá (Viral Outliers), quản lý danh sách theo dõi chung (Shared Watchlist) và điều phối quy trình sản xuất 6 bước (**Phát hiện → Duyệt → Brief → Giao việc → Đã đăng → Đánh giá**) dùng chung giữa **Web Dashboard**, **Antigravity MCP Server** và **Chrome Extension**.

---

## 🎯 Triết lý Dữ liệu Trung thực (Honest Provenance)

1. **Thiếu dữ liệu là `null` / `unknown` (Có nêu lý do)**:
   - Không bao giờ tự sinh số `subscribers`, `videoCount`, `channelAgeMonths`, `likes`, `comments` hoặc tỷ lệ tăng trưởng từ vài video tìm kiếm.
   - Không suy diễn trạng thái bật kiếm tiền YPP chỉ từ `subscribers >= 1000`.
   - Không gán quốc gia/ngôn ngữ từ khóa tìm kiếm (`discoveryMarket`) làm quốc gia kênh (`channelCountry`) hoặc phân bổ khán giả (`audienceGeography`).
   - Không sinh biểu đồ 48h bằng hàm `Math.sin`. Tăng trưởng chỉ được tính từ bảng lịch sử `metric_snapshots` thực tế.
2. **Mọi chỉ số đều có trạng thái nguồn gốc (`status`)**:
   - `observed`: Quan sát trực tiếp từ YouTube (InnerTube hoặc YouTube Data API v3).
   - `derived`: Tính toán toán học từ mẫu quan sát đủ điều kiện (ví dụ: `outlierRatio`, `medianViews` khi `sampleSize >= 3`).
   - `estimated`: Kịch bản ước lượng/heuristic có nêu rõ giả định (ví dụ: `estimatedRpm`, `facelessLabel`).
   - `unknown` / `insufficient_data`: Chưa có dữ liệu nguồn hoặc mẫu video `< 3`.
   - `legacy_unverified`: Dữ liệu lịch sử chuyển từ bản JSON cũ sang SQLite, đã loại bỏ các trường suy diễn giả và gắn nhãn cảnh báo chờ làm giàu lại.
   - `demo`: Dữ liệu mẫu chỉ hiển thị khi bật công tắc **Include Demo**; mặc định bị loại khỏi mọi kết quả nghiên cứu.

---

## 🏗️ Kiến trúc Hệ thống

- **Centralized SQLite WAL (`data/nexlev.sqlite`)**: Sử dụng module tích hợp `node:sqlite` (`DatabaseSync`) của Node.js `>=22.5 / 24.x` ở chế độ `WAL` + `busy_timeout = 5000` + giao dịch `BEGIN IMMEDIATE`. Cho phép Web Server, Background Crawler, Chrome Extension và MCP Server đọc/ghi đồng thời mà không bao giờ bị mất cập nhật (lost updates).
- **Xác thực Nội bộ & Phân quyền (`manager` / `member`)**:
  - Hỗ trợ đăng nhập theo tài khoản nhân viên (`users`, `user_sessions`) và `api_token` riêng cho từng thành viên.
  - Quyền `manager`: Cấu hình API Key, lịch chạy Crawler toàn cục, quản lý nhân sự.
  - Quyền `member`: Nghiên cứu kênh/video, thêm Watchlist, lưu ý tưởng vào Swipe Library, tạo Production Brief, cập nhật tiến độ công việc được giao.
- **Quy trình Sản xuất 6 Bước (Shared Team Workflow)**:
  1. `discovered` (**1. Phát hiện**)
  2. `approved` (**2. Duyệt**)
  3. `briefing` (**3. Brief**)
  4. `assigned` (**4. Giao việc**)
  5. `published` (**5. Đã đăng**)
  6. `review` (**6. Đánh giá**)
  - Mỗi công việc có đầy đủ: **Người phụ trách (`ownerLabel` / `assigneeId`)**, **Deadline (`deadline`)**, **Ghi chú (`notes`)**, **Link kết quả (`resultUrl`)**, và **Production Brief Markdown**.

---

## 🚀 Cài đặt & Khởi chạy Nhanh (macOS Apple Silicon)

### 1. Yêu cầu môi trường
- **Node.js `>= 22.5.0`** (Khuyến nghị **Node.js `24.x`** đã có sẵn `node:sqlite` và `node:test`).
- Kiểm tra phiên bản Node:
  ```bash
  node -v
  ```
  *(Nếu máy cài Node 24 qua Homebrew tại `/opt/homebrew/opt/node@24/bin`, thêm vào `PATH`: `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).*

### 2. Cài đặt dependencies & Chạy Test
```bash
npm install
npm test
```

### 3. Khởi động Web Server & REST API
```bash
npm start
```
- Mặc định server chỉ lắng nghe trên loopback `http://127.0.0.1:3088` để đảm bảo an toàn.
- Tài khoản nội bộ mặc định (có thể đổi qua biến môi trường `NEXLEV_ADMIN_PASSWORD`, `NEXLEV_MEMBER_PASSWORD`):
  - **Quản lý (`manager`)**: `admin` / `nexlev-admin-2026`
  - **Nhân viên 1 (`member`)**: `member1` / `nexlev-member-2026`
  - **Nhân viên 2 (`member`)**: `member2` / `nexlev-member-2026`

---

## 📚 Tài liệu Kỹ thuật Chi tiết

- [Mô hình Dữ liệu & Schema SQLite (`docs/DATA_MODEL.md`)](docs/DATA_MODEL.md)
- [Công thức Chỉ số & Giới hạn Trung thực (`docs/METRICS_AND_LIMITATIONS.md`)](docs/METRICS_AND_LIMITATIONS.md)
- [Di trú Dữ liệu, Sao lưu & Phục hồi (`docs/MIGRATION_AND_BACKUP.md`)](docs/MIGRATION_AND_BACKUP.md)
- [Cài đặt Antigravity MCP & Chrome Extension (`docs/ANTIGRAVITY_MCP_SETUP.md`)](docs/ANTIGRAVITY_MCP_SETUP.md)
- [Báo cáo Kiểm chứng & Đối chiếu Audit (`docs/VERIFICATION_REPORT.md`)](docs/VERIFICATION_REPORT.md)
- [Lộ trình Mở rộng Nội bộ (`docs/ROADMAP.md`)](docs/ROADMAP.md)
