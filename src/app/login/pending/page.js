import { notFound } from "next/navigation";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Card from "@/shared/components/Card";
import EmptyState from "@/shared/components/EmptyState";
import BrandLockup from "@/shared/components/BrandLockup";
import { ACTIVE } from "@/shared/brand";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch";

// The switch is read at request time; a static prerender would bake in the
// build-time switch state (404 forever if built with the switch off).
export const dynamic = "force-dynamic";

export const metadata = {
  title: `Waiting for approval - ${ACTIVE.name}`,
};

/**
 * Public waiting page for SSO-provisioned accounts still awaiting approval.
 * Rollout on: generic copy only, never identity, group or workspace data, so a
 * direct bookmark is safe. Rollout off: 404, as if the route never existed.
 * No session, cookie read or data fetch happens here by design (plan task 2.2).
 */
export default async function LoginPendingPage() {
  if (!(await isMultiUserEnabled())) notFound();

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg p-4">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            href="/landing"
            className="inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:shadow-focus"
            aria-label={`${ACTIVE.name} home`}
          >
            <BrandLockup size={44} />
          </Link>
        </div>

        <Card>
          {/* The info Callout is the status region; nesting another would double-announce. */}
          <div>
            <EmptyState
              icon="hourglass_top"
              as="h1"
              title="Waiting for approval"
              body="An administrator needs to approve your account."
            />
            <Callout variant="info" className="mt-2">
              Sign in again once you&apos;ve been approved.
            </Callout>
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" href="/login">
                Back to sign in
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
