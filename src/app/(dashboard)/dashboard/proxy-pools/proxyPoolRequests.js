/** Request helpers shared by proxy-pool actions. */
export const JSON_HEADERS = { "Content-Type": "application/json" };
export const DEPLOY_ENDPOINTS = {
  cloudflare: "/api/proxy-pools/cloudflare-deploy",
  vercel: "/api/proxy-pools/vercel-deploy",
  deno: "/api/proxy-pools/deno-deploy",
};

export async function apiJson(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { res, data };
}

/** PUT/DELETE one pool. "ok" | "blocked" (409) | "failed" (other status or throw). */
export async function mutate(id, method, body) {
  try {
    const { res } = await apiJson(`/api/proxy-pools/${id}`, {
      method,
      headers: JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return "ok";
    return res.status === 409 ? "blocked" : "failed";
  } catch {
    return "failed";
  }
}

/** Check pools concurrently; report each completed test to the caller. */
export async function testHealth(targets, onProgress) {
  let alive = 0;
  let done = 0;
  const deadIds = [];
  const queue = [...targets];
  const worker = async () => {
    while (queue.length > 0) {
      const pool = queue.shift();
      if (!pool) break;
      try {
        const { res, data } = await apiJson(`/api/proxy-pools/${pool.id}/test`, {
          method: "POST",
        });
        if (res.ok && data?.ok) alive += 1;
        else deadIds.push(pool.id);
      } catch {
        deadIds.push(pool.id);
      } finally {
        done += 1;
        onProgress(done);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, targets.length) }, () => worker()));
  return { alive, deadIds };
}

/** Import entries one at a time; skip existing URL/no-proxy combinations. */
export async function importEntries(entries, pools) {
  const existingKeys = new Set(
    pools.map((pool) => `${(pool.proxyUrl || "").trim()}|||${(pool.noProxy || "").trim()}`),
  );
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of entries) {
    const dedupeKey = `${entry.proxyUrl}|||`;
    if (existingKeys.has(dedupeKey)) {
      skipped += 1;
      continue;
    }
    try {
      const { res } = await apiJson("/api/proxy-pools", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: entry.name,
          proxyUrl: entry.proxyUrl,
          noProxy: "",
          isActive: true,
        }),
      });
      if (res.ok) {
        created += 1;
        existingKeys.add(dedupeKey);
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { created, skipped, failed };
}
