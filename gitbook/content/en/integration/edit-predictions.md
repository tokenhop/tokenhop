# Edit Predictions (Inline Completions)

Route inline code completion (fill-in-the-middle) clients through the tokenhop gateway.

## Prerequisites

- A provider connected in the dashboard (**Providers**) with an API key (**Endpoint**). Define it in your shell as `TOKENHOP_API_KEY` and keep the value out of files and screenshots — every config below references the env var name, never a real key.
- A combo named `prediction-fast`, or address a small fast non-reasoning chat model directly as `<provider-alias>/<model>`. The gateway translates FIM requests into chat completions, so the combo members should be fast chat models served through the adapter, native Codestral, or self-hosted FIM completions nodes — not reasoning models.
- Tune the combo for latency: use the fastest combo strategy: untried models are explored first, then recent latency ranks members; failed attempts count as slow. Members are tried sequentially. Avoid fusion, which queries multiple models in parallel.

## Gateway endpoints

| Endpoint                   | Used by                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `POST /v1/completions`     | Zed (`open_ai_compatible_api`), minuet (`openai_fim_compatible`), lsp-ai (`open_ai`) |
| `POST /v1/fim/completions` | minuet (`codestral`)                                                                 |
| `POST /infill`             | llama.vim                                                                            |

Gateway base URL is `http://localhost:20128`. Authenticate with `Authorization: Bearer $TOKENHOP_API_KEY` (the dashboard API key). The examples below use the env var name `TOKENHOP_API_KEY`, never a real key value.

## Zed

Zed sends `{"model", "prompt", "max_tokens", "stop"}` to the full URL in `api_url`. Settings (`settings.json`):

```json
{
  "edit_predictions": {
    "provider": "open_ai_compatible_api",
    "open_ai_compatible_api": {
      "api_url": "http://localhost:20128/v1/completions",
      "model": "prediction-fast",
      "prompt_format": "qwen",
      "max_output_tokens": 128,
      "prediction_debounce": 150
    }
  }
}
```

Notes:

- `api_url` must be the full endpoint URL, not the base URL.
- Zed reads the key from the `ZED_OPEN_AI_COMPATIBLE_EDIT_PREDICTION_API_KEY` env var (env var name, not key value). Fully quit Zed, then launch it from a shell with the variable set so it is visible:

```bash
export ZED_OPEN_AI_COMPATIBLE_EDIT_PREDICTION_API_KEY="$TOKENHOP_API_KEY"
zed
```

- `prompt_format` must be set explicitly for a combo (there is no model name to infer from). It shapes the request prompt as a gateway-parseable FIM template (`qwen`, `star_coder`, `code_llama`, `deepseek_coder`, `codestral`, or `glm`); the gateway chat adapter parses these markers to find the cursor. Avoid `zeta`/`sweep` and other Zed formats the gateway does not parse. This is a client-side template choice — combos have no `prompt_format` setting.

Reference: <https://zed.dev/docs/ai/edit-prediction>

## minuet-ai.nvim

Use the `openai_fim_compatible` provider. `api_key` takes the env var _name_, not the value:

```lua
require('minuet').setup {
    provider = 'openai_fim_compatible',
    n_completions = 1,
    context_window = 512,
    provider_options = {
        openai_fim_compatible = {
            api_key = 'TOKENHOP_API_KEY',
            name = 'tokenhop',
            end_point = 'http://localhost:20128/v1/completions',
            model = 'prediction-fast',
            stream = true,
            optional = {
                max_tokens = 128,
            },
            template = {
                prompt = function(context_before_cursor, context_after_cursor, _)
                    return '<|fim_prefix|>'
                        .. context_before_cursor
                        .. '<|fim_suffix|>'
                        .. context_after_cursor
                        .. '<|fim_middle|>'
                end,
                suffix = false,
            },
        },
    },
}
```

`stream = true` is optional (shows first tokens sooner; disable if the client has no streaming support) and `optional.max_tokens = 128` caps latency. The `<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` markers must be a gateway-parseable template (shown: `qwen`); the gateway chat adapter uses them to locate the cursor. Only native self-hosted FIM completions nodes pass the template through to the upstream model — the combo itself has no `prompt_format` setting, so match the markers to the upstream node when using one.

Reference: <https://github.com/milanglacier/minuet-ai.nvim> (README and recipes).

### Codestral variant

