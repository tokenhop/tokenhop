# Plan: guide tools catch up with the custom cards

YAN-623 (last open child of YAN-616), target v1.1.0, GitHub #719. No backport,
no switch: guide text and one card only, nothing half-built.

Already done by YAN-641: endpoint picker (incl. Tailscale) and the shared key
placeholder in `DefaultToolCard`.

## Upstream (checked 2026-10-03)

- Amp: no `OPENAI_*` env vars or `--model`; gateways go through Settings → Model
  Routing → Custom URL (`chat-completions`). <https://ampcode.com/docs/customize/model-routing>
- Qwen Code: `modelProviders.openai[]` + `security.auth.selectedType` + `model.name`.
- Continue: `~/.continue/config.yaml`; `config.json` is deprecated.
- Roo: provider "OpenAI Compatible" (Base URL, API Key, Model ID).
- Cursor: calls the base URL from Cursor's servers; Tailscale here is Funnel
  (public), so it qualifies like Tunnel.
- Devin: `devin acp` (agent type only via `CLI_DEVIN_AGENT_TYPE`).

## Changes

1. `DefaultToolCard.js`: Tailscale counts as external for `canShowGuide` and the
   `cloudCheck` note; `error` note → `err` callout; tool-level `docsUrl` link;
   `modelAliases` passed to `ModelSelectModal`.
2. `cliTools.js`: Cursor labels/note; Roo → OpenAI Compatible; Continue YAML;
   Amp Model Routing steps, real docs URL, no stale ids/aliases; Qwen
   `modelProviders` snippet, drop unused `defaultModels`/`modelAliases`
   (unprefixed ids aren't routable); Devin note (plain `devin acp`, gateway host,
   `CLI_DEVIN_BIN` / `CLI_DEVIN_AGENT_TYPE` / `DEVIN_MCP_SERVERS`).

## Not done

- No test: data-only guide text; existing suite covers the card imports.
