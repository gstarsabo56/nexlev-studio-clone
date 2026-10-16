# Nexlev Internal Team Studio (`v2.1` — Honest Provenance, SQLite WAL & High-Density Research UI)

Hệ thống nội bộ phục vụ đội ngũ nghiên cứu ngách YouTube (Niche Finder), phát hiện video bứt phá (Viral Outliers), quản lý danh sách theo dõi chung (Shared Watchlist) và điều phối quy trình sản xuất 6 bước (**Phát hiện → Duyệt → Brief → Giao việc → Đã đăng → Đánh giá**) dùng chung giữa **Web Dashboard**, **Antigravity MCP Server** và **Chrome Extension**.

---

## 🎯 Triết lý Dữ liệu Trung thực (Honest Provenance)

1. **Thiếu dữ liệu là `null` / `unknown` (Có nêu lý do)**:
   - Không bao giờ tự sinh số `subscribers`, `videoCount`, `channelAgeMonths`, `likes`, `comments` hoặc tỷ lệ tăng trưởng từ vài video tìm kiếm.
   - Không suy diễn trạng thái bật kiếm tiền YPP chỉ từ `subscribers >= 1000`.
   - Không gán quốc gia/ngôn ngữ từ khóa tìm kiếm (`discoveryMarket`) làm quốc gia kênh (`channelCountry`) hoặc phân bổ khán giả (`audienceGeography`).
   - Không sinh biểu đồ 48h bằng hàm `Math.sin`. Tăng trưởng chỉ được tính từ bảng lịch sử `metric_snapshots` thực tế trên cùng tập mẫu video giao nhau (`video_cohort_intersection`) hoặc tổng lượt xem kênh xác thực (`channel_total_views`).
2. **Mọi chỉ số đều có trạng thái nguồn gốc (`status`)**:
   - `observed`: Quan sát trực tiếp từ YouTube (InnerTube hoặc YouTube Data API v3).
   - `derived`: Tính toán toán học từ mẫu quan sát đủ điều kiện (`dataOrigin === 'observed'`, định dạng `long` hoặc `shorts` đã xác minh, `sampleSize >= minOutlierSampleSize` và tối thiểu `>= 3`).
   - `estimated`: Kịch bản ước lượng/heuristic có nêu rõ giả định (`estimatedRpm`, `facelessLabel`).
   - `insufficient_data` / `unknown`: Chưa có dữ liệu nguồn, định dạng video chưa xác định, hoặc mẫu video `< 3`.
   - `unverified_source` / `legacy_unverified`: Dữ liệu lịch sử chuyển từ bản JSON cũ sang SQLite, không bao giờ được dùng làm baseline tính `outlierRatio = derived` cho tới khi thu thập lại từ nguồn thực.
   - `template_draft` / `user_edited`: Tách bạch rõ bản nháp Brief tạo tự động từ khung mẫu và bản Brief do biên tập viên chỉnh sửa; lưu lịch sử phiên bản trong `brief_revisions`.
   - `demo`: Dữ liệu mẫu chỉ hiển thị khi bật công tắc **Include Demo**; mặc định bị loại khỏi mọi kết quả nghiên cứu.

---

## 🏗️ Kiến trúc Hệ thống & Bảo mật Nội bộ (`v2.1`)

- **Centralized SQLite WAL (`data/nexlev.sqlite`)**:
  - Sử dụng module tích hợp `node:sqlite` (`DatabaseSync`) của Node.js `>=22.5 / 24.x` ở chế độ `WAL` + `busy_timeout = 5000` + giao dịch `BEGIN IMMEDIATE`.
  - Hỗ trợ ghi đồng thời an toàn giữa Web Server, Background Crawler (có cơ chế `worker_id` + `lease_until` + `heartbeat_at`), Chrome Extension và MCP Server.
  - Hỗ trợ cấu hình đường dẫn độc lập qua `NEXLEV_SQLITE_PATH` và `NEXLEV_SECRETS_PATH` để chạy test cô lập tuyệt đối, không chạm vào dữ liệu thật.
