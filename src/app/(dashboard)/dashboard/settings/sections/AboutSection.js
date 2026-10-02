"use client";

import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Button from "@/shared/components/Button";
import CopyField from "@/shared/components/CopyField";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import { resolveVersionChip } from "@/shared/utils/shell";
import { ACTIVE } from "@/shared/brand";

/**
 * About section: version, build channel, and the project links. Static data
 * only — everything comes from APP_CONFIG and the brand module at build time.
 */
export default function AboutSection() {
  const { label, full } = resolveVersionChip(APP_CONFIG.version, APP_CONFIG.build);

  return (
    <div id="about" className="scroll-mt-24 space-y-4">
      <SectionCard icon="info" title="About" subtitle="Version and project information." />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Version"
          description={full !== label ? full : undefined}
          settingKey="APP_VERSION"
          control={
            <div className="w-full sm:min-w-72 sm:max-w-sm">
              <CopyField value={label} />
            </div>
          }
        />
        <SettingRow
          label="Project"
          description="Source, docs and releases on GitHub."
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon="open_in_new"
                onClick={() => window.open(ACTIVE.repoUrl, "_blank", "noopener")}
              >
                GitHub
              </Button>
              {ACTIVE.docsUrl && (
                <Button
                  variant="secondary"
                  icon="menu_book"
                  onClick={() => window.open(ACTIVE.docsUrl, "_blank", "noopener")}
                >
                  Docs
                </Button>
              )}
              <Button
                variant="secondary"
                icon="history"
                onClick={() => window.open(`${ACTIVE.repoUrl}/releases`, "_blank", "noopener")}
              >
                Releases
              </Button>
            </div>
          }
        />
        <SettingRow
          label="License"
          description="MIT — free to use, modify and distribute."
          control={
            <Button
              variant="secondary"
              icon="open_in_new"
              onClick={() =>
                window.open(`${ACTIVE.repoUrl}/blob/master/LICENSE`, "_blank", "noopener")
              }
            >
              MIT
            </Button>
          }
        />
      </div>
    </div>
  );
}
