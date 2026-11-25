# クォータトラッキングと使用量モニタリング

リアルタイムのトークン消費を追跡し、クォータ制限を監視し、コストを見積もり、不足前にアラートを取得。サブスクリプションクォータを無駄にしたり、予算上限を超えたりすることはありません。

---

## 概要

tokenhopはすべてのプロバイダーに対して包括的なクォータトラッキングを提供:

- **リアルタイムトークン消費** - リクエストごとの使用トークンを表示
- **クォータ上限と残量** - 使用量 vs 上限を追跡
- **リセットカウントダウン** - クォータが更新されるタイミング
- **コスト見積もり** - 有料階層の支出を計算
- **月次レポート** - 使用パターンを分析
- **アラートと通知** - 上限前に警告を取得

---

## ダッシュボード概要

### クォータサマリー

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

## リアルタイムトークン消費

### リクエストごとのトラッキング

各リクエストに詳細なトークン使用量が表示されます:

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

### ライブ使用量モニター

```
Dashboard → Live Monitor

Current request:
  Model: glm/glm-4.7
  Tokens streamed: 450 / ~800 estimated
  Cost so far: $0.0009
  Duration: 1.8s
```

### モデル別のトークン内訳

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

## クォータ上限とリセット時間

### サブスクリプションプロバイダー

**Claude Code (Pro/Max)**

```
クォータタイプ: 時間ベース (5時間ローリング)
上限: 5時間の使用
リセット: 5時間ローリングウィンドウ + 週次更新
追跡: モデルごとの使用時間

ダッシュボード表示:
  Opus: 2.5h / 5h 使用
  Sonnet: 1.2h / 5h 使用
  Haiku: 0.8h / 5h 使用

週次リセット: 毎週月曜00:00 UTC
```

**OpenAI Codex (Plus/Pro)**

```
クォータタイプ: 時間ベース (5時間ローリング)
上限: 5時間 (Plus) / 10時間 (Pro)
リセット: 5時間ローリングウィンドウ + 週次更新

ダッシュボード表示:
  GPT-5.2 Codex: 3.5h / 5h 使用
  Resets in: 1h 30m
```

**Gemini CLI (無料)**

```
クォータタイプ: リクエスト数 + 月次トークン
日次上限: 1,000 リクエスト
月次上限: 180,000 コンプリーション
リセット: 日次 00:00 UTC + 月次 1日

ダッシュボード表示:
  Today: 450 / 1,000 requests (45%)
  This month: 45K / 180K completions (25%)
  Daily reset in: 18h 30m
  Monthly reset in: 26 days
```

**GitHub Copilot**

```
クォータタイプ: 月次使用量
上限: プランによる
リセット: 各月1日

ダッシュボード表示:
  Usage: 60% of monthly quota
  Resets: March 1, 2026 (in 25 days)
```

### 低価格プロバイダー

**GLM-4.7**

```
クォータタイプ: 日次トークン上限
上限: 10Mトークン/日 (Coding Plan)
リセット: 毎日午前10時 北京時間 (UTC+8)

ダッシュボード表示:
  Used: 7M / 10M tokens (70%)
  Remaining: 3M tokens
  Resets in: 5h 35m
  Cost today: $4.20
```

**MiniMax M2.1**

```
クォータタイプ: 5時間ローリングウィンドウ
上限: 5時間あたり5Mトークン
リセット: 連続ローリングウィンドウ

ダッシュボード表示:
  Used (5h): 4M / 5M tokens (80%)
  Oldest usage expires in: 45m
  Cost (5h): $0.80
```

**Kimi K2**

```
クォータタイプ: 月次サブスクリプション
上限: 10Mトークン/月 ($9固定)
リセット: サブスクリプション日に月次

ダッシュボード表示:
  Used: 6M / 10M tokens (60%)
  Resets: Feb 15, 2026 (in 11 days)
  Cost: $9/month (prepaid)
```

### 無料プロバイダー

**iFlow / Qwen / Kiro**

```
クォータタイプ: 無制限 (レート制限)
上限: ハード制限なし
リセット: なし

ダッシュボード表示:
  Used today: 5M tokens
  Cost: $0 (free forever)
  Status: ✅ Available
```

---

## コスト見積もり

### リアルタイムコストトラッキング

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

### 月次支出レポート

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

### コスト予測

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

## 使用量ダッシュボード

### 概要統計

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

### モデル別使用量

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

### 時間別使用量

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

### コンボ別使用量

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

## アラートと通知

### クォータアラート

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

**通知例:**

```
⚠️ Claude Code quota 80% used
   2.5h remaining (resets in 1h 30m)

⚠️ GLM-4.7 quota 90% used
   1M tokens remaining (resets in 5h)

✅ Gemini CLI quota reset
   1,000 requests available (daily limit)
```

### 予算アラート

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

**通知例:**

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

### コスト異常検知

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

## ベストプラクティス

### 1. クォータを毎日モニター

```
日課:
1. ダッシュボードクォータ概要を確認 (30秒)
2. リセット時間を確認
3. クォータ可用性に合わせて使用量を計画
```

**例:**

