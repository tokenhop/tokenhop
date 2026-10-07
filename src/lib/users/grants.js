// Provider-terms guardrails for connection grants (YAN-369, ADR-0006).
// Pure validation side: no DB, no secrets. resolveSharing derives the ToS
// class of a connection from the registry `sharing` field plus the row's
// authType — an OAuth login is personal even on a shareable provider (e.g. a
// kimchi OAuth row). Unknown providers fail closed to "personal".
// assertGrantable is the route-side creation gate; getSharingWarning returns
// the ADR-0006 §Warning copy verbatim for the acknowledgement UI (YAN-376)
// and API 403 bodies.
import REGISTRY from "open-sse/providers/registry/index.js";
import { TenancyError } from "@/lib/users/errors.js";

const SHARING = new Map(REGISTRY.map((e) => [e.id, e.sharing]));

/**
 * ToS class of a connection. Registry `sharing`; OAuth rows are always
 * "personal"; unknown ids fail closed to "personal".
 * @param {string} providerId connection row's provider id
 * @param {string|null} [connectionAuthType] connection row's authType
 * @returns {"personal"|"shareable"}
 */
export function resolveSharing(providerId, connectionAuthType) {
  if (connectionAuthType === "oauth") return "personal";
  return SHARING.get(providerId) === "shareable" ? "shareable" : "personal";
}

// ADR-0006 §Warning copy (exact). Family by provider id; unlisted → generic.
const FAMILY_OF = {
  claude: "anthropic",
  codex: "openai",
  github: "github",
  "gemini-cli": "google",
};
const SHARING_WARNINGS = {
  anthropic:
    "Sharing this connection routes requests through a personal Anthropic subscription. Anthropic's Consumer Terms forbid sharing account credentials or making an account available to others, and the Claude Code legal page forbids routing requests through Free/Pro/Max credentials on behalf of other users. See https://www.anthropic.com/legal/consumer-terms and https://code.claude.com/docs/en/legal-and-compliance. Provisioning your own Anthropic API keys for your own authorized users is allowed — use an API-key connection instead. Overriding may violate Anthropic's terms.",
  openai:
    "OpenAI's Terms of Use state: \"You may not share your account credentials or make your account available to anyone else.\" ChatGPT-plan Codex access falls under the ChatGPT terms. See https://openai.com/policies/terms-of-use/ and https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan. Use an OpenAI API-key connection for shared use. Overriding may violate OpenAI's terms.",
  github:
    "GitHub's Terms of Service state that \"a single login may not be shared by multiple people.\" Individual Copilot plans are licensed per account; teams require Copilot Business. See https://docs.github.com/en/site-policy/github-terms/github-terms-of-service. Overriding may violate GitHub's terms.",
  google:
    "This connection uses personal Google-account credentials. tokenhop has not reviewed Google's terms for this use; review them before sharing. See https://policies.google.com/terms. Overriding may violate Google's terms.",
  generic:
    "This provider is classified as subscription-bound (sharing: personal). Its terms of service were not reviewed by tokenhop; review them on the provider's website (linked from the connection page) before sharing. Overriding may violate the provider's terms.",
};

/**
 * The ADR-0006 §Warning copy (exact) for a personal provider.
 * @param {string} providerId
 * @returns {string}
 */
export function getSharingWarning(providerId) {
  return SHARING_WARNINGS[FAMILY_OF[providerId] ?? "generic"];
}

/**
 * Creation gate (ADR-0006 §Personal): shareable connections pass; personal
 * ones additionally need the instance toggle, an instance owner/admin actor
 * and the exact ToS acknowledgement echo
 * {providerId: <connection provider>, sharing: "personal"}.
 * @param {{ principal?: object|null, connection?: { provider: string, authType?: string|null }|null, body?: object|null, settings?: object|null }} args
 * @returns {{ sharing: "personal"|"shareable", tosAcknowledgedAt?: number }}
 * @throws {TenancyError} FORBIDDEN (403) on every ToS block, INVALID (400) on a missing connection
 */
export function assertGrantable({ principal, connection, body = {}, settings = {} } = {}) {
  if (!connection || typeof connection.provider !== "string") {
    throw new TenancyError("INVALID", "A connection row is required");
  }
  const sharing = resolveSharing(connection.provider, connection.authType);
  if (sharing !== "personal") return { sharing };
  if (settings?.allowPersonalConnectionGrants !== true) {
    throw new TenancyError("FORBIDDEN", "Personal connections are not grantable on this instance");
  }
  if (!["owner", "admin"].includes(principal?.instanceRole)) {
    throw new TenancyError(
      "FORBIDDEN",
      "Only an instance owner or admin may grant a personal connection",
    );
  }
  const ack = body?.tosAcknowledged;
  if (ack?.providerId !== connection.provider || ack?.sharing !== "personal") {
    throw new TenancyError(
      "FORBIDDEN",
      "The provider-terms warning must be acknowledged to grant a personal connection",
    );
  }
  return { sharing, tosAcknowledgedAt: Date.now() };
}
