# Cursor統合

tokenhopをCursor IDEと統合し、AIリクエストをtokenhopのインテリジェントルーティングシステム経由でルーティングします。

## 前提条件

- Cursor IDEがインストール済み
- Cursor Proアカウント (カスタムAPIエンドポイントに必要)
- 公開HTTPS経由でtokenhopにアクセスできること (下記の「tokenhopをCursorに公開」を参照)
- tokenhopダッシュボードからのAPIキー

## ⚠️ 重要な注意点

> **公開URLが必要**: Cursorは独自のサーバーからリクエストを送るため、`localhost` には到達できません。ダッシュボードの**Endpoint**ページにあるCloudflareトンネルやTailscale FunnelのURL、またはVPSへのデプロイなど、自分のtokenhopインスタンスの公開HTTPS URLを指定してください。tokenhopにはホスト型ゲートウェイはありません。

> **Cursor Proが必要**: この機能はカスタムAPIエンドポイントを使用するためにCursor Proアカウントが必要です。

## セットアップ

### 1. Cursor設定を開く

1. Cursor IDEを開く
2. **Settings** へ移動 (Cmd/Ctrl + ,)
3. **Models** セクションへ移動

### 2. OpenAI APIを有効化

1. **OpenAI API key** オプションを見つける
2. トグルを有効にしてカスタムAPI設定を有効化

### 3. Base URLを設定

Base URLを、tokenhopインスタンスの公開URLに `/v1` を続けたものに設定:

```
https://<your-tokenhop-host>/v1
```

**手順:**

1. Models設定で **Base URL** フィールドを見つける
2. 入力: `https://<your-tokenhop-host>/v1`
3. **Save** をクリック

### 4. APIキーを追加

1. **API Key** フィールドにtokenhop APIキーを入力
2. APIキーはtokenhopダッシュボードの **Settings → API Keys** で確認できます
3. **Save** をクリック

### 5. カスタムモデルを追加

1. **View All Models** ボタンをクリック
2. **Add Custom Model** をクリック
3. tokenhop設定からモデル名を入力 (例: `gpt-4`、`claude-opus-4-5` など)
4. **Add** をクリック

### 6. モデルを選択

1. Cursorチャットインターフェイスでモデルセレクタードロップダウンをクリック
2. リストからカスタムモデルを選択
3. Cursorでtokenhopを使い始める!

## 設定例

Cursor設定は次のようになります:

```
OpenAI API: ✓ Enabled
Base URL: https://<your-tokenhop-host>/v1
API Key: sk-xxxxxxxxxxxxxxxx
Custom Models: gpt-4, claude-opus-4-5, gemini-2.0-flash
```

## 利用可能なモデル

tokenhopダッシュボードで設定されたモデルを使用できます。一般的な例:

| モデル名            | プロバイダー | 説明              |
| ------------------- | ------------ | ----------------- |
| `gpt-4`             | OpenAI       | GPT-4 Turbo       |
| `gpt-4o`            | OpenAI       | GPT-4 Optimized   |
| `claude-opus-4-5`   | Anthropic    | Claude Opus 4.5   |
| `claude-sonnet-4-5` | Anthropic    | Claude Sonnet 4.5 |
| `gemini-2.0-flash`  | Google       | Gemini 2.0 Flash  |

## 使用法

### チャットインターフェイス

1. Cursorチャットを開く (Cmd/Ctrl + L)
2. ドロップダウンからモデルを選択
3. tokenhop経由でAIとチャット開始

### インラインコード生成

1. エディタでコードを選択
2. Cmd/Ctrl + Kを押す
3. プロンプトを入力
4. Cursorはtokenhopを使用してコードを生成

### コード説明

1. エディタでコードを選択
2. Cmd/Ctrl + Lを押す
3. 「Explain this code」と質問
4. tokenhop経由でAIによる説明を取得

## トラブルシューティング

### 「Invalid API Key」エラー

1. tokenhopダッシュボードでAPIキーを確認
2. `sk-` プレフィックスを含むキー全体をコピーしたか確認
3. APIキーが期限切れでないか確認
4. 新しいAPIキーを再生成してみる

### 「Model Not Found」エラー

1. モデル名がtokenhop設定と正確に一致するか確認
2. tokenhopダッシュボードでプロバイダー接続がアクティブか確認
3. 接続されたプロバイダーでモデルが利用可能か確認
4. フルモデル名を使用してみる (例: `gpt-4` の代わりに `openai/gpt-4`)

### 接続の問題

1. Base URLがtokenhopの公開URLに `/v1` を続けたものであることを確認 (例: `https://<your-tokenhop-host>/v1`)
2. そのURLの `/v1/models` をブラウザまたは `curl` で開き、インターネットから到達可能かを確認
3. トンネル (CloudflareまたはTailscale Funnel) またはサーバーがまだ稼働中であることを確認
4. VPNまたはプロキシが有効な場合は無効化してみる

### Localhostが動作しない

> **覚えておいてください**: Cursorはlocalhostエンドポイントをサポートしません。下記の手順でローカルのtokenhopインスタンスを公開し、その公開URLを使用してください。

## tokenhopをCursorに公開

ローカルでtokenhopを実行し、Cursorで使用したい場合:

1. tokenhopダッシュボード → **Endpoint** を開く
2. **Cloudflareトンネル** (`*.trycloudflare.com` のURL) または **Tailscale Funnel** (Tailscaleのインストールとログインが必要) を有効にする
3. 公開URLをコピーし、末尾に `/v1` を付けたものをCursorのBase URLとして使用
4. **Require API key** を有効にして、自分のキーのみがその公開URLを使用できるようにする

あるいは、公開ドメインとHTTPSを持つサーバーでtokenhopを実行するか ([クラウド (VPS/Docker)](/ja/deployment/cloud)を参照)、独自のリバースプロキシやトンネルの背後に置きます。

## ベストプラクティス

1. **モデルエイリアスを使用**: tokenhopで頻繁に使うモデル用のショートエイリアスを作成
2. **使用量をモニター**: tokenhopダッシュボードで使用統計とコストを確認
3. **APIキーをローテーション**: セキュリティのためAPIキーを定期的にローテーション
4. **モデルをテスト**: ユースケースに最適なモデルを見つけるため、異なるモデルを試す
