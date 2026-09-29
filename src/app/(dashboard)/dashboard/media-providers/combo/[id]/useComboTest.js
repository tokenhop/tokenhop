"use client";

import { useEffect, useRef, useState } from "react";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";
import { EXAMPLE_PATHS, exampleBodyFor, maskB64 } from "./mediaComboConfig";

/** Kind-specific media probe with ref-tracked blob URL cleanup. */
export function useComboTest(combo, apiKey) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");
  const testUrlsRef = useRef({ image: "", audio: "" });
  const [testUrls] = useState(() => createObjectUrlRegistry(testUrlsRef));

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup on unmount only
  useEffect(() => testUrls.revokeAll, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    testUrls.clear();
    const start = Date.now();
    try {
      const path = EXAMPLE_PATHS[combo.kind];
      const body = exampleBodyFor(combo.kind, combo.name);
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`/api${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setTestError(d?.error?.message || d?.error || `HTTP ${res.status}`);
        setTestResult({ json: JSON.stringify(d, null, 2), latencyMs });
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      if (ctype.startsWith("image/")) {
        const nextUrl = URL.createObjectURL(await res.blob());
        testUrls.setImage(nextUrl);
        setTestResult({ imageUrl: nextUrl, latencyMs });
        return;
      }
      if (ctype.startsWith("audio/") || ctype === "application/octet-stream") {
        const nextUrl = URL.createObjectURL(await res.blob());
        testUrls.setAudio(nextUrl);
        setTestResult({ audioUrl: nextUrl, latencyMs });
        return;
      }
      const data = await res.json();
      const first = data?.data?.[0];
      const imageUrl = first?.b64_json
        ? `data:image/png;base64,${first.b64_json}`
        : first?.url || "";
      setTestResult({ json: JSON.stringify(maskB64(data), null, 2), imageUrl, latencyMs });
    } catch (e) {
      setTestError(e?.message || "Network error");
    } finally {
      setTesting(false);
    }
  };

  return { testing, testResult, testError, handleTest };
}
