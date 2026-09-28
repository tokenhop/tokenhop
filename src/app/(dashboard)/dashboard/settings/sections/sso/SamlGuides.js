"use client";

import PropTypes from "prop-types";

function Code({ children }) {
  return <code className="break-all font-mono text-text">{children}</code>;
}

Code.propTypes = { children: PropTypes.node };

function Guide({ title, steps }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-3">
      <p className="font-semibold text-text">{title}</p>
      <ol className="list-decimal space-y-1 ps-4 text-muted">
        {steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered list.
          <li key={index}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

Guide.propTypes = { title: PropTypes.string.isRequired, steps: PropTypes.arrayOf(PropTypes.node) };

/**
 * IdP setup guides (AWS IAM Identity Center, Entra ID, Okta/Auth0,
 * Keycloak/Authentik) with the live ACS URL and SP entity id interpolated.
 */
export default function SamlGuides({ acsUrl, entityId }) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="rounded-lg bg-sky-bg p-3 text-text">
        <p className="mb-1 font-semibold">Required service provider (SP) values for your IdP</p>
        <ul className="list-disc space-y-1 ps-4">
          <li>
            Assertion Consumer Service (ACS) URL: <Code>{acsUrl}</Code>
          </li>
          <li>
            SP Entity ID / Audience URI: <Code>{entityId}</Code>
          </li>
          <li>
            NameID format: <Code>EmailAddress</Code> or <Code>Unspecified</Code>
          </li>
        </ul>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Guide
          title="AWS IAM Identity Center"
          steps={[
            "Applications → Add application → Add custom SAML 2.0 application.",
            <>
              Set Application ACS URL to <Code>{acsUrl}</Code>.
            </>,
            <>
              Set Application SAML audience to <Code>{entityId}</Code>.
            </>,
            <>
              Under Attribute mappings, map <Code>Subject</Code> or <Code>email</Code> to{" "}
              <Code>{"$" + "{user:email}"}</Code>.
            </>,
            "Download the IAM Identity Center SAML metadata XML and import it below.",
          ]}
        />
        <Guide
          title="Microsoft Entra ID (Azure AD)"
          steps={[
            "Enterprise Applications → New application → Create your own application.",
            "Select Single sign-on → SAML.",
            <>
              Identifier (Entity ID): <Code>{entityId}</Code>
            </>,
            <>
              Reply URL (ACS): <Code>{acsUrl}</Code>
            </>,
            "Download Federation Metadata XML and import it, or copy the X.509 certificate.",
          ]}
        />
        <Guide
          title="Okta / Auth0"
          steps={[
            "Applications → Create App Integration → SAML 2.0.",
            <>
              Single Sign-On URL: <Code>{acsUrl}</Code>
            </>,
            <>
              Audience URI (SP Entity ID): <Code>{entityId}</Code>
            </>,
            "Name ID format: EmailAddress.",
            "Download the Identity Provider metadata XML or copy the X.509 certificate.",
          ]}
        />
        <Guide
          title="Keycloak / Authentik"
          steps={[
            "Clients → Create client → SAML.",
            <>
              Client ID: <Code>{entityId}</Code>
            </>,
            <>
              Master SAML Processing URL: <Code>{acsUrl}</Code>
            </>,
            "Export the SAML descriptor XML or copy the IdP certificate PEM.",
          ]}
        />
      </div>
    </div>
  );
}

SamlGuides.propTypes = {
  acsUrl: PropTypes.string.isRequired,
  entityId: PropTypes.string.isRequired,
};
