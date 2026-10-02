"use client";

import PropTypes from "prop-types";
import { ACTIVE } from "@/shared/brand";
import {
  Card,
  Button,
  IconButton,
  Callout,
  CopyField,
  StatusPill,
  Skeleton,
} from "@/shared/components";

const tunnelShape = PropTypes.shape({
  checking: PropTypes.bool,
  enabled: PropTypes.bool,
  reachable: PropTypes.bool,
  everReachable: PropTypes.bool,
  url: PropTypes.string,
  publicUrl: PropTypes.string,
  loading: PropTypes.bool,
  progress: PropTypes.string,
  status: PropTypes.shape({
    type: PropTypes.string,
    message: PropTypes.string,
  }),
  canEnable: PropTypes.bool,
  gateNote: PropTypes.string,
});

const tailscaleShape = PropTypes.shape({
  enabled: PropTypes.bool,
  reachable: PropTypes.bool,
  everReachable: PropTypes.bool,
  url: PropTypes.string,
  loading: PropTypes.bool,
  progress: PropTypes.string,
  status: PropTypes.shape({
    type: PropTypes.string,
    message: PropTypes.string,
  }),
  authUrl: PropTypes.string,
  authLabel: PropTypes.string,
  installed: PropTypes.bool, // null = still checking, false = not installed
});

/**
 * Local-only way in: always on while 9router runs.
 *
 * @param {object} props
 * @param {string} props.localUrl Full local API URL (e.g. http://localhost:20128/v1).
 */
function LocalWay({ localUrl }) {
  return (
    <Card
      title="Local"
      icon="home"
      action={
        <StatusPill variant="ok" size="sm" dot>
          On
        </StatusPill>
      }
    >
      <div className="flex flex-col gap-2">
        <CopyField value={localUrl} copyValue={localUrl} label="Copy local URL" />
        <p className="text-[13px] text-muted">{`Always on while ${ACTIVE.slug} runs.`}</p>
      </div>
    </Card>
  );
}

LocalWay.propTypes = {
  localUrl: PropTypes.string.isRequired,
};

/**
 * Cloudflare Tunnel way in. States in priority order: loading → connected →
 * enabled-but-unreachable → error → checking → default (enable or gated).
 */
function TunnelWay({ tunnel, onEnableTunnel, onStopTunnel, onDisableTunnel }) {
  const connectedUrl = `${tunnel.publicUrl || tunnel.url}/v1`;
  return (
    <Card
      title="Cloudflare tunnel"
      icon="cloud_upload"
      action={
        tunnel.enabled ? (
          <StatusPill variant="ok" size="sm" dot>
            On
          </StatusPill>
        ) : (
          <StatusPill variant="neutral" size="sm">
            Off
          </StatusPill>
        )
      }
    >
      {tunnel.loading ? (
        <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          <span className="truncate text-sm text-muted">
            {tunnel.progress || "Creating tunnel..."}
          </span>
          <Button variant="ghost" size="sm" onClick={onStopTunnel}>
            Stop
          </Button>
        </div>
      ) : tunnel.enabled && tunnel.reachable ? (
        <div className="flex flex-col gap-2">
          <CopyField value={connectedUrl} copyValue={connectedUrl} label="Copy tunnel URL" />
          <div className="flex justify-end">
            <IconButton
              icon="power_settings_new"
              aria-label="Disable tunnel"
              onClick={onDisableTunnel}
            />
          </div>
        </div>
      ) : tunnel.enabled && !tunnel.reachable ? (
        <div className="flex flex-col gap-2">
          <Callout variant="warn">
            {tunnel.everReachable ? "Tunnel reconnecting..." : "Tunnel checking..."}
          </Callout>
          <div className="flex justify-end">
            <IconButton
              icon="power_settings_new"
              aria-label="Disable tunnel"
              onClick={onDisableTunnel}
            />
          </div>
        </div>
      ) : tunnel.status?.type === "error" ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Callout variant="err">{tunnel.status.message}</Callout>
          <Button variant="secondary" size="sm" icon="cloud_upload" onClick={onEnableTunnel}>
            Enable
          </Button>
        </div>
      ) : tunnel.checking ? (
        <div className="flex items-center gap-2">
          <Skeleton className="h-11 flex-1" />
          <IconButton icon="power_settings_new" aria-label="Stop checking" onClick={onStopTunnel} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="sm" icon="cloud_upload" onClick={onEnableTunnel}>
            Enable
          </Button>
          {!tunnel.canEnable ? (
            <p className="text-[13px] text-muted">{tunnel.gateNote}</p>
          ) : (
            <p className="text-[13px] text-muted">Public HTTPS, no port forwarding.</p>
          )}
        </div>
      )}
    </Card>
  );
}

TunnelWay.propTypes = {
  tunnel: tunnelShape.isRequired,
  onEnableTunnel: PropTypes.func.isRequired,
  onStopTunnel: PropTypes.func.isRequired,
  onDisableTunnel: PropTypes.func.isRequired,
};

/**
 * Tailscale Funnel way in. Mirrors the tunnel states, plus an inline auth
 * button (popup blockers eat async popups, so the user clicks explicitly)
 * and the not-installed / installed-but-off branches.
 */
