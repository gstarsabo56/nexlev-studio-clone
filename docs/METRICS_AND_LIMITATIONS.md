# Công thức Chỉ số & Giới hạn Trung thực (`METRICS_AND_LIMITATIONS.md`)

Tài liệu này quy định cách tính toán các chỉ số trong `src/core/metrics.mjs`, `src/core/parsers.mjs` và `src/core/engine.mjs`, cùng các giới hạn bắt buộc để không bao giờ đánh lừa người dùng hoặc AI Agent.

---

## 1. Phân tích Chuỗi Số liệu Đa Ngôn ngữ (`src/core/parsers.mjs`)

### 1.1. Lượt xem & Người đăng ký (`parseCountTextStrict`)
- Hỗ trợ 11 ngôn ngữ: `en`, `de`, `fr`, `es`, `pt`, `it`, `nl`, `ja`, `ko`, `zh`, `vi`.
- **Quy tắc đơn vị chuẩn xác**:
  - `K` / `nghìn` / `ngàn` / `mil` / `천` / `千` = $10^3$ (`1,000`)
  - `만` / `万` / `萬` = $10^4$ (`10,000`)
  - `M` / `Mio.` / `Tr` / `triệu` / `millones` / `milioni` = $10^6$ (`1,000,000`)
  - `억` / `億` = $10^8$ (`100,000,000`)
  - `B` / `Mrd.` / `Md` / `tỷ` / `milliard` / `mil millones` = $10^9$ (`1,000,000,000`) — **Đã sửa triệt để lỗi cũ đọc `"1B"` thành 100 triệu**.
- **Dấu thập phân vs Dấu phân cách hàng nghìn**:
  - Khi đi kèm hậu tố đơn vị (`"1,2 Mio. Aufrufe"`, `"2,5 Tr"`), dấu `,` hoặc `.` đơn được hiểu là dấu thập phân (`1,200,000`, `2,500,000`).
  - Khi không có đơn vị (`"1,234,567 views"` hoặc `"1.234.567 Aufrufe"`), nhóm 3 chữ số được hiểu là phân cách hàng nghìn (`1,234,567`).
  - Khi có hậu tố đơn vị, cờ `isRounded = true` được bật để báo hiệu con số từ YouTube đã bị làm tròn hiển thị.
  - Nếu gặp đơn vị lạ hoặc chuỗi rỗng, trả về `{ value: null, status: "unknown", reason }`.

### 1.2. Ngày đăng tương đối (`parsePublishedTextStrict`)
- Hỗ trợ đầy đủ các cấu trúc tiền tố và hậu tố của 11 ngôn ngữ:
  - Tiếng Pháp: `il y a 3 semaines` $\rightarrow 21$ ngày
  - Tiếng Bồ Đào Nha: `há 2 meses` $\rightarrow 60$ ngày
  - Tiếng Hà Lan: `5 dagen geleden` $\rightarrow 5$ ngày
  - Tiếng Đức: `vor 4 Tagen` $\rightarrow 4$ ngày
  - Tiếng Việt / Anh / Tây Ban Nha / Ý / Nhật / Hàn / Trung.
- **Không bao giờ dùng giá trị mặc định `12` ngày** khi không đọc được chuỗi ngày đăng. Nếu không khớp mẫu, trả về `publishedDaysAgo: null, status: "unknown"`.

---

## 2. Phân loại Định dạng Cấp Video (`classifyVideoContentType`)

- Mỗi video được phân loại độc lập thành `'shorts' | 'long' | 'live' | 'unknown'`:
  - `'live'`: Có cờ `isLive` hoặc `isUpcoming`.
  - `'shorts'`: URL chứa `/shorts/`, tiêu đề chứa `#shorts`, hoặc `durationSeconds <= 60`.
  - `'long'`: `durationSeconds > 60`.
  - `'unknown'`: Khi chưa biết thời lượng và không có dấu hiệu URL/tag.
- **Tuyệt đối không dùng thời lượng trung bình của cả kênh (`avgDurationMinutes <= 1.2`) để gán toàn bộ video thành Shorts.**

---

## 3. Công thức Outlier & Ngưỡng Mẫu Tối thiểu (`evaluateChannelVideosOutliers`)

### 3.1. Nhóm theo Định dạng Cùng Kênh
- Video `'long'` chỉ được so sánh với baseline của các video `'long'` thuộc **cùng kênh đó**.
- Video `'shorts'` chỉ được so sánh với baseline của các video `'shorts'` thuộc **cùng kênh đó**.
- Không bao giờ dùng median của các video ngẫu nhiên đang hiển thị trên trang chủ/kết quả tìm kiếm YouTube làm outlier của kênh.

### 3.2. Ngưỡng mẫu tối thiểu (`minOutlierSampleSize`)
- Mặc định: `DEFAULT_MIN_OUTLIER_SAMPLE_SIZE = 3` video cùng định dạng trên cùng một kênh (khuyến nghị `RECOMMENDED_OUTLIER_SAMPLE_SIZE = 5`). Có thể điều chỉnh trong phần **Settings**.
- Nếu số lượng video cùng định dạng của kênh `< minOutlierSampleSize` (ví dụ kênh chỉ mới thu thập được 1 hoặc 2 video):
  - `outlierRatio = null`
  - `outlierScore = null`
  - `outlierStatus = "insufficient_data"`
  - `baselineMedianViews = null`
  - **Không bao giờ dùng hàm băm tên kênh (`hash(channel.title)`) để tạo độ lệch giả tạo.** Đổi tên kênh không làm thay đổi bất kỳ chỉ số nào.

### 3.3. Khi đủ mẫu (`sampleSize >= minOutlierSampleSize`)
- Tính `medianViews` và `trimmedMeanViews` (cắt 15% hai đầu khi mẫu $>3$) của các video cùng định dạng trong kênh.
- Công thức tỷ lệ bứt phá:
  $$\text{outlierRatio} = \text{round}\left(\frac{\text{video.views}}{\text{baseline.medianViews}}, 2\right)$$
- Cảnh báo lệch tuổi video (`ageSkewWarning`): Nếu khoảng cách giữa video mới nhất và cũ nhất trong mẫu $> 60$ ngày (`wide_publication_window`), hệ thống gắn cảnh báo rằng đây là phép so sánh lượt xem tích lũy trọn đời (lifetime views).

---

## 4. Nhãn Heuristic Faceless / AI & Kịch bản RPM

- **Faceless & AI Classification (`classifyChannelHeuristic`)**:
  - Văn bản rỗng (`""`) trả về `isFaceless: null, facelessLabel: "unknown", facelessStatus: "unknown"`.
  - Khi khớp bộ từ khóa, trả về nhãn `'likely_faceless'` hoặc `'likely_on_camera'` kèm danh sách từ khóa khớp (`facelessSignals`), với `status: "estimated"`. Không hiển thị phần trăm độ tự tin giả tạo (`94%`).
- **Trạng thái Kiếm tiền YPP (`monetizationStatus`)**:
  - Luôn là `'unknown'` (`isMonetized: null`) vì YouTube không công khai trạng thái đối tác YPP qua dữ liệu công khai.
- **Kịch bản RPM & Doanh thu (`simulateRpmScenario`)**:
  - Được gắn `status: "estimated"` kèm đầy đủ giả định (`baseCpm`, `tier1Share`, `durationFactor`, `marketMultiplier`). Nếu thiếu lượt xem tháng (`monthlyViews = null`), doanh thu ước tính trả về `null` (`unknown`).
