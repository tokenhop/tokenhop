# Quota Tracking & Giám sát Usage

Theo dõi tiêu thụ token thời gian thực, giám sát giới hạn quota, ước tính chi phí và nhận cảnh báo trước khi hết. Không bao giờ lãng phí quota subscription hoặc vượt giới hạn ngân sách.

---

## Tổng quan

tokenhop cung cấp quota tracking toàn diện cho mọi provider:

- **Tiêu thụ token thời gian thực** - Xem tokens dùng mỗi request
- **Giới hạn quota & còn lại** - Theo dõi usage so với giới hạn
- **Đếm ngược Reset** - Biết khi nào quota refresh
- **Ước tính chi phí** - Tính chi tiêu cho tier trả phí
- **Báo cáo hàng tháng** - Phân tích pattern sử dụng
- **Cảnh báo & thông báo** - Nhận cảnh báo trước giới hạn

---

## Tổng quan Dashboard

### Tóm tắt Quota

```
Dashboard → Home → Quota Overview

┌─────────────────────────────────────────────┐
│ Claude Code (cc/)                           │
│ ████████████░░░░░░░░ 2.5h / 5h (50%)       │
│ Resets in: 2h 30m                           │
│ Cost: $0 (subscription)                     │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Gemini CLI (gc/)                            │
│ ████████░░░░░░░░░░░░ 450 / 1000 (45%)      │
│ Daily reset in: 18h 30m                     │
│ Monthly: 45K / 180K (25%)                   │
│ Cost: $0 (free tier)                        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ GLM-4.7 (glm/)                              │
│ ██████████████░░░░░░ 7M / 10M tokens (70%)  │
│ Resets: Daily 10:00 AM (in 5h 35m)         │
│ Cost today: $4.20                           │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ MiniMax M2.1 (minimax/)                     │
│ ████████████████░░░░ 4M / 5M tokens (80%)   │
│ Rolling 5h window                           │
│ Cost (5h): $0.80                            │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ iFlow (if/)                                 │
│ ████████████████████ Unlimited              │
│ Cost: $0 (free forever)                     │
└─────────────────────────────────────────────┘
```

---

## Tiêu thụ Token Thời gian thực

### Theo dõi từng Request

Mỗi request hiển thị usage token chi tiết:

```
Dashboard → Activity → Recent Requests

Request #1234
Model: cc/claude-opus-4-5-20251101
Timestamp: 2026-02-04 04:15:32

Tokens:
  Input: 1,250 tokens
  Output: 850 tokens
  Total: 2,100 tokens

Cost: $0 (subscription quota)
Duration: 3.2s
Status: ✅ Success
```

### Live Usage Monitor

```
Dashboard → Live Monitor

Current request:
  Model: glm/glm-4.7
  Tokens streamed: 450 / ~800 estimated
  Cost so far: $0.0009
  Duration: 1.8s
```

### Phân tích Token theo Model

```
Dashboard → Analytics → Token Usage

Today (Feb 4, 2026):
  cc/claude-opus-4-5: 15M tokens ($0, subscription)
  glm/glm-4.7: 8M tokens ($4.80)
  if/kimi-k2-thinking: 3M tokens ($0, free)

Total: 26M tokens
Cost: $4.80
```

---

## Giới hạn Quota & Thời gian Reset

### Subscription Providers

**Claude Code (Pro/Max)**

```
Quota type: Time-based (5-hour rolling)
Limit: 5 hours of usage
Reset: Rolling 5-hour window + Weekly refresh
Tracking: Usage time per model

Dashboard shows:
  Opus: 2.5h / 5h used
  Sonnet: 1.2h / 5h used
  Haiku: 0.8h / 5h used

Weekly reset: Every Monday 00:00 UTC
```

**OpenAI Codex (Plus/Pro)**

```
Quota type: Time-based (5-hour rolling)
Limit: 5 hours (Plus) / 10 hours (Pro)
Reset: Rolling 5-hour window + Weekly refresh

Dashboard shows:
  GPT-5.2 Codex: 3.5h / 5h used
  Resets in: 1h 30m
```

**Gemini CLI (MIỄN PHÍ)**

