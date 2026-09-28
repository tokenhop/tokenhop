"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";

/**
 * Relay deploy modals (Cloudflare Worker, Vercel, Deno Deploy), restyled with
 * Signal primitives. Copy, free-tier notes and token steps match the current
 * page; tokens are used once for deployment and never stored.
 */

function Explainer({ title, body, points, steps }) {
  return (
    <Callout variant="info" title={title}>
      <div className="flex flex-col gap-1.5">
        <p>{body}</p>
        <ul className="list-disc ps-4">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        {steps ? (
          <div className="mt-1 border-t border-line pt-2">
            <p className="font-semibold text-text">How to generate your API token:</p>
            <ol className="list-decimal ps-4">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </Callout>
  );
}

Explainer.propTypes = {
  title: PropTypes.string.isRequired,
  body: PropTypes.string.isRequired,
  points: PropTypes.arrayOf(PropTypes.string).isRequired,
  steps: PropTypes.arrayOf(PropTypes.string),
};

export function CloudflareDeployModal({ isOpen, onClose, deploying, onDeploy }) {
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [projectName, setProjectName] = useState("cloudflare-relay");

  const close = () => {
    if (deploying) return;
    setAccountId("");
    setApiToken("");
    setProjectName("cloudflare-relay");
    onClose?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Deploy Cloudflare relay" size="md">
      <Modal.Body>
        <div className="flex flex-col gap-4">
          <Explainer
            title="What is Cloudflare Relay?"
            body="Deploys a Cloudflare Worker as a proxy relay. All AI provider requests will be forwarded through Cloudflare's global edge network."
            points={[
              "High performance global routing and IP masking via Cloudflare Workers",
              "Free tier: 100,000 requests per day",
              "Requires Cloudflare Account ID and a Workers API Token (Edit Workers permission)",
            ]}
            steps={[
              "Go to My Profile → API Tokens → Create Token",
              "Scroll down to Custom Token and click Get started",
              "Under Permissions: Account | Workers Scripts | Edit",
              "Under Account Resources: Include | Account | Your Account Name",
              "Click Continue to summary → Create Token",
            ]}
          />
          <Input
            label="Account ID"
            required
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="your-cloudflare-account-id"
            hint="Found on the right side of the Cloudflare dashboard overview page."
          />
          <Input
            label="API Token"
            required
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="your-cloudflare-api-token"
            hint="Requires Workers Scripts: Edit permission. Token is used once and not stored."
          />
          <Input
            label="Worker Name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-relay"
            hint="Unique name for your Cloudflare Worker. Leave empty for an auto-generated name."
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={close} disabled={deploying}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={deploying}
          disabled={deploying || !accountId.trim() || !apiToken.trim()}
          onClick={() => onDeploy?.({ accountId, apiToken, projectName })}
        >
          {deploying ? "Deploying…" : "Deploy Worker"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

CloudflareDeployModal.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  deploying: PropTypes.bool,
  onDeploy: PropTypes.func,
};

export function VercelDeployModal({ isOpen, onClose, deploying, onDeploy }) {
  const [vercelToken, setVercelToken] = useState("");
  const [projectName, setProjectName] = useState("vercel-relay");

  const close = () => {
    if (deploying) return;
    setVercelToken("");
    setProjectName("vercel-relay");
    onClose?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Deploy Vercel relay" size="md">
      <Modal.Body>
        <div className="flex flex-col gap-4">
          <Explainer
            title="What is Vercel Relay?"
            body="Deploys an edge relay function to Vercel. All AI provider requests will be forwarded through Vercel's edge network, masking your real IP from providers."
            points={[
              "Your IP is replaced by Vercel's dynamic edge IPs across 20+ global regions",
              "Vercel serves millions of apps — providers can't block Vercel IPs without affecting legitimate traffic",
              "Free tier: 100GB bandwidth/month, 500K edge invocations",
              "Deploy multiple relays on different accounts for more IP diversity",
            ]}
          />
          <Input
            label="Vercel API Token"
            required
            type="password"
            value={vercelToken}
            onChange={(e) => setVercelToken(e.target.value)}
            placeholder="your-vercel-api-token"
            hint="Token is used once for deployment and not stored. Get one at vercel.com/account/tokens."
          />
          <Input
            label="Project Name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-relay"
            hint="Unique name for your Vercel project. Leave empty for an auto-generated name."
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={close} disabled={deploying}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={deploying}
          disabled={deploying || !vercelToken.trim()}
          onClick={() => onDeploy?.({ vercelToken, projectName })}
        >
          {deploying ? "Deploying… (may take ~1 min)" : "Deploy"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

VercelDeployModal.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  deploying: PropTypes.bool,
  onDeploy: PropTypes.func,
};

export function DenoDeployModal({ isOpen, onClose, deploying, onDeploy }) {
  const [denoToken, setDenoToken] = useState("");
  const [orgDomain, setOrgDomain] = useState("");
  const [projectName, setProjectName] = useState("");

  const close = () => {
    if (deploying) return;
    setDenoToken("");
    setOrgDomain("");
    setProjectName("");
    onClose?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Deploy Deno relay" size="md">
      <Modal.Body>
        <div className="flex flex-col gap-4">
          <Explainer
            title="What is Deno Relay?"
            body="Deploys a relay worker to Deno Deploy's global edge network. All AI provider requests are forwarded through Deno's edge, masking your real IP."
            points={[
              "Deno Deploy v2 runs on a high-performance global edge network",
              "Free tier: 1M requests and 100GiB outbound traffic per month",
              "No per-request CPU time limits (unlike Vercel/Cloudflare)",
              "Support up to 20 active apps and 50 custom domains",
              "Deploy multiple relays for maximum IP diversity",
            ]}
            steps={[
              "Go to console.deno.com",
              "Select your Organization → Settings → Organization Tokens",
              "Create an Organization Token (prefix ddo_)",
            ]}
          />
          <Input
            label="Deno Deploy API Token"
            required
            type="password"
            value={denoToken}
            onChange={(e) => setDenoToken(e.target.value)}
            placeholder="ddo_xxxxxxxxxxxxxxxx"
            hint="Token is used once for deployment, not stored. Found in Organization Settings."
          />
          <Input
            label="Organization Domain"
            required
            value={orgDomain}
            onChange={(e) => setOrgDomain(e.target.value)}
            placeholder="your-org.deno.net"
            hint="Your relay URL will be https://my-relay.your-org.deno.net."
          />
          <Input
            label="App Name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="deno-relay"
            hint="Unique app name. Leave empty for an auto-generated name."
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={close} disabled={deploying}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={deploying}
          disabled={deploying || !denoToken.trim() || !orgDomain.trim()}
          onClick={() => onDeploy?.({ denoToken, orgDomain, projectName })}
        >
          {deploying ? "Deploying…" : "Deploy Relay"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

DenoDeployModal.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  deploying: PropTypes.bool,
  onDeploy: PropTypes.func,
};
