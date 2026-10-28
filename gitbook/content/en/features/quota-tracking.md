# Quota Tracking & Usage Monitoring

Track real-time token consumption, monitor quota limits, estimate costs, and get alerts before running out. Never waste subscription quota or exceed budget limits.

---

## Overview

tokenhop provides comprehensive quota tracking for all providers:

- **Real-time token consumption** - See tokens used per request
- **Quota limits & remaining** - Track usage vs limits
- **Reset countdown** - Know when quota refreshes
- **Cost estimation** - Calculate spending for paid tiers
- **Monthly reports** - Analyze usage patterns
- **Alerts & notifications** - Get warned before limits

---

## Dashboard Overview

### Quota Summary

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

## Real-Time Token Consumption

### Per-Request Tracking

Every request shows detailed token usage:

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

### Token Breakdown by Model

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

## Quota Limits & Reset Times

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

**Gemini CLI (FREE)**

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

## Cost Estimation

### Real-Time Cost Tracking

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

### Monthly Spending Report

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

### Cost Projection

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

## Usage Dashboard

### Overview Stats

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

### Usage by Model

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

### Usage by Time

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

### Usage by Combo

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

## Alerts & Notifications

### Quota Alerts

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

**Example notifications:**

```
⚠️ Claude Code quota 80% used
   2.5h remaining (resets in 1h 30m)

⚠️ GLM-4.7 quota 90% used
   1M tokens remaining (resets in 5h)

✅ Gemini CLI quota reset
   1,000 requests available (daily limit)
```

### Budget Alerts

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

**Example notifications:**

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

### Cost Anomaly Detection

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

### 1. Monitor Quota Daily

```
Daily routine:
1. Check dashboard quota overview (30 seconds)
2. Review reset times
3. Plan usage around quota availability
```

**Example:**

```
Morning check:
  ✅ Claude Code: 5h available (fresh reset)
  ✅ Gemini CLI: 1K requests available
  ⚠️ GLM-4.7: 2M tokens left (resets 10AM)

Action: Use Claude Code for morning work
```

### 2. Set Budget Limits

```
Dashboard → Settings → Budget:
  Daily: $5 (prevents overspending)
  Monthly: $150 (aligns with budget)
```

**Result**: Auto-switch to free tier when limit reached.

### 3. Optimize Combo Usage

```
Dashboard → Analytics → Combos:
  Review which models are used most
  Adjust combo order to minimize costs
```

**Example:**

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

### 4. Track Reset Times

```
Dashboard → Quota → Reset Schedule:
  Claude Code: 5h rolling + Weekly Monday
  Gemini CLI: Daily 00:00 UTC + Monthly 1st
  GLM-4.7: Daily 10:00 AM Beijing Time
  MiniMax: Rolling 5h window
```

**Strategy**: Use providers when quota is fresh.

### 5. Review Monthly Reports

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

## Usage page periods

The Usage page Overview tab, Home, and Token saver share a period control. The choices are Today, 24h, 7d, 30d, 60d, 90d, and All time. Only Usage offers a custom range.

90d is the last 90 local calendar days, including today. All time totals every day in the daily usage rollup. On all three pages, 7d through 90d and All time are totaled from daily rollups, including savings and top-combo counts; they do not scan each stored request. Today and 24h use request history. Custom ranges on Usage also use the rollup. Day-grain periods compare with the same number of whole local calendar days before the current window. All time has no previous period; its tiles say "All recorded usage".

Custom sits beside those choices. Choose From and To, then Apply. The range is inclusive. Dates are local calendar days in `YYYY-MM-DD`. The start must be on or before the end. The end cannot be in the future. The range cannot be longer than 366 days. A valid range stays in the page URL as `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`, so a reload or a shared link keeps it. It is not saved as the remembered period. The next visit without those query parameters uses the last named period. An invalid custom URL does the same. The tiles compare the range with the same number of days immediately before it.

Example: `/dashboard/usage?period=custom&from=2026-09-01&to=2026-09-30`

Home shows a change on Requests, Tokens in/out, Est. cost, and Saved by token saver when the selected period has requests. The line is a signed percent plus a caption: "vs same time yesterday", "vs prior 24h", "vs prior 7d", "vs prior 30d", "vs prior 60d", or "vs prior 90d". Tokens in/out reads `In +12% · Out -3%` plus that caption. A side with no usable previous total is omitted. When the previous total is missing or zero, the line says "No prior data". All time shows "All recorded usage" instead of a change.

Token saver shows the same line on the saved-tokens total for the period you selected, and only when that period itself has savings. When the page stands in a larger period, it does not show the change.

## Request history retention

**Settings → Data & backup → Request history** controls how long each request's details are kept. The default is **Keep forever**. The menu also offers 7, 30, 60, 90, 180 and 365 days. The stored value may be `0` (keep forever) or an integer from 2 to 3650. A value that is not a preset still appears in the menu. Choosing a shorter limit asks you to confirm. With Users & teams on, this section is under **Instance**, and only an owner or instance admin can open it.