minuet's `codestral` provider defaults to `https://codestral.mistral.ai/v1/fim/completions`. Point it at the gateway instead (note `provider = 'codestral'`, not `openai_fim_compatible`):

```lua
require('minuet').setup {
    provider = 'codestral',
    n_completions = 1,
    provider_options = {
        codestral = {
            api_key = 'TOKENHOP_API_KEY',
            end_point = 'http://localhost:20128/v1/fim/completions',
            model = 'prediction-fast',
            stream = true,
            optional = {
                max_tokens = 128,
            },
        },
    },
}
```

Already configured with another provider? Run `:Minuet change_provider codestral` instead of re-running setup.

## cmp-ai

The OpenAI backend accepts a `url` override in `provider_options` (default `https://api.openai.com/v1/chat/completions`) and reads the key from `OPENAI_API_KEY`:

```lua
local cmp_ai = require('cmp_ai.config')

cmp_ai:setup({
  max_lines = 100,
  provider = 'OpenAI',
  provider_options = {
    model = 'prediction-fast',
    url = 'http://localhost:20128/v1/chat/completions',
  },
  run_on_every_keystroke = false,
})
```

```bash
export OPENAI_API_KEY="$TOKENHOP_API_KEY"
```

This sends before/after context wrapped in instruction tags over `/v1/chat/completions` — a chat prompt, not true FIM. Expect chat-style latency and completions.

The Codestral backend hardcodes `https://codestral.mistral.ai/v1/fim/completions` and reads only `CODESTRAL_API_KEY`; it has no URL override, so it cannot point at the gateway.

Reference: <https://github.com/tzachar/cmp-ai> (README and `lua/cmp_ai/backends/openai.lua`, `codestral.lua`).

## lsp-ai

lsp-ai's `open_ai` backend posts `{model, max_tokens, prompt}` to `completions_endpoint` and reads `choices[0].text`, which matches the gateway `/v1/completions` response. Full `initializationOptions` example:

```json
{
  "memory": { "file_store": {} },
  "models": {
    "gateway-fim": {
      "type": "open_ai",
      "completions_endpoint": "http://localhost:20128/v1/completions",
      "model": "prediction-fast",
      "auth_token_env_var_name": "TOKENHOP_API_KEY"
    }
  },
  "completion": {
    "model": "gateway-fim",
    "parameters": {
      "fim": {
        "start": "<|fim_prefix|>",
        "middle": "<|fim_suffix|>",
        "end": "<|fim_middle|>"
      },
      "max_tokens": 128
    }
  }
}
```

`auth_token_env_var_name` is the env var name holding the dashboard API key. The FIM markers must be a gateway-parseable template (shown: `qwen`); only native self-hosted nodes pass them through, the combo itself has no format setting.

lsp-ai is community-maintained and its config structs reject unknown fields, so if this example is rejected after an lsp-ai update, re-check the shapes in `crates/lsp-ai/src/config.rs` and `crates/lsp-ai/src/transformer_backends/open_ai/mod.rs`.

For lsp-ai's `mistral_fim` backend, use `fim_endpoint: "http://localhost:20128/v1/fim/completions"` instead. That endpoint returns `choices[].message.content`, which this backend expects. The `open_ai` example above uses `/v1/completions`, whose response contains `choices[].text`; do not interchange these endpoints.

Reference: <https://github.com/SilasMarvin/lsp-ai> (`crates/lsp-ai/src/config.rs`, `crates/lsp-ai/src/transformer_backends/open_ai/mod.rs`, `mistral_fim.rs`).

## llama.vim

llama.vim posts to llama.cpp's `/infill` endpoint. The model key is `model_fim`:

```vim
let g:llama_config = {
\   'endpoint_fim': 'http://localhost:20128/infill',
\   'model_fim': 'prediction-fast',
\   'api_key': getenv('TOKENHOP_API_KEY'),
\   'n_predict': 128,
\   'fim_debounce_ms': 100,
\ }
```

`fim_debounce_ms` controls retry delay while a FIM request is already running, not idle-typing debounce.

Reference: <https://github.com/ggml-org/llama.vim>

## Not supported

GitHub Copilot and Supermaven inline prediction clients have no custom-URL setting and cannot point at the gateway. This is separate from Copilot Chat extensions that let you add a third-party OpenAI-compatible chat model: those use the chat endpoint (`/v1/chat/completions`), not inline prediction.
