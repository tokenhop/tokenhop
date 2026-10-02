"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import Callout from "@/shared/components/Callout";
import { ACTIVE } from "@/shared/brand";

const LINK_CLASS =
  "inline-flex min-h-11 items-center font-medium text-text underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-focus";

/**
 * Ordered setup guide for a dashboard that is not on the host. Presentational
 * only: the MITM server, CA and DNS stay host-managed; model mappings can be
 * edited from here. `onMitmPage` drops the self-link on /dashboard/mitm.
 */
export default function MitmRemoteSteps({ onMitmPage = false }) {
  return (
    <Callout variant="info" icon="lock" title="Set up from a remote dashboard">
      <ol className="m-0 flex list-decimal flex-col gap-1.5 ps-5 text-[13px] text-muted">
        <li>
          On the host, open the dashboard at localhost and start the MITM server on{" "}
          <span className="font-mono text-text">/dashboard/mitm</span> with the router URL and an
          API key.
        </li>
        <li>
          Trust the root CA on the host: use the trust button there, or install{" "}
          <span className="font-mono text-text">mitm/rootCA.crt</span> from the data dir{" "}
          <span className="font-mono text-text">~/.{ACTIVE.dataDirName}</span> by hand.
        </li>
        <li>
          Point the tool’s hosts at the MITM: start DNS on the host, or add the hosts lines shown
          below to the host’s hosts file by hand.
        </li>
        <li>
          Map models. Requests for unmapped models pass through to the original service unchanged
          {onMitmPage ? "." : null}
          {onMitmPage ? null : (
            <>
              {" "}
              (
              <Link href="/dashboard/mitm" className={LINK_CLASS}>
                Map models
              </Link>
              ).
            </>
          )}
        </li>
        <li>Restart the IDE.</li>
      </ol>
      <p className="text-[13px] text-muted">
        The IDE must run on the same machine as {ACTIVE.name}.
      </p>
    </Callout>
  );
}

MitmRemoteSteps.propTypes = {
  onMitmPage: PropTypes.bool,
};
