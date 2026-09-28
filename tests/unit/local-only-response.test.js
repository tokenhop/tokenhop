import { describe, expect, it } from "vitest";
import { isLocalOnlyResponse, LOCAL_ONLY_CODE } from "@/shared/utils/localOnly";

const json = (status, body) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("isLocalOnlyResponse (YAN-415)", () => {
  it("detects the guard's local-only 403 and leaves the body readable", async () => {
    const res = json(403, { error: "Local only: CLI token required", code: LOCAL_ONLY_CODE });
    expect(await isLocalOnlyResponse(res)).toBe(true);
    expect((await res.json()).code).toBe("LOCAL_ONLY");
  });

  it("keeps privilege 403s and other errors on the normal error path", async () => {
    expect(
      await isLocalOnlyResponse(
        json(403, { error: "Root or sudo password required to start MITM" }),
      ),
    ).toBe(false);
    expect(await isLocalOnlyResponse(json(500, { code: LOCAL_ONLY_CODE }))).toBe(false);
    expect(await isLocalOnlyResponse(json(403, "not json"))).toBe(false);
    expect(await isLocalOnlyResponse(json(200, { installed: true }))).toBe(false);
  });
});
