"use client";

import PropTypes from "prop-types";

const METHODS = [
  {
    id: "builder-id",
    icon: "shield",
    title: "AWS Builder ID",
    hint: "Recommended for most users. Free AWS account required.",
  },
  {
    id: "idc",
    icon: "business",
    title: "AWS IAM Identity Center",
    hint: "For enterprise users with custom AWS IAM Identity Center.",
  },
  {
    id: "api-key",
    icon: "key",
    title: "API Key",
    hint: "Use a long-lived Kiro/CodeWhisperer API key (headless auth).",
  },
  {
    id: "import",
    icon: "file_upload",
    title: "Import Token",
    hint: "Paste refresh token from Kiro IDE.",
  },
  {
    id: "import-cli-proxy",
    icon: "data_object",
    title: "Import CLIProxyAPI JSON",
    hint: "Paste external_idp auth JSON from CLIProxyAPI/Kiro Microsoft login.",
  },
];

// Social login stays mounted but hidden; observed shape, kept on purpose.
const HIDDEN_SOCIAL = [
  {
    id: "social-google",
    provider: "google",
    icon: "account_circle",
    title: "Google Account",
    hint: "Login with your Google account (manual callback).",
  },
  {
    id: "social-github",
    provider: "github",
    icon: "code",
    title: "GitHub Account",
    hint: "Login with your GitHub account (manual callback).",
  },
];

/** Kiro method picker. Hidden social cards render the full original markup. */
export default function KiroMethodList({ onQuickSelect, onFormSelect }) {
  return (
    <div className="space-y-3">
      <p className="mb-4 text-sm text-muted">Choose your authentication method:</p>
      {METHODS.map((method) => (
        <button
          type="button"
          key={method.id}
          onClick={() =>
            method.id === "builder-id" ? onQuickSelect("builder-id") : onFormSelect(method.id)
          }
          className="w-full rounded-xl border border-line p-4 text-start transition-colors hover:bg-raised focus-visible:outline-none focus-visible:shadow-focus"
        >
          <span className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 text-coral" aria-hidden="true">
              {method.icon}
            </span>
            <span className="flex-1">
              <span className="mb-1 block font-semibold">{method.title}</span>
              <span className="block text-sm text-muted">{method.hint}</span>
            </span>
          </span>
        </button>
      ))}
      {HIDDEN_SOCIAL.map((social) => (
        <button
          type="button"
          key={social.id}
          onClick={() => onFormSelect(social.id)}
          className="hidden w-full rounded-xl border border-line p-4 text-start transition-colors hover:bg-raised"
        >
          <span className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 text-coral" aria-hidden="true">
              {social.icon}
            </span>
            <span className="flex-1">
              <span className="mb-1 block font-semibold">{social.title}</span>
              <span className="block text-sm text-muted">{social.hint}</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

KiroMethodList.propTypes = {
  onQuickSelect: PropTypes.func.isRequired,
  onFormSelect: PropTypes.func.isRequired,
};
