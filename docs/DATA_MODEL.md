# Mô hình Dữ liệu & Schema SQLite (`DATA_MODEL.md`)

Tài liệu này mô tả cấu trúc cơ sở dữ liệu tập trung tại `data/nexlev.sqlite` (`SQLite WAL mode`) và chuẩn Provenance Envelope trong `src/core/provenance.mjs` và `src/core/sqlite-repo.mjs`.

---

## 1. Provenance Metric Envelope (`src/core/provenance.mjs`)

Mọi chỉ số quan trọng trên toàn hệ thống đều tuân theo cấu trúc chuẩn:

```json
{
  "value": 1200000,
  "status": "observed",
  "source": "youtube_innertube_search",
  "collectedAt": "2026-10-15T15:30:00.000Z",
  "sampleSize": null,
  "methodVersion": "honest-metrics-v2.0",
  "isRounded": true,
  "reason": null
}
```

### Các giá trị `status` hợp lệ:
- `observed`: Thu thập trực tiếp từ YouTube (InnerTube hoặc YouTube Data API v3).
- `derived`: Tính toán xác định từ tập mẫu quan sát đủ điều kiện (`sampleSize >= minOutlierSampleSize`).
- `estimated`: Ước lượng theo mô hình kịch bản hoặc từ khóa heuristic (luôn kèm giả định hoặc tín hiệu khớp).
- `insufficient_data`: Chưa đủ mẫu để tính toán (ví dụ: kênh mới chỉ quan sát được `< 3` video cùng định dạng).
- `unknown`: YouTube ẩn dữ liệu hoặc nguồn hiện tại chưa trả về trường này (`value: null`).
- `legacy_unverified`: Dữ liệu lịch sử chuyển từ `data/nexlev-db.json` cũ chưa có nguồn kiểm chứng cấp kênh.
- `demo`: Dữ liệu mẫu phục vụ minh họa giao diện (bị loại khỏi nghiên cứu thực tế khi `includeDemo = false`).

---

## 2. Phân tách Quốc gia & Ngôn ngữ

Hệ thống tách bạch 4 khái niệm không bao giờ được gộp chung:
1. `discovery_country` & `discovery_lang`: Thị trường và ngôn ngữ của từ khóa dùng khi tìm kiếm (`US`, `DE`, `JP`...).
2. `channel_country` (`channel_country_status`): Quốc gia đăng ký của kênh (chỉ `observed` khi lấy được từ trang About hoặc YouTube Data API v3 `snippet.country`; mặc định là `null` / `unknown`).
3. `content_language` (`content_language_status`): Ngôn ngữ nội dung của video/kênh.
4. `audienceGeography` (`audienceGeographyStatus = 'unknown'`): Phân bổ quốc gia người xem. Vì YouTube Studio Analytics là dữ liệu riêng tư của chủ kênh, hệ thống trả về `null` (`unknown`) chứ không gán tỷ lệ cố định `US 42% / UK 14%`.

---

## 3. Các Bảng trong SQLite (`data/nexlev.sqlite`)

### 3.1. `schema_migrations`
Lưu lịch sử chạy migration (`version = 'v2.0-honest-sqlite'`) và báo cáo đối soát (`reconciliation_json`) để đảm bảo quá trình di trú từ JSON sang SQLite là **idempotent** (chạy nhiều lần không nhân bản dữ liệu).

### 3.2. `channels`
Lưu thông tin kênh, trạng thái provenance từng nhóm chỉ số, baseline theo từng định dạng (`baselines_by_format_json`) và trạng thái Watchlist chung của team (`is_tracked`, `watchlist_note`, `watchlist_added_by`).

### 3.3. `videos`
Lưu từng video quan sát được (`video_id PRIMARY KEY`, `channel_id`), phân loại định dạng cấp từng video (`content_type`: `'long' | 'shorts' | 'live' | 'unknown'`), `views`, `likes` (`NULL` nếu thiếu), `comments` (`NULL` nếu thiếu), `duration_seconds`, `published_days_ago`, `outlier_ratio`, `outlier_status`, `baseline_median_views`, `baseline_sample_size`.
- Khi quét lại một kênh đã tồn tại, `upsertChannelAndVideos` thực hiện `INSERT ... ON CONFLICT(video_id) DO UPDATE` và tính lại baseline trên **toàn bộ video đã lưu của kênh đó** (không bao giờ xóa mất các video đã lưu từ lần quét trước).

### 3.4. `metric_snapshots`
Lưu chuỗi thời gian thực tế (`entity_type`, `entity_id`, `views`, `subscribers`, `video_count`, `collected_at`) mỗi khi kênh được quét hoặc làm giàu dữ liệu. Dùng để tính tốc độ tăng trưởng thực tế (`getChannelGrowthTracking`).

### 3.5. `discovery_records`, `crawl_seeds`, `crawl_jobs`
- `discovery_records`: Lưu vết kênh được tìm thấy từ thị trường nào, từ khóa nào, vào thời điểm nào.
- `crawl_seeds`: Lưu danh sách hạt giống từ khóa theo từng thị trường (`attempt_count`, `last_attempt_at`, `last_success_at`, `last_error`, `status`).
- `crawl_jobs`: Lưu tiến độ, số lượng request, trạng thái hủy (`cancel_requested`) và kết quả của từng đợt quét.

### 3.6. `swipe_folders` & `swipe_items` (Thư viện Ý tưởng & Quy trình 6 Bước)
Lưu các video/kênh được lưu từ Web Dashboard, MCP hoặc Chrome Extension:
- Định danh gốc: `video_id`, `channel_id`, `canonical_url`, `thumbnail_url`.
- Điều phối công việc:
  - `workflow_stage`: `'discovered' | 'approved' | 'briefing' | 'assigned' | 'published' | 'review'`
  - `assignee_id`, `owner_label`: Nhân viên phụ trách
  - `deadline`: Hạn hoàn thành
  - `notes`: Ghi chú sản xuất
  - `result_url` / `published_video_url`: Link sản phẩm sau khi đăng
  - `brief_markdown`: Bản Production Brief chi tiết

### 3.7. `users` & `user_sessions`
Lưu tài khoản nhân viên nội bộ (`role`: `'manager' | 'member'`), mật khẩu băm bằng `crypto.scryptSync` + salt ngẫu nhiên, `api_token` riêng và phiên đăng nhập (`user_sessions`).
