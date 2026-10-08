"use client";

import { createContext } from "react";

/** `{ workspaceId } | null`, provided by the settings page when multi-user is active (YAN-371). */
export const SettingsScopeContext = createContext(null);
