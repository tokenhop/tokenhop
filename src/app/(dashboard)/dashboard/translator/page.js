"use client";

import { useState, useRef } from "react";
import { Card, Button, StatusPill, Callout, ProviderTile } from "@/shared/components";
import TranslatorStep from "./TranslatorStep";
// 7 steps matching requestLogger files exactly
const STEPS = [
  {
    id: 1,
    label: "Client Request",
    file: "1_req_client.json",
    lang: "json",
    desc: "Raw request from client",
  },
  {
    id: 2,
    label: "Source Body",
    file: "2_req_source.json",
    lang: "json",
    desc: "After initial conversion",
  },
  {
    id: 3,
    label: "OpenAI Intermediate",
    file: "3_req_openai.json",
    lang: "json",
    desc: "source → openai",
  },
  {
    id: 4,
    label: "Target Request",
    file: "4_req_target.json",
    lang: "json",
    desc: "openai → target + URL + headers",
  },
  {
    id: 5,
    label: "Provider Response",
    file: "5_res_provider.txt",
    lang: "text",
    desc: "Raw SSE from provider",
  },
  {
    id: 6,
    label: "OpenAI Response",
    file: "6_res_openai.txt",
    lang: "text",
    desc: "target → openai (response)",
  },
  {
    id: 7,
    label: "Client Response",
    file: "7_res_client.txt",
    lang: "text",
    desc: "Final response to client",
  },
];

const META_VARIANTS = {
  sourceFormat: "info",
  targetFormat: "brand",
  provider: "live",
  model: "neutral",
};

/**
 * Translator debug page: replay the request pipeline step by step against the
 * translator log files. Request flow and log filenames are unchanged.
 */