- **Xác thực Mặc định Nghiêm ngặt & Phân quyền RBAC (`manager` / `member`)**:
  - Mọi route `/api/v1/*` (trừ `/api/v1/auth/login` và `/api/v1/health`) bắt buộc xác thực qua Bearer Session Token hoặc `X-API-Token` (`401 AUTH_REQUIRED`). Chỉ bật bypass khi môi trường phát triển đặt rõ `NEXLEV_DEV_AUTH_BYPASS=true`.
  - Đổi mật khẩu hoặc vô hiệu hóa tài khoản tự động thu hồi toàn bộ phiên đăng nhập (`user_sessions`) và xoay mới `api_token`.
  - Danh sách nhân sự chỉ trả về `apiTokenPreview` đã che; token đầy đủ chỉ hiển thị cho chính người dùng qua `/api/v1/auth/token` hoặc `/api/v1/auth/token/rotate`.
- **Kiểm soát Đồng thời Lạc quan (Optimistic Concurrency `409 REVISION_CONFLICT`)**:
  - Mọi cập nhật ý tưởng/công việc (`swipe_items`) đều kiểm tra `expectedRevision`. Nếu có thành viên khác vừa lưu phiên bản mới hơn, server trả về `409 REVISION_CONFLICT` kèm `serverItem` để người dùng đối chiếu trên giao diện mà không làm mất bản nháp đang gõ.
- **Giao diện Nghiên cứu Mật độ Cao (5 Không gian Làm việc)**:
  1. **Khám phá (`discover`)**: Chuyển đổi tức thì giữa bảng **Kênh** và **Video Outlier**, thanh công cụ lọc gọn kèm ngăn kéo **Bộ lọc nâng cao (Advanced Filters)** và cửa sổ **Thu thập & Nhập mục tiêu (`import_targets`)**.
  2. **Watchlist (`watchlist`)**: Theo dõi kênh đối thủ, ghi chú theo dõi từng kênh và đối chiếu tăng trưởng thực theo cohort.
  3. **Ý tưởng (`ideas`)**: Hộp chờ duyệt ý tưởng (`discovered` → `approved`), tích hợp công cụ **Chấm điểm Tiêu đề (Title Readiness)** và trích xuất **Transcript / Khung Kịch bản**.
  4. **Sản xuất (`production`)**: Bảng điều phối 4 giai đoạn sản xuất (`approved`, `briefing`, `assigned`, `published`, `review`) theo bố cục Bảng hoặc Kanban, trình soạn thảo Brief có bảo vệ bản nháp (`dirtyFields`), lịch sử phiên bản (`brief_revisions`) và nhật ký hoạt động (`work_activity`).
  5. **Quản trị (`admin` — Chỉ hiển thị với `manager`)**: Quản lý nhân sự, cấu hình ngưỡng mẫu Outlier tối thiểu (`>= 3`), lịch chạy Crawler và khóa API.

---

## 🚀 Cài đặt & Khởi chạy Nhanh (macOS Apple Silicon)

### 1. Yêu cầu môi trường
- **Node.js `>= 22.5.0`** (Khuyến nghị **Node.js `24.x`** đã có sẵn `node:sqlite` và `node:test`).
- Kiểm tra phiên bản Node:
  ```bash
  node -v
  ```
  *(Nếu máy cài Node 24 qua Homebrew tại `/opt/homebrew/opt/node@24/bin`, thêm vào `PATH`: `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).*

### 2. Cài đặt dependencies & Chạy bộ kiểm thử hồi quy (15 test suites)
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

- [Hướng dẫn Tích hợp vào Công cụ / Hệ thống Khác (`docs/INTEGRATION_GUIDE.md`)](docs/INTEGRATION_GUIDE.md)
- [Mô hình Dữ liệu & Schema SQLite (`docs/DATA_MODEL.md`)](docs/DATA_MODEL.md)
- [Công thức Chỉ số & Giới hạn Trung thực (`docs/METRICS_AND_LIMITATIONS.md`)](docs/METRICS_AND_LIMITATIONS.md)
- [Di trú Dữ liệu, Sao lưu & Phục hồi (`docs/MIGRATION_AND_BACKUP.md`)](docs/MIGRATION_AND_BACKUP.md)
- [Cài đặt Antigravity MCP & Chrome Extension (`docs/ANTIGRAVITY_MCP_SETUP.md`)](docs/ANTIGRAVITY_MCP_SETUP.md)
- [Báo cáo Kiểm chứng & Đối chiếu Audit (`docs/VERIFICATION_REPORT.md`)](docs/VERIFICATION_REPORT.md)
- [Lộ trình Mở rộng Nội bộ (`docs/ROADMAP.md`)](docs/ROADMAP.md)
