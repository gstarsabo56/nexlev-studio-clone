# Lộ trình Phát triển Hệ thống Nội bộ (`ROADMAP.md`)

Tài liệu này định hướng các bước cải tiến tiếp theo cho công cụ nghiên cứu ngách & điều phối sản xuất nội bộ công ty sau khi đã hoàn tất nền tảng dữ liệu trung thực (`v2.0`).

---

## 🎯 Phạm vi Hiện tại (Đã hoàn thành trong `v2.0`)
1. **Dữ liệu Trung thực có Nguồn gốc (Provenance Envelope)**: Phân biệt rõ `observed`, `derived`, `estimated`, `unknown`, `insufficient_data`, `legacy_unverified` và `demo`.
2. **Backend & Cơ sở dữ liệu Tập trung (`SQLite WAL`)**: Đọc/ghi đồng thời an toàn giữa Web Dashboard, Crawler, MCP Server và Chrome Extension.
3. **Đăng nhập Nội bộ & Phân quyền (`manager` / `member`)**: Quản lý tài khoản nhân viên, phiên đăng nhập và `api_token` cá nhân.
4. **Watchlist & Thư viện Ý tưởng Chung**: Chia sẻ giữa toàn bộ thành viên trong team.
5. **Quy trình Sản xuất 6 Bước**:
   - `1. Phát hiện (discovered)` → `2. Duyệt (approved)` → `3. Brief (briefing)` → `4. Giao việc (assigned)` → `5. Đã đăng (published)` → `6. Đánh giá (review)`.
   - Đầy đủ thông tin: Người phụ trách, Deadline, Ghi chú, Link kết quả và Production Brief.

*(Ngoài phạm vi: Subscription, cổng thanh toán, chia gói bán hàng, landing page thương mại và kiến trúc multi-tenant).*

---

## 🚀 Các Giai đoạn Mở rộng Tiếp theo (Khi Team Vận hành Ổn định)

### Giai đoạn 1 — Làm giàu Dữ liệu Cấp Kênh Tự động (Channel Page Deep Enricher)
- Bổ sung worker chạy nền tốc độ thấp chuyên truy cập tab `/videos` và `/about` của các kênh trong **Watchlist** (và các kênh `legacy_unverified` chỉ mới có 1–2 video) để thu thập đủ `>= 10` video gần nhất cùng `subscribers` thực tế mà không cần phụ thuộc hoàn toàn vào hạn ngạch YouTube Data API v3.

### Giai đoạn 2 — Theo dõi Hiệu quả Sau Xuất bản (Post-Publish Review Loop)
- Ở bước **6. Đánh giá (`review`)**, khi nhân viên gắn `resultUrl` (link video của team đã đăng lên YouTube), hệ thống tự động định kỳ chụp snapshot lượt xem (`metric_snapshots`) của chính video đó sau 24h, 7 ngày và 30 ngày để so sánh hiệu quả thực tế với video đối thủ ban đầu trong Brief.

### Giai đoạn 3 — Phân tích Thị giác Thumbnail Thực tế (Local/API Vision Critique)
- Tích hợp mô hình thị giác (Multimodal Vision qua Gemini API hoặc công cụ tính độ tương phản/mật độ chữ cục bộ) để chuyển trạng thái `imageAnalysisStatus` từ `not_analyzed` sang phân tích bố cục thực tế khi team tải ảnh phác thảo thumbnail lên phòng Lab.