```
Quota type: Request count + Monthly tokens
Daily limit: 1,000 requests
Monthly limit: 180,000 completions
Reset: Daily 00:00 UTC + Monthly 1st

Dashboard shows:
  Today: 450 / 1,000 requests (45%)
  This month: 45K / 180K completions (25%)
  Daily reset in: 18h 30m
  Monthly reset in: 26 days
```

**GitHub Copilot**

```
Quota type: Monthly usage
Limit: Varies by plan
Reset: 1st of each month

Dashboard shows:
  Usage: 60% of monthly quota
  Resets: March 1, 2026 (in 25 days)
```

### Cheap Providers

**GLM-4.7**

```
Quota type: Daily token limit
Limit: 10M tokens/day (Coding Plan)
Reset: Daily 10:00 AM Beijing Time (UTC+8)

Dashboard shows:
  Used: 7M / 10M tokens (70%)
  Remaining: 3M tokens
  Resets in: 5h 35m
  Cost today: $4.20
```

**MiniMax M2.1**

```
Quota type: Rolling 5-hour window
Limit: 5M tokens per 5 hours
Reset: Continuous rolling window

Dashboard shows:
  Used (5h): 4M / 5M tokens (80%)
  Oldest usage expires in: 45m
  Cost (5h): $0.80
```

**Kimi K2**

```
Quota type: Monthly subscription
Limit: 10M tokens/month ($9 flat)
Reset: Monthly on subscription date

Dashboard shows:
  Used: 6M / 10M tokens (60%)
  Resets: Feb 15, 2026 (in 11 days)
  Cost: $9/month (prepaid)
```

### Free Providers

**iFlow / Qwen / Kiro**

```
Quota type: Unlimited (rate-limited)
Limit: No hard limit
Reset: N/A

Dashboard shows:
  Used today: 5M tokens
  Cost: $0 (free forever)
  Status: ✅ Available
```

---

## Ước tính Chi phí

### Theo dõi Chi phí Thời gian thực

```
Dashboard → Costs → Today

Subscription providers: $0
  Claude Code: 15M tokens ($0, included)
  Gemini CLI: 3M tokens ($0, free tier)

Paid providers: $4.80
  GLM-4.7: 8M tokens ($4.80)
    Input: 6M × $0.60/1M = $3.60
    Output: 2M × $2.20/1M = $4.40
    Total: $4.80

Free providers: $0
  iFlow: 3M tokens ($0)

Total today: $4.80
```

### Báo cáo Chi tiêu Hàng tháng

```
Dashboard → Costs → This Month (February 2026)

Week 1 (Feb 1-7):
  Subscription: $0 (80M tokens)
  Paid: $15.20 (25M tokens)
  Free: $0 (10M tokens)
  Total: $15.20

Week 2 (Feb 8-14):
  Subscription: $0 (75M tokens)
  Paid: $12.80 (20M tokens)
  Free: $0 (8M tokens)
  Total: $12.80

Month to date: $28.00
Projected (30 days): ~$120

Breakdown by provider:
  GLM-4.7: $22.00 (78%)
  MiniMax M2.1: $6.00 (22%)

Average cost per 1M tokens: $0.62
Savings vs ChatGPT API: 97% ($4,000 → $120)
```

### Dự kiến Chi phí

```
Dashboard → Costs → Projections

Based on last 7 days usage:
  Daily average: 50M tokens
  Daily cost: $4.50

Monthly projection:
  Tokens: 1,500M (1.5B)
  Cost: $135

Breakdown:
  Subscription: 900M tokens ($0)
  GLM-4.7: 450M tokens ($90)
  MiniMax: 120M tokens ($24)
  Free: 30M tokens ($0)

Budget status:
  Daily limit: $5 → 90% used today
  Monthly limit: $150 → 90% projected
  ⚠️ Warning: May exceed monthly budget
```

---

## Dashboard Usage

### Thống kê Tổng quan

```
Dashboard → Analytics → Overview

Today (Feb 4, 2026):
  Requests: 1,234
  Tokens: 26M
  Cost: $4.80
  Avg response time: 2.1s

This week:
  Requests: 8,456
  Tokens: 180M
  Cost: $28.00
  Success rate: 99.2%

This month:
  Requests: 15,234
  Tokens: 320M
  Cost: $52.00
  Top model: cc/claude-opus-4-5 (45%)
```

