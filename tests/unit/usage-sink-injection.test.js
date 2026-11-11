import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../open-sse");
const sink = await import("../../open-sse/services/usageSink.js");

afterEach(() => sink.setUsageSink(null));

describe("usageSink", () => {
  it("is a silent no-op with nothing installed", async () => {
    expect(sink.trackPendingRequest("m", "p", "c", true)).toBeUndefined();
    await expect(sink.appendRequestLog({})).resolves.toBeUndefined();
    await expect(sink.saveRequestDetailUnscoped({})).resolves.toBeUndefined();
    await expect(sink.saveRequestUsageUnscoped({})).resolves.toBeUndefined();
  });

  it("forwards every call to the installed sink", async () => {
    const impl = {
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
      saveRequestDetailUnscoped: vi.fn(async () => {}),
      saveRequestUsageUnscoped: vi.fn(async () => {}),
    };
    sink.setUsageSink(impl);
    sink.trackPendingRequest("m", "p", "c", true);
    await sink.appendRequestLog({ a: 1 });
    await sink.saveRequestDetailUnscoped({ b: 2 });
    await sink.saveRequestUsageUnscoped({ c: 3 });
    expect(impl.trackPendingRequest).toHaveBeenCalledWith("m", "p", "c", true);
    expect(impl.appendRequestLog).toHaveBeenCalledWith({ a: 1 });
    expect(impl.saveRequestDetailUnscoped).toHaveBeenCalledWith({ b: 2 });
    expect(impl.saveRequestUsageUnscoped).toHaveBeenCalledWith({ c: 3 });
  });
});

describe("open-sse stays free of the app's db layer", () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
    });

  it("imports neither usageDb nor the db layer", () => {
    const offenders = walk(root).filter((f) =>
      /(from|import\()\s*["'](@\/lib\/(usageDb|db\/|localDb)|(\.\.\/)+src\/lib\/db\/)/.test(
        fs.readFileSync(f, "utf8"),
      ),
    );
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
