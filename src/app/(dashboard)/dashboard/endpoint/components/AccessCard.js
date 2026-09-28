"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { Card, Button, SettingRow, Toggle, Callout } from "@/shared/components";

/**
 * Access settings card: requireLogin, tunnelDashboardAccess, and the security
 * derivation callout (locked down vs warning with a direct fix action).
 *
 * NOTE (YAN-309): The "Password & single sign-on" link currently points to
 * `/dashboard/profile`; when YAN-309 lands, update this link to
 * `/dashboard/settings#security`.
 *
 * @param {object} props
 * @param {boolean} props.requireLogin
 * @param {boolean} props.tunnelDashboardAccess
 * @param {{ variant: "ok"|"warn", message: string, fix?: { label: string, href: string } }} props.security
 * @param {(checked: boolean) => void} props.onToggleLogin
 * @param {(checked: boolean) => void} props.onToggleTunnelDash
 * @param {boolean} [props.loginBusy]
 * @param {boolean} [props.dashBusy]
 */
export default function AccessCard({
  requireLogin,
  tunnelDashboardAccess,
  security,
  onToggleLogin,
  onToggleTunnelDash,
  loginBusy = false,
  dashBusy = false,
}) {
  return (
    <Card title="Access" icon="lock">
      <div className="flex flex-col gap-2">
        <SettingRow
          label="Require login"
          description="Dashboard asks for a password"
          settingKey="requireLogin"
          control={
            <Toggle
              checked={requireLogin}
              onChange={onToggleLogin}
              disabled={loginBusy}
              aria-label="Require login"
            />
          }
        />

        <SettingRow
          label="Dashboard over tunnel"
          description="Open this dashboard from the tunnel URL too"
          settingKey="tunnelDashboardAccess"
          control={
            <Toggle
              checked={tunnelDashboardAccess}
              onChange={onToggleTunnelDash}
              disabled={dashBusy}
              aria-label="Dashboard over tunnel"
            />
          }
        />

        {security && (
          <div className="mt-2">
            <Callout variant={security.variant}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{security.message}</span>
                {security.fix &&
                  (security.fix.href.startsWith("#") ? (
                    <a
                      href={security.fix.href}
                      className="inline-flex h-10 items-center justify-center rounded-lg border border-line bg-transparent px-3 text-sm font-semibold text-text transition-colors hover:bg-raised"
                    >
                      {security.fix.label}
                    </a>
                  ) : (
                    <Button variant="ghost" size="sm" href={security.fix.href}>
                      {security.fix.label}
                    </Button>
                  ))}
              </div>
            </Callout>
          </div>
        )}

        <div className="mt-3 border-t border-line pt-3">
          <Link
            href="/dashboard/profile"
            className="text-sm font-medium text-coral hover:underline"
          >
            Password &amp; single sign-on &rarr;
          </Link>
        </div>
      </div>
    </Card>
  );
}

AccessCard.propTypes = {
  requireLogin: PropTypes.bool.isRequired,
  tunnelDashboardAccess: PropTypes.bool.isRequired,
  security: PropTypes.shape({
    variant: PropTypes.oneOf(["ok", "warn"]).isRequired,
    message: PropTypes.string.isRequired,
    fix: PropTypes.shape({
      label: PropTypes.string.isRequired,
      href: PropTypes.string.isRequired,
    }),
  }).isRequired,
  onToggleLogin: PropTypes.func.isRequired,
  onToggleTunnelDash: PropTypes.func.isRequired,
  loginBusy: PropTypes.bool,
  dashBusy: PropTypes.bool,
};