### Usage theo Model

```
Dashboard → Analytics → Models

Top models (this month):
1. cc/claude-opus-4-5: 145M tokens (45%)
2. glm/glm-4.7: 95M tokens (30%)
3. if/kimi-k2-thinking: 50M tokens (16%)
4. minimax/MiniMax-M2.1: 20M tokens (6%)
5. gc/gemini-3-flash: 10M tokens (3%)

Cost breakdown:
  cc/claude-opus: $0 (subscription)
  glm/glm-4.7: $45.00
  if/kimi-k2-thinking: $0 (free)
  minimax/MiniMax-M2.1: $7.00
  gc/gemini-3-flash: $0 (free)
```

### Usage theo Thời gian

```
Dashboard → Analytics → Timeline

Hourly usage (today):
00:00 - 01:00: 0.5M tokens
01:00 - 02:00: 0.2M tokens
...
08:00 - 09:00: 3.2M tokens (peak)
09:00 - 10:00: 2.8M tokens
...
23:00 - 00:00: 0.8M tokens

Peak hours: 08:00 - 12:00 (morning coding)
Low hours: 00:00 - 06:00 (night)
```

### Usage theo Combo

```
Dashboard → Analytics → Combos

premium-coding:
  Requests: 456
  Tokens: 12M
  Cost: $2.40

  Breakdown:
    cc/claude-opus: 8M tokens (67%, $0)
    glm/glm-4.7: 3M tokens (25%, $1.80)
    minimax/MiniMax-M2.1: 1M tokens (8%, $0.20)

budget-combo:
  Requests: 234
  Tokens: 6M
  Cost: $1.20

  Breakdown:
    glm/glm-4.7: 4M tokens (67%, $2.40)
    if/kimi-k2-thinking: 2M tokens (33%, $0)
```

---

## Cảnh báo & Thông báo

### Cảnh báo Quota

```
Dashboard → Settings → Alerts

Quota warnings:
  ✅ Alert at 80% quota used
  ✅ Alert at 90% quota used
  ✅ Alert when quota exhausted
  ✅ Notify when quota resets

Delivery:
  ✅ Dashboard notification
  ✅ Email (optional)
  ✅ Webhook (optional)
```

**Ví dụ thông báo:**

```
⚠️ Claude Code quota 80% used
   2.5h remaining (resets in 1h 30m)

⚠️ GLM-4.7 quota 90% used
   1M tokens remaining (resets in 5h)

✅ Gemini CLI quota reset
   1,000 requests available (daily limit)
```

### Cảnh báo Ngân sách

```
Dashboard → Settings → Budget Alerts

Daily budget: $5
  ✅ Alert at 80% ($4)
  ✅ Alert at 100% ($5)
  ✅ Auto-switch to free tier when exceeded

Monthly budget: $150
  ✅ Alert at 50% ($75)
  ✅ Alert at 80% ($120)
  ✅ Alert at 100% ($150)
```

**Ví dụ thông báo:**

```
⚠️ Daily budget 80% used
   $4.00 / $5.00 spent today

⚠️ Monthly budget 50% reached
   $75 / $150 spent this month
   Projected: $135 (within budget)

🚨 Daily budget exceeded
   $5.20 / $5.00 spent today
   Auto-switched to free tier
```

### Phát hiện Bất thường Chi phí

```
Dashboard → Settings → Anomaly Detection

✅ Detect unusual spending patterns
✅ Alert on cost spikes (>2× daily average)
✅ Warn on quota exhaustion patterns

Example alert:
⚠️ Cost spike detected
   Today: $12.50 (2.5× daily average)
   Reason: High GLM-4.7 usage (20M tokens)
   Suggestion: Check if primary models quota-exhausted
```

---

## Best Practices

### 1. Theo dõi Quota Hàng ngày

```
Daily routine:
1. Check dashboard quota overview (30 seconds)
2. Review reset times
3. Plan usage around quota availability
```

**Ví dụ:**

```
Morning check:
  ✅ Claude Code: 5h available (fresh reset)
  ✅ Gemini CLI: 1K requests available
  ⚠️ GLM-4.7: 2M tokens left (resets 10AM)

Action: Use Claude Code for morning work
```

### 2. Đặt Giới hạn Ngân sách

