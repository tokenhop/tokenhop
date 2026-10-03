import { ACTIVE } from "@/shared/brand";

// MITM Tools — IDE tools intercepted via MITM proxy
export const MITM_TOOLS = {
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    image: "/providers/antigravity.webp",
    color: "#4285F4",
    description: "Google Antigravity IDE with MITM",
    configType: "mitm",
    mitmDomain: "daily-cloudcode-pa.googleapis.com",
    modelAliases: [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.5-flash-low",
      "gemini-3-flash-agent",
      "gemini-3.5-flash-extra-low",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      "gemini-3-flash",
    ],
    defaultModels: [
      {
        id: "gemini-3.8-flash-high",
        name: "Gemini 3.8 Flash (High)",
        alias: "gemini-3.8-flash-high",
      },
      {
        id: "gemini-3.8-flash-medium",
        name: "Gemini 3.8 Flash (Medium)",
        alias: "gemini-3.8-flash-medium",
      },
      { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", alias: "gemini-3.8-flash-low" },
      {
        id: "gemini-3.7-flash-high",
        name: "Gemini 3.7 Flash (High)",
        alias: "gemini-3.7-flash-high",
      },
      {
        id: "gemini-3.7-flash-medium",
        name: "Gemini 3.7 Flash (Medium)",
        alias: "gemini-3.7-flash-medium",
      },
      { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", alias: "gemini-3.7-flash-low" },
      {
        id: "gemini-3.6-flash-high",
        name: "Gemini 3.6 Flash (High)",
        alias: "gemini-3.6-flash-high",
      },
      {
        id: "gemini-3.6-flash-medium",
        name: "Gemini 3.6 Flash (Medium)",
        alias: "gemini-3.6-flash-medium",
      },
      { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", alias: "gemini-3.6-flash-low" },
      {
        id: "gemini-3.5-flash-low",
        name: "Gemini 3.5 Flash (Medium) / Default",
        alias: "gemini-3.5-flash-low",
        mandatory: true,
      },
      {
        id: "gemini-3-flash-agent",
        name: "Gemini 3.5 Flash (High)",
        alias: "gemini-3-flash-agent",
      },
      {
        id: "gemini-3.5-flash-extra-low",
        name: "Gemini 3.5 Flash (Low)",
        alias: "gemini-3.5-flash-extra-low",
      },
      { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", alias: "gemini-3.1-pro-low" },
      { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", alias: "gemini-pro-agent" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", alias: "claude-sonnet-4-6" },
      {
        id: "claude-opus-4-6-thinking",
        name: "Claude Opus 4.6 (Thinking)",
        alias: "claude-opus-4-6-thinking",
      },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", alias: "gpt-oss-120b-medium" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash (Command)", alias: "gemini-3-flash" },
    ],
  },
  kiro: {
    id: "kiro",
    name: "Kiro",
    image: "/providers/kiro.webp",
    color: "#FF6B00",
    description: "Kiro IDE with MITM",
    configType: "mitm",
    mitmDomain: "runtime.us-east-1.kiro.dev",
    defaultModels: [
      // Kiro's agent/"vibe" mode sends modelId "auto" for the main turn and "simple-task"
      // for background sub-tasks (verified via MITM request dump of generateAssistantResponse).
      // Both need a mappable slot — otherwise getMappedModel returns null and the chat call
      // is passed through to AWS instead of being routed to the chosen provider.
      { id: "auto", name: "Auto (Kiro Agent)", alias: "auto" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", alias: "claude-sonnet-5" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", alias: "claude-sonnet-4.5" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", alias: "claude-sonnet-4" },
      { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", alias: "claude-haiku-4.5" },
      { id: "deepseek-3.2", name: "DeepSeek 3.2", alias: "deepseek-3.2" },
      { id: "minimax-m2.1", name: "MiniMax M2.1", alias: "minimax-m2.1" },
      {
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        alias: "gpt-5.6-sol",
        contextLength: 272000,
        rateMultiplier: 2.4,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        alias: "gpt-5.6-terra",
        contextLength: 272000,
        rateMultiplier: 1.2,
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT 5.6 Luna",
        alias: "gpt-5.6-luna",
        contextLength: 272000,
        rateMultiplier: 0.6,
      },
      { id: "simple-task", name: "Qwen3 Coder Next", alias: "simple-task" },
    ],
  },
  // cursor: {
  //   id: "cursor",
  //   name: "Cursor",
  //   image: "/providers/cursor.webp",
  //   color: "#000000",
  //   description: "Cursor IDE with MITM",
  //   configType: "mitm",
  //   mitmDomain: "api2.cursor.sh",
  //   defaultModels: [
  //     { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", alias: "claude-sonnet-4-5" },
  //     { id: "claude-opus-4", name: "Claude Opus 4", alias: "claude-opus-4" },
  //     { id: "gpt-4o", name: "GPT-4o", alias: "gpt-4o" },
  //   ],
  // },
};

// CLI Tools configuration
export const CLI_TOOLS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    image: "/providers/claude.webp",
    color: "#D97757",
    description: "Anthropic Claude Code CLI",
    configType: "env",
    envVars: {
      baseUrl: "ANTHROPIC_BASE_URL",
      model: "ANTHROPIC_MODEL",
      opusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      sonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      fableModel: "ANTHROPIC_DEFAULT_FABLE_MODEL",
      haikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    },
    modelAliases: ["default", "sonnet", "opus", "fable", "haiku", "opusplan"],
    settingsFile: "~/.claude/settings.json",
    defaultModels: [
      {
        id: "fable",
        name: "Claude Fable",
        alias: "fable",
        envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL",
        defaultValue: "cc/claude-fable-5",
      },
      {
        id: "opus",
        name: "Claude Opus",
        alias: "opus",
        envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
        defaultValue: "cc/claude-opus-5",
      },
      {
        id: "sonnet",
        name: "Claude Sonnet",
        alias: "sonnet",
        envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
        defaultValue: "cc/claude-sonnet-5",
      },
      {
        id: "haiku",
        name: "Claude Haiku",
        alias: "haiku",
        envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        defaultValue: "cc/claude-haiku-4-5-20251001",
      },
    ],
  },
  openclaw: {
    id: "openclaw",
    name: "Open Claw",
    image: "/providers/openclaw.webp",
    color: "#FF6B35",
    description: "Open Claw AI assistant",
    configType: "custom",
  },
  codex: {
    id: "codex",
    name: "OpenAI Codex CLI / App",
    image: "/providers/codex.webp",
    color: "#10A37F",
    description: "OpenAI Codex CLI",
    configType: "custom",
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    image: "/providers/copilot.webp",
    color: "#1F6FEB",
    description: "GitHub Copilot in VS Code via 9Router extension", // legacy(9router): third-party extension name
    configType: "guide",
    docsUrl:
      "https://marketplace.visualstudio.com/items?itemName=hotrungnhan.9router-for-github-copilot", // legacy(9router): third-party extension name
    guideSteps: [
      {
        step: 1,
        title: "Install extension",
        desc: "In VS Code, open Extensions (Ctrl+Shift+X or Cmd+Shift+X), search for '9Router for GitHub Copilot' and click Install.", // legacy(9router): third-party extension name
      },
      {
        step: 2,
        title: "Configure server",
        desc: "Press Cmd+Shift+P (or Ctrl+Shift+P), run '9Router: Configure Server', then enter your server URL and API key:", // legacy(9router): third-party extension name
        value: "{{baseUrl}}",
        copyable: true,
      },
      {
        step: 3,
        title: "Select model in Copilot Chat",
        desc: "Open Copilot Chat, click the model picker at the bottom → 'Manage Models...' → check the 9Router models to use.", // legacy(9router): third-party extension name
      },
    ],
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    image: "/providers/opencode.webp",
    color: "#E87040",
    description: "OpenCode AI terminal assistant",
    configType: "custom",
  },
  cowork: {
    id: "cowork",
    name: "Claude Cowork",
    image: "/providers/claude.webp",
    color: "#D97757",
    description: "Claude Desktop Cowork (third-party inference)",
    configType: "custom",
  },
  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    image: "/providers/hermes.webp",
    color: "#8B5CF6",
    description: "Nous Research self-improving AI agent",
    configType: "custom",
  },
  droid: {
    id: "droid",
    name: "Factory Droid",
    image: "/providers/droid.webp",
    color: "#00D4FF",
    description: "Factory Droid AI assistant",
    configType: "custom",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    image: "/providers/cursor.webp",
    color: "#000000",
    description: "Cursor AI code editor",
    configType: "guide",
    requiresExternalUrl: true,
    notes: [
      { type: "warning", text: "Requires Cursor Pro account to use this feature." },
      {
        type: "cloudCheck",
        text: "Cursor calls the base URL from its own servers, so a local or tailnet-only address won't work. Enable Tunnel, Tailscale (Funnel) or Cloud in Settings.",
      },
    ],
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Cursor Settings → Models" },
      {
        step: 2,
        title: "API key",
        desc: 'Paste it into "OpenAI API Key" and turn the key on.',
        type: "apiKeySelector",
      },
      {
        step: 3,
        title: "Base URL",
        desc: 'Turn on "Override OpenAI Base URL" and paste:',
        value: "{{baseUrl}}",
        copyable: true,
      },
      { step: 4, title: "Add custom model", desc: "Add the model id below to the model list." },
      { step: 5, title: "Select model", type: "modelSelector" },
    ],
  },
  cline: {
    id: "cline",
    name: "Cline",
    image: "/providers/cline.webp",
    color: "#5B9BD5",
    description: "Cline AI coding assistant",
    configType: "custom",
  },
  kilo: {
    id: "kilo",
    name: "Kilo Code",
    image: "/providers/kilocode.webp",
    color: "#FF6B6B",
    description: "Kilo Code AI assistant",
    configType: "custom",
  },
  roo: {
    id: "roo",
    name: "Roo",
    image: "/providers/roo.webp",
    color: "#FF6B6B",
    description: "Roo AI assistant",
    configType: "guide",
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Open the Roo Code settings panel." },
      { step: 2, title: "Select provider", desc: 'API Provider → "OpenAI Compatible"' },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "API key", type: "apiKeySelector" },
      { step: 5, title: "Model ID", type: "modelSelector" },
    ],
  },
  continue: {
    id: "continue",
    name: "Continue",
    image: "/providers/continue.webp",
    color: "#7C3AED",
    description: "Continue AI assistant",
    configType: "guide",
    guideSteps: [
      {
        step: 1,
        title: "Open config",
        desc: "Open ~/.continue/config.yaml (Windows: %USERPROFILE%\\.continue\\config.yaml).",
      },
      { step: 2, title: "API key", type: "apiKeySelector" },
      { step: 3, title: "Select model", type: "modelSelector" },
      {
        step: 4,
        title: "Add model config",
        desc: "Add this entry to the models list:",
      },
    ],
    codeBlock: {
      language: "yaml",
      code: `models:
  - name: {{model}}
    provider: openai
    model: {{model}}
    apiBase: {{baseUrl}}
    apiKey: {{apiKey}}
    roles: [chat, edit, apply]`,
    },
  },
  amp: {
    id: "amp",
    name: "Amp CLI",
    image: "/providers/amp.webp",
    color: "#F97316",
    description: "Sourcegraph Amp coding assistant CLI",
    docsUrl: "https://ampcode.com/docs/customize/model-routing",
    configType: "guide",
    defaultCommand: "amp",
    notes: [
      {
        type: "info",
        text: `Amp reaches ${ACTIVE.name} through a custom URL connection in its model routing settings, then maps its models to ${ACTIVE.name} model ids.`,
      },
    ],
    guideSteps: [
      {
        step: 1,
        title: "Open model routing",
        desc: "ampcode.com → Settings → Model Routing, or run: amp config model-providers add",
      },
      {
        step: 2,
        title: "Add a custom URL connection",
        desc: 'Format "chat-completions", base URL:',
        value: "{{baseUrl}}",
        copyable: true,
      },
      { step: 3, title: "API key", type: "apiKeySelector" },
      { step: 4, title: "Select model", type: "modelSelector" },
      {
        step: 5,
        title: "Map models",
        desc: "Map the Amp model you want to route to this model id:",
        value: "{{model}}",
        copyable: true,
      },
    ],
  },
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    image: "/providers/qwen.webp",
    color: "#10B981",
    description: `Alibaba Qwen Code CLI — supports OpenAI, Anthropic & Gemini providers via ${ACTIVE.name}`,
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
    configType: "guide",
    defaultCommand: "qwen",
    notes: [
      {
        type: "info",
        text: `Qwen Code reads OpenAI-compatible providers from modelProviders in settings.json. ${ACTIVE.name} is added as an openai provider.`,
      },
      {
        type: "info",
        text: `Any model available in ${ACTIVE.name} can be used — not just Qwen models. Select from Qwen, Claude, Gemini, GPT, and more.`,
      },
      {
        type: "warning",
        text: "Config path: Linux/macOS ~/.qwen/settings.json • Windows %USERPROFILE%\\.qwen\\settings.json",
      },
      {
        type: "error",
        text: `Qwen OAuth free tier was discontinued on 2026-04-15. Use ${ACTIVE.name} with alicode/openrouter/anthropic/gemini providers instead.`,
      },
    ],
    guideSteps: [
      { step: 1, title: "Install Qwen Code", desc: "npm install -g @qwen-code/qwen-code" },
      { step: 2, title: "API key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select model", type: "modelSelector" },
      {
        step: 5,
        title: "Save config",
        desc: "Merge the JSON below into ~/.qwen/settings.json.",
      },
    ],
    codeBlock: {
      language: "json",
      code: `{
  "modelProviders": {
    "openai": [
      {
        "id": "{{model}}",
        "envKey": "OPENAI_API_KEY",
        "baseUrl": "{{baseUrl}}"
      }
    ]
  },
  "env": { "OPENAI_API_KEY": "{{apiKey}}" },
  "security": { "auth": { "selectedType": "openai" } },
  "model": { "name": "{{model}}" }
}`,
    },
  },
  "deepseek-tui": {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    image: "/providers/deepseek-tui.webp",
    color: "#4D6BFE",
    description: "DeepSeek terminal coding agent (Rust TUI)",
    docsUrl: "https://github.com/DeepSeek-TUI/DeepSeek-TUI",
    configType: "custom",
    defaultCommand: "deepseek",
    modelAliases: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    defaultModels: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        alias: "deepseek-v4-pro",
        defaultValue: "ds/deepseek-v4-pro",
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        alias: "deepseek-v4-flash",
        defaultValue: "ds/deepseek-v4-flash",
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek V3 Chat",
        alias: "deepseek-chat",
        defaultValue: "ds/deepseek-chat",
      },
    ],
    notes: [
      {
        type: "info",
        text: `DeepSeek TUI uses ~/.deepseek/config.toml for configuration. ${ACTIVE.name} will update the provider to 'openai' mode with your base_url, api_key, and model.`,
      },
      {
        type: "warning",
        text: "Config path: Linux/macOS ~/.deepseek/config.toml • Windows %USERPROFILE%\\.deepseek\\config.toml",
      },
    ],
  },
  jcode: {
    id: "jcode",
    name: "jcode",
    image: "/providers/jcode.webp",
    color: "#FF6B35",
    description: "High-performance Rust-based coding agent harness",
    configType: "custom",
    docsUrl: "https://github.com/1jehuang/jcode",
    notes: [
      {
        type: "info",
        text: "jcode is a Rust-based coding agent with semantic memory, multi-agent swarms, and extreme performance (27.8 MB RAM, 14ms boot).",
      },
      {
        type: "info",
        text: `Configure ${ACTIVE.slug} as an OpenAI-compatible provider to route all jcode requests through ${ACTIVE.slug}'s optimization layer.`,
      },
      {
        type: "warning",
        text: "Requires jcode installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
      },
    ],
    defaultModels: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        alias: "opus",
        defaultValue: "cc/claude-opus-5",
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        alias: "sonnet",
        defaultValue: "cc/claude-sonnet-4-6",
      },
      { id: "gpt-5.5", name: "GPT 5.5", alias: "gpt5", defaultValue: "cx/gpt-5.5" },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        alias: "gemini",
        defaultValue: "gemini/gemini-3.1-pro",
      },
    ],
  },
  "grok-build": {
    id: "grok-build",
    name: "Grok Build",
    image: "/providers/grok-cli.webp",
    color: "#1DA1F2",
    description: "xAI Grok Build TUI coding agent",
    configType: "custom",
    docsUrl: "https://x.ai/cli",
    defaultCommand: "grok",
    notes: [
      {
        type: "info",
        text: `Grok Build uses ~/.grok/config.toml. ${ACTIVE.name} writes a [model.${ACTIVE.clientConfigKey}] custom model and sets it as the default.`,
      },
      {
        type: "info",
        text: `Once the config is in place, run grok (or /model ${ACTIVE.clientConfigKey}) to use the routed model. Switch back anytime with /model grok-build.`,
      },
      {
        type: "warning",
        text: "Config path: Linux/macOS ~/.grok/config.toml • Windows %USERPROFILE%\\.grok\\config.toml",
      },
    ],
  },
  devin: {
    id: "devin",
    name: "Devin CLI",
    image: "/providers/devin-cli.webp",
    color: "#6366F1",
    description:
      "Cognition Devin CLI — local binary called by the Devin CLI provider via ACP/stdio",
    configType: "guide",
    installUrl: "https://cli.devin.ai",
    notes: [
      {
        type: "info",
        text: "This is a local dependency, not a routed CLI. The Devin CLI provider spawns `devin acp` (full agent, DEVIN_PERMISSION_MODE=bypass) and relays its output. Set CLI_DEVIN_AGENT_TYPE=summarizer for a tool-less, text-only agent.",
      },
      {
        type: "warning",
        text: `Install the Devin CLI and run \`devin auth login\` on the machine running the ${ACTIVE.name} gateway, not the one you browse from. Without it, the provider returns a spawn error on first request.`,
      },
      {
        type: "info",
        text: "Gateway env vars: CLI_DEVIN_BIN (binary path), CLI_DEVIN_AGENT_TYPE (agent type), DEVIN_MCP_SERVERS (JSON MCP servers for the agent).",
      },
    ],
    guideSteps: [
      {
        step: 1,
        title: "Install Devin CLI",
        desc: "Install via the official installer at cli.devin.ai.",
        docsUrl: "https://cli.devin.ai",
      },
      {
        step: 2,
        title: "Authenticate",
        desc: "Log in once so the binary stores its own credentials.",
      },
      {
        step: 3,
        title: "Use the provider",
        desc: "Pick any Devin CLI model under the Providers tab — no API key field needed.",
      },
    ],
    codeBlock: {
      language: "bash",
      code: `# Install Devin CLI (see https://cli.devin.ai for options)
devin auth login

# Verify detection (optional)
devin --version`,
    },
  },
  opendesign: {
    id: "opendesign",
    name: "OpenDesign",
    image: "/providers/opendesign.webp",
    color: "#7C3AED",
    description: "OpenDesign — claude.ai/design, open-sourced. An agent-native design skills pack.",
    docsUrl: "https://github.com/manalkaff/opendesign",
    configType: "guide",
    notes: [
      {
        type: "info",
        text: `OpenDesign ships as a plugin/skills pack installed into Claude Code, Cursor, OpenAI Codex, Gemini CLI, or OpenCode. It inherits the host agent's model config, so once your host points at ${ACTIVE.name}, /opendesign design sessions route through ${ACTIVE.name} automatically — no extra env vars needed.`,
      },
      {
        type: "info",
        text: "Invoke with /opendesign <brief>. Covers decks, wireframes, interactive prototypes, design-system extraction, and brand systems, with a verifier subagent that checks output against the brief.",
      },
    ],
    guideSteps: [
      {
        step: 1,
        title: "Install the plugin",
        desc: "Pick your host below and run the matching install command from the matrix.",
      },
      {
        step: 2,
        title: "No config needed",
        desc: `OpenDesign runs inside your host agent and uses its model config. If the host already routes through ${ACTIVE.name}, /opendesign traffic does too.`,
      },
      {
        step: 3,
        title: "Start designing",
        desc: "Invoke OpenDesign from your agent:",
        value: "/opendesign make a pitch deck for a seed-stage AI company, 10 slides",
        copyable: true,
      },
    ],
    codeBlock: {
      language: "bash",
      code: `# Claude Code
/plugin marketplace add manalkaff/opendesign
/plugin install opendesign@opendesign

# Cursor
/add-plugin opendesign

# OpenAI Codex CLI
/plugins   # search "opendesign" -> Install Plugin

# OpenAI Codex App
# Plugins sidebar -> OpenDesign (Design section) -> +

# Gemini CLI
gemini extensions install https://github.com/manalkaff/opendesign

# OpenCode
# Fetch and follow .opencode/INSTALL.md from the repo`,
    },
  },
  // HIDDEN: gemini-cli
  // "gemini-cli": {
  //   id: "gemini-cli",
  //   name: "Gemini CLI",
  //   icon: "terminal",
  //   color: "#4285F4",
  //   description: "Google Gemini CLI",
  //   configType: "env",
  //   envVars: {
  //     baseUrl: "GEMINI_API_BASE_URL",
  //     model: "GEMINI_MODEL",
  //   },
  //   defaultModels: [
  //     { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", alias: "pro" },
  //     { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", alias: "flash" },
  //   ],
  // },
};

// Get all provider models for mapping dropdown
export const getProviderModelsForMapping = (providers) => {
  const result = [];
  providers.forEach((conn) => {
    if (conn.isActive && (conn.testStatus === "active" || conn.testStatus === "success")) {
      result.push({
        connectionId: conn.id,
        provider: conn.provider,
        name: conn.name,
        models: conn.models || [],
      });
    }
  });
  return result;
};
