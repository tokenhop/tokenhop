"use client";

import PropTypes from "prop-types";
import dynamic from "next/dynamic";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";

// Each literal import gives Next a separate split point.
const loading = () => <CardSkeleton />;
const TOOL_CARDS = {
  claude: dynamic(() => import("./ClaudeToolCard"), { loading }),
  codex: dynamic(() => import("./CodexToolCard"), { loading }),
  opencode: dynamic(() => import("./OpenCodeToolCard"), { loading }),
  copilot: dynamic(() => import("./CopilotToolCard"), { loading }),
  cowork: dynamic(() => import("./CoworkToolCard"), { loading }),
  cline: dynamic(() => import("./ClineToolCard"), { loading }),
  kilo: dynamic(() => import("./KiloToolCard"), { loading }),
  droid: dynamic(() => import("./DroidToolCard"), { loading }),
  hermes: dynamic(() => import("./HermesToolCard"), { loading }),
  openclaw: dynamic(() => import("./OpenClawToolCard"), { loading }),
  "deepseek-tui": dynamic(() => import("./DeepSeekTuiToolCard"), { loading }),
  jcode: dynamic(() => import("./JcodeToolCard"), { loading }),
  "grok-build": dynamic(() => import("./GrokBuildToolCard"), { loading }),
  default: dynamic(() => import("./DefaultToolCard"), { loading }),
};

/** One setup surface for inline aside and deep-link detail route. */
export default function ToolSetupPanel({ toolId, data, onStatusUpdate }) {
  const tool = CLI_TOOLS[toolId];
  if (!tool) return null;
  if (data.loading) return <CardSkeleton />;
  const CardComponent = TOOL_CARDS[toolId] || TOOL_CARDS.default;
  // YAN-363 hashed mode: key rows are prefix metadata only (no raw). Cards
  // whose routes lack a storage marker (cline/kilo/default) get the shared
  // context's storage mode instead — never a secret.
  const hashedContext = data.keyContext?.storage === "hashed";
  return (
    <CardComponent
      key={toolId}
      toolId={toolId}
      tool={tool}
      baseUrl={data.defaultBaseUrl}
      apiKeys={data.apiKeys}
      hashedContext={hashedContext}
      activeProviders={data.activeProviders}
      hasActiveProviders={data.hasActiveProviders}
      cloudEnabled={data.cloudEnabled}
      cloudUrl={data.cloudUrl}
      tunnelEnabled={data.tunnelEnabled}
      tunnelPublicUrl={data.tunnelPublicUrl}
      tailscaleEnabled={data.tailscaleEnabled}
      tailscaleUrl={data.tailscaleUrl}
      modelAliases={data.modelAliases}
      ccFilterNaming={data.ccFilterNaming}
      onStatusUpdate={onStatusUpdate}
    />
  );
}

ToolSetupPanel.propTypes = {
  toolId: PropTypes.string.isRequired,
  data: PropTypes.shape({
    loading: PropTypes.bool,
    defaultBaseUrl: PropTypes.string,
    apiKeys: PropTypes.array,
    activeProviders: PropTypes.array,
    hasActiveProviders: PropTypes.bool,
    cloudEnabled: PropTypes.bool,
    cloudUrl: PropTypes.string,
    tunnelEnabled: PropTypes.bool,
    tunnelPublicUrl: PropTypes.string,
    tailscaleEnabled: PropTypes.bool,
    tailscaleUrl: PropTypes.string,
    modelAliases: PropTypes.object,
    ccFilterNaming: PropTypes.bool,
  }).isRequired,
  onStatusUpdate: PropTypes.func,
};
