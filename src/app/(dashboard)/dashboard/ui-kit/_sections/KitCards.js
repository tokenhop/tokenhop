"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";

/** Kit section: cards, section cards and setting rows. */
export default function KitCards() {
  const [requireKey, setRequireKey] = useState(true);
  return (
    <section aria-labelledby="kit-cards" className="flex flex-col gap-4">
      <h2 id="kit-cards" className="font-display text-xl font-bold">
        Cards and settings
      </h2>
      <SectionCard
        icon="shield"
        title="Security & access"
        subtitle={<span dir="auto">Who can reach the dashboard and the API.</span>}
        status="ok"
        statusLabel="Protected"
      />
      <Card>
        <Card.Header
          title="Combos"
          subtitle="Fallback chains"
          actions={
            <Button variant="ghost" size="sm">
              All combos
            </Button>
          }
        />
        <div className="mt-4 divide-y divide-line">
          <SettingRow
            label="Require API key"
            description={
              <span dir="auto">Requests without a valid key get a 401. Needed for the tunnel.</span>
            }
            settingKey="requireApiKey"
            control={
              <Toggle checked={requireKey} onChange={setRequireKey} aria-label="Require API key" />
            }
          />
          <SettingRow
            label="Outbound proxy"
            description={<span dir="auto">Send OAuth and provider calls through a proxy.</span>}
            settingKey="outboundProxyEnabled"
            control={
              <Button variant="secondary" size="sm">
                Test proxy
              </Button>
            }
          />
        </div>
      </Card>
    </section>
  );
}