```
Dashboard → Settings → Budget:
  Daily: $5 (prevents overspending)
  Monthly: $150 (aligns with budget)
```

**Kết quả**: Auto-switch sang free tier khi đạt giới hạn.

### 3. Tối ưu Combo Usage

```
Dashboard → Analytics → Combos:
  Review which models are used most
  Adjust combo order to minimize costs
```

**Ví dụ:**

```
Current: cc/claude-opus → glm/glm-4.7
  80% via Claude (good)
  20% via GLM ($12/month)

Optimized: gc/gemini-3-flash → cc/claude-opus → glm/glm-4.7
  50% via Gemini (free)
  40% via Claude (subscription)
  10% via GLM ($6/month)

Savings: $6/month
```

### 4. Theo dõi Thời gian Reset

```
Dashboard → Quota → Reset Schedule:
  Claude Code: 5h rolling + Weekly Monday
  Gemini CLI: Daily 00:00 UTC + Monthly 1st
  GLM-4.7: Daily 10:00 AM Beijing Time
  MiniMax: Rolling 5h window
```

**Chiến lược**: Dùng provider khi quota mới reset.

### 5. Xem Báo cáo Hàng tháng

```
Dashboard → Analytics → Monthly Report:
  Total tokens: 1.5B
  Total cost: $120
  Savings: 97% vs ChatGPT API

Insights:
  - 60% usage via subscriptions ($0)
  - 30% via GLM ($90)
  - 10% via free tier ($0)

Optimization:
  - Increase Gemini CLI usage (free)
  - Reduce GLM usage (expensive)
```

---

## Truy cập API

### Lấy trạng thái quota (từ xa / API key của gateway)

`GET /v1/quota` trả về snapshot quota chỉ đọc theo từng tài khoản, được ủy quyền bằng API key của gateway. Endpoint này hoạt động cả khi chạy cục bộ lẫn qua tunnel từ xa hoặc reverse proxy, chỉ đọc các snapshot đã lưu cache phía server (đường request này không bao giờ làm mới hay xoay vòng token OAuth và không gọi provider upstream nào), và không bao giờ giải mã hay trả về secret, token hoặc thông tin xác thực.

Xác thực bằng `Authorization: Bearer <your-api-key>` hoặc `x-api-key: <your-api-key>` (tránh truyền `?key=` trong query string, vì nó có thể bị ghi lại trong log của proxy và log truy cập). Truyền tham số query tùy chọn `?provider=<provider-id-or-alias>` (ví dụ `?provider=claude` hoặc `?provider=cc`) để thu hẹp danh sách về một provider.

Khi bật lưu trữ API key dạng hash (chế độ nhiều người dùng), kết quả được giới hạn trong workspace của API key, các grant kết nối đang hoạt động (không tiết lộ email của người cấp) và danh sách model được phép (`allowedModels` lọc ở cấp provider; danh sách `allowedModels` rỗng nghĩa là không giới hạn, kể cả khi đã đặt `allowedCombos`). Với kiểu lưu trữ một người dùng cũ, mọi kết nối đang hoạt động đều được trả về. Với các kết nối của chính workspace không có tên hiển thị tùy chỉnh, `name` dùng email hoặc id của kết nối.

```bash
curl -H "Authorization: Bearer your-api-key" \
  https://your-gateway.example.com/v1/quota

# Filter to a single provider (canonical id or alias)
curl -H "Authorization: Bearer your-api-key" \
  "http://localhost:20128/v1/quota?provider=claude"
```

Response:

```json
{
  "object": "list",
  "accounts": [
    {
      "id": "conn_01",
      "name": "claude-work",
      "provider": "claude",
      "planTier": "default_claude_max_20x",
      "fiveHour": {
        "used": 42,
        "limit": 100,
        "unit": "provider",
        "percentage": 42,
        "remainingPercentage": 58,
        "nextReset": "2026-11-25T15:00:00.000Z",
        "observedAt": "2026-11-25T12:34:56.000Z"
      },
      "weekly": {
        "used": 18,
        "limit": 100,
        "unit": "provider",
        "percentage": 18,
        "remainingPercentage": 82,
        "nextReset": "2026-12-01T00:00:00.000Z",
        "observedAt": "2026-11-25T12:34:56.000Z"
      },
      "windows": [
        {
          "kind": "5h",
          "used": 42,
          "limit": 100,
          "unit": "provider",
          "percentage": 42,
          "remainingPercentage": 58,
          "nextReset": "2026-11-25T15:00:00.000Z",
          "observedAt": "2026-11-25T12:34:56.000Z",
          "source": "probe"
        },
        {
          "kind": "7d",
          "used": 18,
          "limit": 100,
          "unit": "provider",
          "percentage": 18,
          "remainingPercentage": 82,
          "nextReset": "2026-12-01T00:00:00.000Z",
          "observedAt": "2026-11-25T12:34:56.000Z",
          "source": "probe"
        }
      ],
      "updatedAt": "2026-11-25T12:34:56.000Z",
      "stale": false
    },
    {
      "id": "conn_02",
      "name": "kimi-main",
      "provider": "kimi",
      "planTier": null,
      "fiveHour": {
        "used": 120000,
        "limit": 500000,
        "unit": "provider",
        "percentage": 24,
        "remainingPercentage": 76,
        "nextReset": "2026-11-25T16:00:00.000Z",
        "observedAt": "2026-11-25T12:34:56.000Z"
      },
      "weekly": null,
      "windows": [
        {
          "kind": "5h",
          "used": 120000,
          "limit": 500000,
          "unit": "provider",
          "percentage": 24,
          "remainingPercentage": 76,
          "nextReset": "2026-11-25T16:00:00.000Z",
          "observedAt": "2026-11-25T12:34:56.000Z",
          "source": "probe"
        }
      ],
      "updatedAt": "2026-11-25T12:34:56.000Z",
      "stale": false
    }
  ]
}
```

- `fiveHour` và `weekly` hiển thị trực tiếp các cửa sổ `5h` và `7d` (hoặc `null` khi provider đó không báo cáo cửa sổ này hoặc không có cửa sổ còn hiệu lực nào trong cache). `windows` gồm mọi cửa sổ còn hiệu lực đã cache của tài khoản, chẳng hạn `month` (Cursor, GitHub) hoặc cửa sổ theo model (`model:*`).
- `used` và `limit` phản ánh giá trị do provider báo cáo khi có (`unit: "provider"`, như số token của Kimi hoặc mức sử dụng 0–100 của Claude/Codex), và chuyển sang thang phần trăm `0–100` (`unit: "percentage"`) khi chỉ quan sát được tỷ lệ sử dụng (ví dụ từ response header). `percentage` (% đã dùng, giới hạn trong `0–100`) và `remainingPercentage` (% còn lại) luôn là phần trăm đã chuẩn hóa; `nextReset` là timestamp ISO-8601 UTC trong tương lai hoặc `null` (các cửa sổ đã qua thời điểm reset sẽ bị loại bỏ).
- Snapshot được nạp vào bộ nhớ từ response header upstream (thu thập thụ động), các lần kiểm tra quota trên dashboard và trình poll snapshot chạy nền (chạy cho các chiến lược có trọng số và thành viên của combo). `stale` là `true` khi không có cửa sổ nào còn hiệu lực (bao gồm snapshot bị thiếu, đã hết hạn hoặc chỉ có thông tin tier) hoặc khi `observedAt` của cửa sổ mới nhất đã cũ từ 15 phút trở lên.

### Endpoint usage của dashboard (session / xác thực CLI cục bộ)

Các route usage của dashboard dưới `/api/usage/*` (như `/api/usage/stats`, `/api/usage/logs` và `/api/usage/export`) và `/api/home/quota` là API của dashboard, được xác thực bằng cookie của session dashboard đã đăng nhập hoặc token CLI cục bộ; chúng không chấp nhận Bearer API key của gateway. Không có route `/api/quota` hay `/api/usage`; các đường dẫn `/api/*` chưa được map sẽ bị từ chối mặc định (fail closed) với `403 LOCAL_ONLY`.

### Xuất lịch sử usage

Nút Xuất trên trang Thống kê (tab Tổng quan) tải xuống khoảng thời gian hiện tại, kể cả khoảng tùy chỉnh, với các bộ lọc workspace/thành viên/API key đang áp dụng. Bạn cũng có thể tải trực tiếp:

