# Cline Integration

Integrate tokenhop with Cline VSCode extension to route your AI requests through tokenhop's intelligent routing system.

## Prerequisites

- Visual Studio Code installed
- Cline extension installed from VSCode marketplace
- tokenhop running locally, or on a server / tunnel you control
- API key from tokenhop dashboard

## Setup

### 1. Open Cline Settings

1. Open Visual Studio Code
2. Open the Cline extension panel (click the Cline icon in the sidebar)
3. Click the **Settings** icon (gear icon) in the Cline panel

### 2. Select API Provider

1. In the Cline settings, find **API Provider** dropdown
2. Select **Ollama** from the list
   - Note: We use Ollama provider type because it's compatible with OpenAI-style APIs

### 3. Configure Base URL

Set the base URL to your tokenhop endpoint:

**For Local tokenhop:**

```
http://localhost:20128/v1
```

**For Remote tokenhop (your VPS or tunnel URL):**

```
https://<your-tokenhop-host>/v1
```

**Steps:**

1. In the **Base URL** field, enter your tokenhop endpoint
2. Make sure to include `/v1` at the end

### 4. Add API Key

1. In the **API Key** field, enter your tokenhop API key
2. You can find your API key in the tokenhop dashboard under **Settings → API Keys**
3. The key should start with `sk-`

### 5. Select Model

1. In the **Model** dropdown, you can either:
   - Select from available models (if Cline auto-detects them)
   - Manually enter the model name from your tokenhop configuration

2. Common model names:
   - `gpt-4`
   - `gpt-4o`
   - `claude-opus-4-5`
   - `claude-sonnet-4-5`
   - `gemini-2.0-flash`

### 6. Save Configuration

Click **Save** or close the settings panel. Cline will automatically save your configuration.

## Configuration Example

Your Cline settings should look like this:

```
API Provider: Ollama
Base URL: http://localhost:20128/v1
API Key: sk-xxxxxxxxxxxxxxxx
Model: gpt-4
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

### Chat with AI

1. Open the Cline panel in VSCode
2. Type your message in the chat input
3. Press Enter to send
4. Cline will use tokenhop to process your request

### Code Generation

1. Ask Cline to generate code: "Create a React component for a login form"
2. Cline will generate code using tokenhop
3. Review and accept the generated code

### Code Explanation

1. Select code in your editor
2. Ask Cline: "Explain this code"
3. Get AI-powered explanations through tokenhop

### File Operations

1. Ask Cline to create, modify, or delete files
2. Cline will use tokenhop to understand context and make changes
3. Review changes before accepting

## Troubleshooting

### "Connection Failed" Error

1. Verify tokenhop is running: `curl http://localhost:20128/health`
2. Check that the base URL is correct and includes `/v1`
3. Ensure no firewall is blocking port 20128
4. Try restarting VSCode

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

### Cline Not Responding

1. Check the Cline output panel for error messages
2. Verify your tokenhop instance is running and healthy
3. Try reloading VSCode window (Cmd/Ctrl + Shift + P → "Reload Window")
4. Check tokenhop logs for any errors

## Advanced Configuration

### Using a Remote Endpoint

To use a tokenhop instance on your VPS, or exposed with the Endpoint page's Cloudflare tunnel or Tailscale Funnel, instead of localhost:

1. In Cline settings, set Base URL to: `https://<your-tokenhop-host>/v1`
2. Use an API key from that instance's dashboard and turn on **Require API key** for any public URL
3. Ensure the instance is running and reachable at that URL

### Multiple Models

You can quickly switch between models:

1. Open Cline settings
2. Change the **Model** field to a different model
3. Save and continue chatting with the new model

### Custom Timeout

If you experience timeout issues with large requests:

1. Open VSCode settings (Cmd/Ctrl + ,)
2. Search for "Cline timeout"
3. Increase the timeout value (default is usually 30 seconds)

## Best Practices

1. **Use Appropriate Models**: Choose faster models (like Haiku or Flash) for simple tasks, and more powerful models (like Opus or GPT-4) for complex tasks
2. **Monitor Usage**: Check tokenhop dashboard for usage statistics and costs
3. **Context Management**: Keep your conversations focused to reduce token usage
4. **Model Switching**: Switch models based on task complexity to optimize cost and performance
5. **API Key Security**: Never commit your API key to version control

## Integration with tokenhop Features

### Model Routing

tokenhop automatically routes your requests to the best available provider based on:

- Model availability
- Provider health status
- Cost optimization
- Load balancing

### Fallback Support

If a provider fails, tokenhop automatically falls back to alternative providers configured in your dashboard.

### Usage Tracking

Monitor your Cline usage through tokenhop dashboard:

- Total requests
- Token usage
- Cost per model
- Provider distribution
