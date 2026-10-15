# Di trú Dữ liệu, Sao lưu & Phục hồi (`MIGRATION_AND_BACKUP.md`)

Tài liệu này hướng dẫn quy trình chuyển đổi tự động từ `data/nexlev-db.json` sang `data/nexlev.sqlite`, cách làm sạch dữ liệu legacy chưa xác minh, và quy trình sao lưu/phục hồi an toàn cho hệ thống nội bộ công ty.

---

## 1. Quy trình Di trú Idempotent (`migrateLegacyJsonToSqlite`)

Khi khởi động `src/server.mjs` hoặc `mcp-server/index.mjs`, hàm `ensureDbMigrated()` kiểm tra bảng `schema_migrations` với khóa `version = 'v2.0-honest-sqlite'`. Nếu chưa chạy:

1. **Tự động Sao lưu File JSON Gốc**:
   - Toàn bộ file `data/nexlev-db.json` được sao chép nguyên trạng vào thư mục `data/backups/nexlev-db.backup.<timestamp>.json` trước khi thực hiện bất kỳ thay đổi nào.
2. **Tách Bí mật (API Keys) Khỏi File Được Git Theo dõi**:
   - Nếu `data/nexlev-db.json` có chứa `youtubeApiKey` hoặc `geminiApiKey`, hệ thống tự động chuyển chúng sang `data/.secrets.local.json` (đã nằm trong `.gitignore`) và xóa chuỗi key trong `nexlev-db.json`.
3. **Phân loại & Làm sạch Dữ liệu Cũ**:
   - **12 kênh mẫu ban đầu (`SEED_CHANNELS`)**: Được gắn `data_origin = 'demo'` và bị ẩn mặc định (`includeDemo = false`).
   - **Các kênh thu thập từ bản cũ (`legacy_unverified`)**:
     - Được gắn `data_origin = 'legacy_unverified'`.
     - Loại bỏ các trường bị sinh giả ở phiên bản cũ (`subscribers`, `totalViews`, `videoCount = 26`, `channelAgeMonths = 5.5`, `isMonetized = true`, `hourly48hSeries`, và lượt `likes = 3.9% views` / `comments = 0.26% views`).
     - Tính toán lại `outlierRatio` theo đúng ngưỡng `minOutlierSampleSize = 3`: Những kênh chỉ có 1 hoặc 2 video trong DB được chuyển về `outlier_status = 'insufficient_data'` và `top_outlier_ratio = NULL`.
4. **Bảo toàn Dữ liệu Người dùng**:
   - Toàn bộ `swipeFolders`, `swipeItems` (ghi chú, tags, trạng thái quy trình, người phụ trách), `filterTemplates` và danh sách `trackedChannelIds` (Watchlist) đều được giữ nguyên 100%.

### Kết quả Đối soát Thực tế (Reconciliation Summary):
- **Tổng số kênh trong SQLite**: `591` kênh (`12` kênh `demo` + `579` kênh `legacy_unverified`).
- **Tổng số video trong SQLite**: `999` video.
- **Số kênh đủ mẫu tính Outlier (`>= 3` video cùng định dạng)**: `86` kênh (`derived`), `505` kênh được gắn đúng trạng thái `insufficient_data`.
- **Bảo toàn dữ liệu người dùng**: `3` Swipe Folders, `3` Swipe Items, `4` Filter Templates.

---

## 2. Sao lưu & Phục hồi (`Backup & Restore`)

Vì toàn bộ dữ liệu của công ty nằm gọn trong `data/nexlev.sqlite` (cùng chế độ WAL), việc sao lưu hàng ngày trên máy Mac M2 Pro cực kỳ đơn giản:

### 2.1. Sao lưu nóng (Hot Backup khi Server đang chạy)
Sử dụng lệnh `.backup` của `sqlite3` để đảm bảo tính toàn vẹn giao dịch ngay cả khi nhân viên hoặc MCP đang ghi dữ liệu:

```bash
mkdir -p data/backups
sqlite3 data/nexlev.sqlite ".backup 'data/backups/nexlev-$(date +%Y%m%d-%H%M%S).sqlite'"
```

### 2.2. Phục hồi từ Bản sao lưu (Restore)
1. Dừng tiến trình Web Server (`Ctrl+C`).
2. Xóa các file tạm `-wal` và `-shm` hiện tại, sau đó chép bản backup đè lên `data/nexlev.sqlite`:
   ```bash
   rm -f data/nexlev.sqlite-wal data/nexlev.sqlite-shm
   cp data/backups/nexlev-YYYYMMDD-HHMMSS.sqlite data/nexlev.sqlite
   ```
3. Khởi động lại server bằng `npm start`.