```
朝の確認:
  ✅ Claude Code: 5時間利用可 (新鮮なリセット)
  ✅ Gemini CLI: 1Kリクエスト利用可
  ⚠️ GLM-4.7: 2Mトークン残 (午前10時リセット)

アクション: 朝の作業にClaude Codeを使用
```

### 2. 予算上限を設定

```
Dashboard → Settings → Budget:
  Daily: $5 (使いすぎ防止)
  Monthly: $150 (予算に整合)
```

**結果**: 上限到達時に自動的に無料階層へ切替。

### 3. コンボ使用を最適化

```
Dashboard → Analytics → Combos:
  どのモデルが最もよく使われているか確認
  コストを最小化するためにコンボ順序を調整
```

**例:**

```
現在: cc/claude-opus → glm/glm-4.7
  80% Claude経由 (良好)
  20% GLM経由 ($12/月)

最適化後: gc/gemini-3-flash → cc/claude-opus → glm/glm-4.7
  50% Gemini経由 (無料)
  40% Claude経由 (サブスクリプション)
  10% GLM経由 ($6/月)

節約: $6/月
```

### 4. リセット時間を追跡

```
Dashboard → Quota → Reset Schedule:
  Claude Code: 5時間ローリング + 週次月曜
  Gemini CLI: 日次 00:00 UTC + 月次 1日
  GLM-4.7: 毎日午前10時 北京時間
  MiniMax: 5時間ローリングウィンドウ
```

**戦略**: クォータが新鮮な時にプロバイダーを使用。

### 5. 月次レポートを確認

```
Dashboard → Analytics → Monthly Report:
  Total tokens: 1.5B
  Total cost: $120
  Savings: 97% vs ChatGPT API

インサイト:
  - 60% サブスクリプション経由の使用 ($0)
  - 30% GLM経由 ($90)
  - 10% 無料階層経由 ($0)

最適化:
  - Gemini CLI使用を増やす (無料)
  - GLM使用を減らす (高価)
```

---

## APIアクセス

### クォータステータスを取得（リモート / ゲートウェイAPIキー）

`GET /v1/quota` は、ゲートウェイAPIキーで認可された、アカウントごとの読み取り専用クォータスナップショットを返します。ローカルでも、リモートトンネルやリバースプロキシ経由でも動作します。読み取るのはサーバー側にキャッシュされたスナップショットだけで（このリクエスト経路ではOAuthトークンの更新やローテーションを一切行わず、上流プロバイダーへの呼び出しもしません）、シークレット、トークン、認証情報を復号したり返したりすることはありません。

認証には `Authorization: Bearer <your-api-key>` または `x-api-key: <your-api-key>` を使います（`?key=` をクエリ文字列で渡すのは避けてください。プロキシやアクセスログに記録される可能性があります）。任意の `?provider=<provider-id-or-alias>` クエリパラメーター（例: `?provider=claude` や `?provider=cc`）を渡すと、一覧を1つのプロバイダーに絞り込めます。

ハッシュ化されたAPIキー保存が有効な場合（マルチユーザーモード）、結果はAPIキーのワークスペース、有効な接続グラント（付与者のメールアドレスは開示しません）、モデル許可リストの範囲に限定されます（`allowedModels` はプロバイダー単位で絞り込みます。`allowedModels` が空のリストの場合は、`allowedCombos` が設定されていても制限なしになります）。従来のシングルユーザー保存では、有効なすべての接続が返されます。自ワークスペースの接続でカスタム表示名がない場合、`name` には接続のメールアドレスまたはIDが使われます。

```bash
curl -H "Authorization: Bearer your-api-key" \
  https://your-gateway.example.com/v1/quota

# Filter to a single provider (canonical id or alias)
curl -H "Authorization: Bearer your-api-key" \
  "http://localhost:20128/v1/quota?provider=claude"
```

レスポンス:

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

- `fiveHour` と `weekly` は `5h` と `7d` のウィンドウをそのまま示します（そのプロバイダーがウィンドウを報告しない場合や、有効なウィンドウがキャッシュされていない場合は `null`）。`windows` には、`month`（Cursor、GitHub）やモデル単位のウィンドウ（`model:*`）など、そのアカウントの有効なキャッシュ済みウィンドウがすべて含まれます。
- `used` と `limit` は、利用可能な場合はプロバイダーが報告する値（`unit: "provider"`。Kimiのトークン数やClaude/Codexの0〜100の使用率など）を反映し、使用率の割合しか観測されていない場合（レスポンスヘッダーからなど）は `0–100` のパーセンテージ尺度（`unit: "percentage"`）にフォールバックします。`percentage`（使用済み%、`0–100` に制限）と `remainingPercentage`（残り%）は常に正規化されたパーセンテージです。`nextReset` は未来のISO-8601 UTCタイムスタンプまたは `null` です（リセット時刻を過ぎたウィンドウは除外されます）。
- スナップショットは、上流レスポンスヘッダーの受動的な取得、ダッシュボードのクォータチェック、バックグラウンドのスナップショットポーラー（重み付け戦略とコンボのメンバーに対して実行）によってメモリ上に蓄積されます。`stale` は、有効なウィンドウがない場合（スナップショットがない、期限切れ、プラン情報のみの場合を含む）、または最新ウィンドウの `observedAt` が15分以上前の場合に `true` になります。