function TailscaleWay({ tailscale, onConnect, onDisconnect, onInstall, onStop }) {
  const openAuth = () => {
    if (tailscale.authUrl) {
      window.open(tailscale.authUrl, "tailscale_auth", "width=600,height=700,noopener,noreferrer");
    }
  };
  return (
    <Card
      title="Tailscale"
      icon="vpn_lock"
      action={
        tailscale.enabled ? (
          <StatusPill variant="ok" size="sm" dot>
            Connected
          </StatusPill>
        ) : (
          <StatusPill variant="neutral" size="sm">
            Off
          </StatusPill>
        )
      }
    >
      {tailscale.loading ? (
        <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          <span className="truncate text-sm text-muted">
            {tailscale.progress || "Connecting..."}
          </span>
          <div className="flex gap-2">
            {tailscale.authUrl && (
              <Button variant="secondary" size="sm" icon="open_in_new" onClick={openAuth}>
                {tailscale.authLabel || "Open"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onStop}>
              Stop
            </Button>
          </div>
        </div>
      ) : tailscale.enabled && tailscale.reachable ? (
        <div className="flex flex-col gap-2">
          <CopyField
            value={`${tailscale.url}/v1`}
            copyValue={`${tailscale.url}/v1`}
            label="Copy Tailscale URL"
          />
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : tailscale.enabled && !tailscale.reachable ? (
        <div className="flex flex-col gap-2">
          <Callout variant="warn">
            {tailscale.everReachable ? "Tailscale reconnecting..." : "Tailscale checking..."}
          </Callout>
          <div className="flex justify-end">
            <IconButton
              icon="power_settings_new"
              aria-label="Disconnect Tailscale"
              onClick={onDisconnect}
            />
          </div>
        </div>
      ) : tailscale.status?.type === "error" ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Callout variant="err">{tailscale.status.message}</Callout>
          <Button variant="secondary" size="sm" icon="vpn_lock" onClick={onConnect}>
            Enable
          </Button>
        </div>
      ) : tailscale.installed === false ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted">Not installed.</p>
          <Button variant="secondary" size="sm" icon="download" onClick={onInstall}>
            Install Tailscale
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="sm" icon="vpn_lock" onClick={onConnect}>
            Connect
          </Button>
          <p className="text-[13px] text-muted">Private access for your tailnet only.</p>
        </div>
      )}
    </Card>
  );
}

TailscaleWay.propTypes = {
  tailscale: tailscaleShape.isRequired,
  onConnect: PropTypes.func.isRequired,
  onDisconnect: PropTypes.func.isRequired,
  onInstall: PropTypes.func.isRequired,
  onStop: PropTypes.func.isRequired,
};

/**
 * Three ways into the endpoint: local, Cloudflare Tunnel, Tailscale Funnel.
 * All state arrives via props — no fetching here; the parent wires data and
 * confirms (disable flows confirm in the parent modal).
 *
 * @param {object} props
 * @param {string} props.localUrl Full local API URL.
 * @param {object} props.tunnel Tunnel state (see TunnelWay).
 * @param {object} props.tailscale Tailscale state (see TailscaleWay).
 * @param {() => void} props.onEnableTunnel Open the enable-tunnel modal (or enable directly).
 * @param {() => void} props.onStopTunnel Halt in-flight tunnel work (loading or checking).
 * @param {() => void} props.onDisableTunnel Open the disable-tunnel confirm in the parent.
 * @param {() => void} props.onConnectTailscale Open the Tailscale modal / connect.
 * @param {() => void} props.onDisableTailscale Open the disable-Tailscale confirm in the parent.
 * @param {() => void} props.onInstallTailscale Open the install flow in the parent.
 * @param {() => void} props.onStopTailscale Halt an in-flight Tailscale connect.
 */
export default function WaysInGrid({
  localUrl,
  tunnel,
  tailscale,
  onEnableTunnel,
  onStopTunnel,
  onDisableTunnel,
  onConnectTailscale,
  onDisableTailscale,
  onInstallTailscale,
  onStopTailscale,
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <LocalWay localUrl={localUrl} />
      <TunnelWay
        tunnel={tunnel}
        onEnableTunnel={onEnableTunnel}
        onStopTunnel={onStopTunnel}
        onDisableTunnel={onDisableTunnel}
      />
      <TailscaleWay
        tailscale={tailscale}
        onConnect={onConnectTailscale}
        onDisconnect={onDisableTailscale}
        onInstall={onInstallTailscale}
        onStop={onStopTailscale}
      />
    </div>
  );
}

WaysInGrid.propTypes = {
  localUrl: PropTypes.string.isRequired,
  tunnel: tunnelShape.isRequired,
  tailscale: tailscaleShape.isRequired,
  onEnableTunnel: PropTypes.func.isRequired,
  onStopTunnel: PropTypes.func.isRequired,
  onDisableTunnel: PropTypes.func.isRequired,
  onConnectTailscale: PropTypes.func.isRequired,
  onDisableTailscale: PropTypes.func.isRequired,
  onInstallTailscale: PropTypes.func.isRequired,
  onStopTailscale: PropTypes.func.isRequired,
};

export { WaysInGrid };