Charts, long periods and budgets use daily totals, which are not deleted. With a limit set, older request details are removed in the background about 10 minutes after startup, then once a day. A settings change applies on the next sweep. Only whole local days older than the limit are removed, so a request is kept for at least that many days. Days that are not fully in the daily rollup are kept. The newest request for each workspace, each membership and each API key is kept. Savings, top combos and day-grain period comparisons use retained daily totals, so pruning request details does not reduce them. API-key last-used times and today's request counts also come from the rollup. Savings and combo history pruned before the savings rollup was introduced cannot be recovered; when the selected period includes such days, Token saver says its total may not include them. The database file may not shrink.

## API Access

### Get Quota Status

```bash
GET http://localhost:20128/api/quota
Authorization: Bearer your-api-key

Response:
{
  "providers": [
    {
      "id": "cc",
      "name": "Claude Code",
      "quota": {
        "used": 2.5,
        "limit": 5,
        "unit": "hours",
        "percentage": 50
      },
      "reset": {
        "type": "rolling",
        "window": "5h",
        "nextReset": "2026-02-04T06:45:00Z"
      },
      "cost": {
        "today": 0,
        "month": 0,
        "currency": "USD"
      }
    },
    {
      "id": "glm",
      "name": "GLM-4.7",
      "quota": {
        "used": 7000000,
        "limit": 10000000,
        "unit": "tokens",
        "percentage": 70
      },
      "reset": {
        "type": "daily",
        "time": "10:00 AM UTC+8",
        "nextReset": "2026-02-04T10:00:00+08:00"
      },
      "cost": {
        "today": 4.20,
        "month": 52.00,
        "currency": "USD"
      }
    }
  ]
}
```

### Get Usage Stats

```bash
GET http://localhost:20128/api/usage?period=today
Authorization: Bearer your-api-key

Response:
{
  "period": "today",
  "date": "2026-02-04",
  "summary": {
    "requests": 1234,
    "tokens": 26000000,
    "cost": 4.80
  },
  "byModel": [
    {
      "model": "cc/claude-opus-4-5",
      "requests": 456,
      "tokens": 15000000,
      "cost": 0
    },
    {
      "model": "glm/glm-4.7",
      "requests": 234,
      "tokens": 8000000,
      "cost": 4.80
    }
  ]
}
```

### Export usage history

The Usage page's Export button (Overview tab) downloads the current period — including a custom range — with the active workspace/member/API-key filters applied. The same download is available directly:

```bash
GET http://localhost:20128/api/usage/export?period=7d&format=csv&granularity=day
```

- `period`: a named period (`today`, `24h`, `7d`, `30d`, `60d`, `90d`, `all`) or `custom` with `from`/`to` as inclusive local `YYYY-MM-DD` days (max 366 days).
- `format`: `csv` (default, a JSON array when `json`). The response is streamed and sent as a file download (`tokenhop-usage-<range>-<granularity>.csv|json`).
- `granularity`: `day` (default) gives one row per day × provider/model/account/API key/endpoint from the daily rollup (for `today`/`24h`, folded from per-request history so it matches the cards); `request` gives one row per request from the stored request history for any period or custom range. History retention is opt-in, so if you enabled it, request rows may be missing for pruned days — daily rows are unaffected because they come from the rollup.
- `bom`: `1` prefixes a UTF-8 byte order mark to CSV output so Excel on Windows reads non-ASCII model, account and key names correctly (the Export menu's **CSV for Excel** items set it). Default `0`/absent: no BOM, plain RFC 4180. Only valid with `format=csv`; any other value returns 400.

Columns: timestamp (or date), provider, model, account, account id, API key name, masked API key, endpoint, prompt/completion/cached tokens, cost, status (request rows), and the token-saver estimate (`saved_tokens_est`: per request on request rows; on daily rows it is the day's rolled-up savings for that group, so it survives request-history pruning). Raw API keys are never exported — only the key's name and masked prefix. Invalid `format`, `granularity`, `period`, `bom` or date ranges return 400; the same sign-in and workspace scoping as the other usage endpoints applies.

Header names are a stable, machine-readable contract: English `snake_case` (`date`, `timestamp`, `prompt_tokens`, `api_key_masked`, …) in every dashboard language, so scripts and spreadsheets that read the export keep working when the UI locale changes. The CSV separator is always a comma; in locales that expect `;`, import the file with Excel's **Data → From Text/CSV** and pick the comma delimiter.

---

## Troubleshooting

**Issue: Quota shows 0% but requests failing**

**Solution:**

1. Check provider connection (Dashboard → Providers)
2. Verify API keys are valid
3. Check if provider is down (status page)
4. Try reconnecting OAuth providers

**Issue: Cost estimation incorrect**

**Solution:**

1. Dashboard → Settings → Pricing
2. Verify pricing per provider matches current rates
3. Update pricing if provider changed rates
4. Contact support if discrepancy persists

**Issue: Reset time not updating**

**Solution:**

1. Refresh dashboard (F5)
2. Check system time is correct
3. Verify timezone settings
4. Restart tokenhop if issue persists

**Issue: Alerts not received**

**Solution:**

1. Dashboard → Settings → Alerts
2. Verify email address is correct
3. Check spam folder
4. Test notification (Send Test button)

---

## Related

- [Smart Routing](./smart-routing.md) - Auto fallback based on quota
- [Combos](./combos.md) - Create custom fallback chains
