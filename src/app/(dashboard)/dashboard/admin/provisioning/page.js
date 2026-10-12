"use client";

// YAN-373: SSO provisioning policy page. The editor and the draft preview
// live in ProvisioningForm; /dashboard/admin/sso renders the same component
// so the IdP preview callback lands on a stable path.

import { ProvisioningForm } from "./ProvisioningForm";

export default function AdminProvisioningPage() {
  return <ProvisioningForm />;
}