export default function TranslatorPage() {
  const [contents, setContents] = useState({});
  const [expanded, setExpanded] = useState({ 1: true });
  const [loading, setLoading] = useState({});
  const [pageError, setPageError] = useState("");
  // Detected from step 1: { provider, model, sourceFormat, targetFormat }
  const [meta, setMeta] = useState(null);

  const setLoad = (key, val) => setLoading((prev) => ({ ...prev, [key]: val }));
  const detectMetaRef = useRef(0);
  const detectTimerRef = useRef(null);
  const setContent = (id, val) => {
    setContents((prev) => ({ ...prev, [id]: val }));
    // Debounced meta detection for step 1: only the latest keystroke batch resolves.
    if (id === 1) {
      detectMetaRef.current += 1;
      const seq = detectMetaRef.current;
      clearTimeout(detectTimerRef.current);
      detectTimerRef.current = setTimeout(() => {
        void detectMeta(val, seq);
      }, 400);
    }
  };
  const toggle = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const openNext = (nextId) =>
    setExpanded(Object.fromEntries(STEPS.map((s) => [s.id, s.id === nextId])));

  // Load file from logs/translator/
  const handleLoad = async (stepId) => {
    const step = STEPS.find((s) => s.id === stepId);

    setPageError("");
    setLoad(`load-${stepId}`, true);
    try {
      const res = await fetch(`/api/translator/load?file=${step.file}`);
      const data = await res.json();
      if (data.success) {
        setContent(stepId, data.content);
      } else {
        setPageError(data.error || "File not found");
      }
    } catch (e) {
      setPageError(e.message);
    }
    setLoad(`load-${stepId}`, false);
  };

  // Step 1: detect provider/format from model field. `seq` guards against
  // stale responses: only the latest debounced call may update meta.
  const detectMeta = async (rawContent, seq) => {
    try {
      const body = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
      const res = await fetch("/api/translator/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 1, body }),
      });
      const data = await res.json();
      if (data.success && (seq === undefined || seq === detectMetaRef.current))
        setMeta(data.result);
    } catch {
      /* ignore */
    }
  };

  const save = (file, content) =>
    fetch("/api/translator/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, content }),
    }).catch(() => {});

  // Step 1 → Step 3: source → OpenAI intermediate
  const handleToOpenAI = async () => {
    setPageError("");
    setLoad("toOpenAI", true);
    try {
      const raw = contents[1];
      const body = JSON.parse(raw);
      // Save input: 1_req_client.json + 2_req_source.json (body only)
      save("1_req_client.json", raw);
      save(
        "2_req_source.json",
        JSON.stringify(
          { timestamp: new Date().toISOString(), headers: {}, body: body.body || body },
          null,
          2,
        ),
      );

      const res = await fetch("/api/translator/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 2, body }),
      });
      const data = await res.json();
      if (!data.success) {
        setPageError(data.error);
        return;
      }
      const str = JSON.stringify(data.result.body, null, 2);
      setContent(3, str);
      openNext(3);
    } catch (e) {
      setPageError(e.message);
    }
    setLoad("toOpenAI", false);
  };

  // Step 3 → Step 4: OpenAI → target + build URL/headers
  const handleToTarget = async () => {
    setPageError("");
    setLoad("toTarget", true);
    try {
      const raw = contents[3];
      const openaiBody = JSON.parse(raw);
      // Save input: 3_req_openai.json
      save("3_req_openai.json", raw);

      const res = await fetch("/api/translator/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: 3,
          body: { ...openaiBody, provider: meta?.provider, model: meta?.model },
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setPageError(data.error);
        return;
      }
      // Embed provider + model so Send works even without meta
      const step4Content = { ...data.result, provider: meta?.provider, model: meta?.model };
      setContent(4, JSON.stringify(step4Content, null, 2));
      openNext(4);
    } catch (e) {
      setPageError(e.message);
    }
    setLoad("toTarget", false);
  };

  // Step 4 → Step 5: send to provider via executor
  const handleSend = async () => {
    setPageError("");
    setLoad("send", true);
    try {
      const raw = contents[4];
      const step4 = JSON.parse(raw);
      // Save input: 4_req_target.json
      save("4_req_target.json", raw);

      // Read provider/model from step4 content (embedded during build), fallback to meta
      const provider = step4.provider || meta?.provider;
      const model = step4.model || meta?.model;

      if (!provider || !model) {
        setPageError("Missing provider or model. Please run step 1 first to detect them.");
        return;
      }

      const res = await fetch("/api/translator/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, body: step4.body || step4 }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setPageError(err.error || "Send failed");
        return;
      }

      // Accumulate streaming response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
      }

      setContent(5, full);
      openNext(5);

      // Save to logs/translator/5_res_provider.txt
      await fetch("/api/translator/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "5_res_provider.txt", content: full }),
      });
    } catch (e) {
      setPageError(e.message);
    } finally {
      setLoad("send", false);
    }
  };

  // Render action button per step
  const getAction = (stepId) => {
    if (stepId === 1)
      return (
        <Button size="sm" icon="arrow_forward" loading={loading.toOpenAI} onClick={handleToOpenAI}>
          To OpenAI
        </Button>
      );
    if (stepId === 3)
      return (
        <Button size="sm" icon="arrow_forward" loading={loading.toTarget} onClick={handleToTarget}>
          To target
        </Button>
      );
    if (stepId === 4)
      return (
        <Button size="sm" icon="send" loading={loading.send} onClick={handleSend}>
          Send
        </Button>
      );
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle">Debug</p>
          <h2 className="font-display text-[28px] font-bold tracking-[-0.02em] text-text">
            Translator debug
          </h2>
          <p className="mt-1 text-sm text-muted">Replay request flow — matches log files</p>
        </div>
        {meta && (
          <Card padding="xs" className="flex flex-wrap items-center gap-2" role="status">
            {["sourceFormat", "targetFormat", "provider", "model"].map((key) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                {key === "provider" && meta.provider && (
                  <ProviderTile providerId={meta.provider} size="sm" />
                )}
                <StatusPill variant={META_VARIANTS[key]} size="sm">
                  <span className="opacity-70">{key}:</span> {meta[key]}
                </StatusPill>
              </span>
            ))}
          </Card>
        )}
      </div>

      {pageError && (
        <Callout variant="err" title="Translator step failed">
          {pageError}
        </Callout>
      )}

      {STEPS.map((step) => (
        <TranslatorStep
          key={step.id}
          step={step}
          isExpanded={!!expanded[step.id]}
          content={contents[step.id] || ""}
          onToggle={toggle}
          onContentChange={setContent}
          onLoad={() => handleLoad(step.id)}
          loadLoading={loading[`load-${step.id}`]}
          action={getAction(step.id)}
        />
      ))}
    </div>
  );
}