```bash
GET http://localhost:20128/api/usage/export?period=7d&format=csv&granularity=day
```

- `period`: một khoảng thời gian có tên (`today`, `24h`, `7d`, `30d`, `60d`, `90d`, `all`) hoặc `custom` với `from`/`to` là các ngày cục bộ `YYYY-MM-DD`, tính cả hai đầu (tối đa 366 ngày).
- `format`: `csv` (mặc định; một mảng JSON khi là `json`). Response được stream và gửi dưới dạng file tải xuống (`tokenhop-usage-<range>-<granularity>.csv|json`).
- `granularity`: `day` (mặc định) cho một dòng mỗi ngày × provider/model/tài khoản/API key/endpoint từ bản tổng hợp hàng ngày (với `today`/`24h`, được gộp từ lịch sử từng request để khớp với các thẻ); `request` cho một dòng mỗi request từ lịch sử request đã lưu, với bất kỳ khoảng thời gian hay khoảng tùy chỉnh nào. Việc lưu giữ lịch sử là tùy chọn bật, nên nếu bạn đã bật, các dòng request có thể thiếu ở những ngày đã bị dọn; các dòng hàng ngày không bị ảnh hưởng vì chúng lấy từ bản tổng hợp.
- `bom`: `1` thêm byte order mark UTF-8 vào đầu output CSV để Excel trên Windows đọc đúng tên model, tài khoản và key có ký tự không phải ASCII (các mục **CSV for Excel** trong menu Xuất đặt giá trị này). Mặc định `0`/không truyền: không có BOM, RFC 4180 thuần. Chỉ hợp lệ với `format=csv`; mọi giá trị khác trả về 400.

Các cột: timestamp (hoặc ngày), provider, model, tài khoản, id tài khoản, tên API key, API key đã che, endpoint, token prompt/completion/cache, chi phí, trạng thái (dòng request), và ước tính của token saver (`saved_tokens_est`: theo từng request trên dòng request; trên dòng hàng ngày là tổng mức tiết kiệm trong ngày của nhóm đó, nên vẫn còn sau khi lịch sử request bị dọn). API key gốc không bao giờ được xuất, chỉ có tên key và tiền tố đã che. `format`, `granularity`, `period`, `bom` hoặc khoảng ngày không hợp lệ trả về 400; áp dụng cùng yêu cầu đăng nhập và phạm vi workspace như các endpoint usage khác.

Tên header là một hợp đồng ổn định, máy đọc được: `snake_case` tiếng Anh (`date`, `timestamp`, `prompt_tokens`, `api_key_masked`, …) ở mọi ngôn ngữ của dashboard, để script và bảng tính đọc file xuất vẫn hoạt động khi đổi ngôn ngữ giao diện. Dấu phân cách CSV luôn là dấu phẩy; ở các locale dùng `;`, hãy nhập file bằng **Data → From Text/CSV** của Excel và chọn dấu phẩy làm dấu phân cách.

---

## Troubleshooting

**Issue: Quota hiển thị 0% nhưng request thất bại**

**Giải pháp:**

1. Kiểm tra kết nối provider (Dashboard → Providers)
2. Xác minh API keys hợp lệ
3. Kiểm tra provider có down không (trang status)
4. Thử kết nối lại OAuth providers

**Issue: Ước tính chi phí sai**

**Giải pháp:**

1. Dashboard → Settings → Pricing
2. Xác minh giá mỗi provider khớp với mức hiện tại
3. Cập nhật giá nếu provider thay đổi
4. Liên hệ support nếu vẫn lệch

**Issue: Thời gian reset không cập nhật**

**Giải pháp:**

1. Refresh dashboard (F5)
2. Kiểm tra thời gian hệ thống đúng
3. Xác minh cài đặt timezone
4. Khởi động lại tokenhop nếu vẫn lỗi

**Issue: Không nhận được cảnh báo**

**Giải pháp:**

1. Dashboard → Settings → Alerts
2. Xác minh địa chỉ email đúng
3. Kiểm tra folder spam
4. Test notification (nút Send Test)

---

## Liên quan

- [Smart Routing](./smart-routing.md) - Auto fallback dựa trên quota
- [Combos](./combos.md) - Tạo chuỗi fallback tùy chỉnh