### ダッシュボードの使用量エンドポイント（セッション / ローカルCLI認証）

`/api/usage/*` 配下のダッシュボード使用量ルート（`/api/usage/stats`、`/api/usage/logs`、`/api/usage/export` など）と `/api/home/quota` は、ダッシュボードにサインインしたセッションのCookieまたはローカルCLIトークンで認証するダッシュボードAPIです。ゲートウェイのBearer APIキーは受け付けません。`/api/quota` や `/api/usage` というルートは存在せず、マッピングされていない `/api/*` パスは `403 LOCAL_ONLY` で拒否されます（フェイルクローズ）。

### 使用履歴のエクスポート

統計ページ（概要タブ）のエクスポートボタンは、現在の期間（カスタム範囲を含む）を、有効なワークスペース/メンバー/APIキーのフィルターを適用した状態でダウンロードします。同じダウンロードは直接取得することもできます:

```bash
GET http://localhost:20128/api/usage/export?period=7d&format=csv&granularity=day
```

- `period`: 名前付きの期間（`today`、`24h`、`7d`、`30d`、`60d`、`90d`、`all`）、または `custom` と、両端を含むローカル日付 `YYYY-MM-DD` で指定する `from`/`to`（最大366日）。
- `format`: `csv`（デフォルト。`json` の場合はJSON配列）。レスポンスはストリーミングされ、ファイルダウンロード（`tokenhop-usage-<range>-<granularity>.csv|json`）として送信されます。
- `granularity`: `day`（デフォルト）は日次ロールアップから、日 × プロバイダー/モデル/アカウント/APIキー/エンドポイントごとに1行を出力します（`today`/`24h` ではカードと一致するようリクエストごとの履歴から集計します）。`request` は保存されたリクエスト履歴から、任意の期間またはカスタム範囲でリクエストごとに1行を出力します。履歴の保持はオプトインのため、有効にしている場合は、削除済みの日のリクエスト行が欠けることがあります。日次の行はロールアップから作られるため影響を受けません。
- `bom`: `1` を指定するとCSV出力の先頭にUTF-8のバイトオーダーマークを付け、Windows版Excelが非ASCIIのモデル名、アカウント名、キー名を正しく読み込めるようにします（エクスポートメニューの **CSV for Excel** 項目はこれを設定します）。デフォルトの `0`/未指定ではBOMなしのプレーンなRFC 4180です。`format=csv` でのみ有効で、それ以外の値は400を返します。

列: タイムスタンプ（または日付）、プロバイダー、モデル、アカウント、アカウントID、APIキー名、マスク済みAPIキー、エンドポイント、プロンプト/補完/キャッシュのトークン数、コスト、ステータス（リクエスト行）、トークンセーバーの推定値（`saved_tokens_est`: リクエスト行ではリクエストごと、日次の行ではそのグループのその日の節約量の合計なので、リクエスト履歴の削除後も残ります）。生のAPIキーがエクスポートされることはなく、キー名とマスクされたプレフィックスのみが出力されます。`format`、`granularity`、`period`、`bom` や日付範囲が無効な場合は400を返します。他の使用量エンドポイントと同じサインインとワークスペースの範囲制限が適用されます。

ヘッダー名は安定した機械可読の契約です。ダッシュボードの言語に関係なく英語の `snake_case`（`date`、`timestamp`、`prompt_tokens`、`api_key_masked` など）なので、エクスポートを読み込むスクリプトやスプレッドシートはUIの言語を変えても動作し続けます。CSVの区切り文字は常にカンマです。`;` を想定するロケールでは、Excelの **データ → テキストまたはCSVから** でファイルをインポートし、区切り文字にカンマを選んでください。

---

## トラブルシューティング

**問題: クォータが0%を表示するがリクエストが失敗**

**解決策:**

1. プロバイダー接続を確認 (Dashboard → Providers)
2. APIキーが有効か確認
3. プロバイダーがダウンしているか確認 (ステータスページ)
4. OAuthプロバイダーを再接続してみる

**問題: コスト見積もりが正しくない**

**解決策:**

1. Dashboard → Settings → Pricing
2. プロバイダーごとの料金が現在のレートと一致するか確認
3. プロバイダーがレートを変更した場合は料金を更新
4. 不一致が続く場合はサポートに連絡

**問題: リセット時間が更新されない**

**解決策:**

1. ダッシュボードを更新 (F5)
2. システム時刻が正しいか確認
3. タイムゾーン設定を確認
4. 問題が続く場合はtokenhopを再起動

**問題: アラートが受信されない**

**解決策:**

1. Dashboard → Settings → Alerts
2. メールアドレスが正しいか確認
3. スパムフォルダを確認
4. 通知をテスト (Send Testボタン)

---

## 関連

- [スマートルーティング](./smart-routing.md) - クォータに基づく自動フォールバック
- [コンボ](./combos.md) - カスタムフォールバックチェーンを作成
