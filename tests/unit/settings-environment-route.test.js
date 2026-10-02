// YAN-335: Settings → Data shows the real database path from the server.
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("GET /api/settings/environment", () => {
  it("returns the database file inside the resolved data dir", async () => {
    // The isolateDataDir setup file points DATA_DIR at a per-file temp dir.
    expect(process.env.DATA_DIR).toBeTruthy();
    const { GET } = await import("@/app/api/settings/environment/route.js");
    const res = await GET(new Request("http://localhost/api/settings/environment"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dataDir).toBe(process.env.DATA_DIR);
    expect(body.databaseFile).toBe(path.join(process.env.DATA_DIR, "db", "data.sqlite"));
  });
});
