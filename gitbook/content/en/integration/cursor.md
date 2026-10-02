# Cursor Integration

Integrate tokenhop with Cursor IDE to route your AI requests through tokenhop's intelligent routing system.

## Prerequisites

- Cursor IDE installed
- Cursor Pro account (required for custom API endpoints)
- tokenhop reachable over public HTTPS (see [Expose tokenhop to Cursor](#expose-tokenhop-to-cursor))
- API key from tokenhop dashboard

## ⚠️ Important Notes

> **Public URL Required**: Cursor sends requests from its own servers, so it can't reach `localhost`. Give it a public HTTPS URL for your own tokenhop instance, such as the Cloudflare tunnel or Tailscale Funnel URL from the dashboard's **Endpoint** page, or a VPS deployment. tokenhop has no hosted gateway.

> **Cursor Pro Required**: This feature requires a Cursor Pro account to use custom API endpoints.

## Setup

### 1. Open Cursor Settings

1. Open Cursor IDE
2. Go to **Settings** (Cmd/Ctrl + ,)
3. Navigate to **Models** section

### 2. Enable OpenAI API

1. Find the **OpenAI API key** option
2. Enable the toggle to activate custom API configuration

### 3. Configure Base URL

Set the base URL to your tokenhop instance's public URL, followed by `/v1`:

```
https://<your-tokenhop-host>/v1
```

**Steps:**

1. In the Models settings, locate the **Base URL** field
2. Enter: `https://<your-tokenhop-host>/v1`
3. Click **Save**

### 4. Add API Key

1. In the **API Key** field, enter your tokenhop API key
2. You can find your API key in the tokenhop dashboard under **Settings → API Keys**
3. Click **Save**

### 5. Add Custom Model

1. Click **View All Models** button
2. Click **Add Custom Model**
3. Enter the model name from your tokenhop configuration (e.g., `gpt-4`, `claude-opus-4-5`, etc.)
4. Click **Add**

### 6. Select Model

1. In the Cursor chat interface, click the model selector dropdown
2. Choose your custom model from the list
3. Start using tokenhop with Cursor!

## Configuration Example

Your Cursor settings should look like this:

```
OpenAI API: ✓ Enabled
Base URL: https://<your-tokenhop-host>/v1
API Key: sk-xxxxxxxxxxxxxxxx
Custom Models: gpt-4, claude-opus-4-5, gemini-2.0-flash
```

## Available Models

You can use any model configured in your tokenhop dashboard. Common examples:

| Model Name          | Provider  | Description       |
| ------------------- | --------- | ----------------- |
| `gpt-4`             | OpenAI    | GPT-4 Turbo       |
| `gpt-4o`            | OpenAI    | GPT-4 Optimized   |
| `claude-opus-4-5`   | Anthropic | Claude Opus 4.5   |
| `claude-sonnet-4-5` | Anthropic | Claude Sonnet 4.5 |
| `gemini-2.0-flash`  | Google    | Gemini 2.0 Flash  |

## Usage

### Chat Interface

1. Open Cursor chat (Cmd/Ctrl + L)
2. Select your model from the dropdown
3. Start chatting with AI through tokenhop

### Inline Code Generation

1. Select code in your editor
2. Press Cmd/Ctrl + K
3. Enter your prompt
4. Cursor will use tokenhop to generate code

### Code Explanation

1. Select code in your editor
2. Press Cmd/Ctrl + L
3. Ask "Explain this code"
4. Get AI-powered explanations through tokenhop

## Troubleshooting

### "Invalid API Key" Error

1. Verify your API key in tokenhop dashboard
2. Make sure you copied the entire key including the `sk-` prefix
3. Check that the API key has not expired
4. Try regenerating a new API key

### "Model Not Found" Error

1. Verify the model name matches exactly with your tokenhop configuration
2. Check that the provider connection is active in tokenhop dashboard
3. Ensure the model is available in your connected providers
4. Try using the full model name (e.g., `openai/gpt-4` instead of `gpt-4`)

### Connection Issues

1. Verify the Base URL is your public tokenhop URL followed by `/v1` (for example `https://<your-tokenhop-host>/v1`)
2. Open that URL's `/v1/models` in a browser or with `curl` to confirm it is reachable from the internet
3. Ensure your tunnel (Cloudflare or Tailscale Funnel) or server is still running
4. Try disabling VPN or proxy if enabled

### Localhost Not Working

> **Remember**: Cursor does not support localhost endpoints. Expose your local tokenhop instance as described below and use that public URL.

## Expose tokenhop to Cursor

If you're running tokenhop locally and want to use it with Cursor:

1. Open the tokenhop dashboard → **Endpoint**
2. Enable the **Cloudflare tunnel** (a `*.trycloudflare.com` URL) or **Tailscale Funnel** (needs Tailscale installed and logged in)
3. Copy the public URL and use it, followed by `/v1`, as the Base URL in Cursor
4. Turn on **Require API key** so only your keys can use the public URL

Alternatively, run tokenhop on a server with a public domain and HTTPS (see [Cloud (VPS/Docker)](/en/deployment/cloud)), or put it behind your own reverse proxy or tunnel.

## Best Practices

1. **Use Model Aliases**: Create short aliases for frequently used models in tokenhop
2. **Monitor Usage**: Check tokenhop dashboard for usage statistics and costs
3. **Rotate API Keys**: Regularly rotate your API keys for security
4. **Test Models**: Try different models to find the best one for your use case
