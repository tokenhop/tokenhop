"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ACTIVE } from "@/shared/brand";
import { browserPlatform } from "@/lib/cliToolConfigs/shared";

const PLATFORMS = ["darwin", "linux", "win32"];

/** OS the manual setup dialog builds paths for; defaults to the browser's, remembered per viewer. */
export const useManualSetupStore = create(
  persist(
    (set) => ({
      platform: browserPlatform(),
      setPlatform: (platform) => set({ platform }),
    }),
    {
      name: `${ACTIVE.storageKeyPrefix}manual-setup`,
      // A hand-edited or stale value falls back to the browser's OS.
      merge: (stored, current) => ({
        ...current,
        ...(PLATFORMS.includes(stored?.platform) && { platform: stored.platform }),
      }),
    },
  ),
);

export const useManualPlatform = () => useManualSetupStore((s) => s.platform);
