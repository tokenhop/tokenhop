"use client";

// YAN-373: fixed SSO preview callback target (/dashboard/admin/sso?ssoPreview=1).
// Same component as /dashboard/admin/provisioning; it consumes the query once
// and scrubs it from history.

import { ProvisioningForm } from "../provisioning/ProvisioningForm";

export default function AdminSsoPage() {
  return <ProvisioningForm />;
}
