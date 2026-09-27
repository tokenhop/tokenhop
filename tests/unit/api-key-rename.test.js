// API key name validation: POST create and PUT rename share validateKeyName; invalid names never persist.
import { describe, it, expect, beforeAll } from "vitest";
import { validateKeyName } from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";

let db;
let PUT;
let POST;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ PUT } = await import("@/app/api/keys/[id]/route.js"));
  ({ POST } = await import("@/app/api/keys/route.js"));
});

const post = (body) =>
  POST(new Request("http://localhost/api/keys", { method: "POST", body: JSON.stringify(body) }));

const put = (id, body) =>
  PUT(
    new Request(`http://localhost/api/keys/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );

describe("validateKeyName", () => {
  it.each([
    [undefined, "Name is required"],
    [null, "Name is required"],
    [42, "Name is required"],
    ["", "Name is required"],
    ["   ", "Name is required"],
    ["a".repeat(65), "Name must be 64 characters or fewer"],
    ["bad\nname", "Name can't include control characters"],
    ["tab\there", "Name can't include control characters"],
  ])("rejects %j", (name, error) => {
    expect(validateKeyName(name)).toBe(error);
  });

  it("accepts 64 chars and ignores surrounding whitespace", () => {
    expect(validateKeyName("a".repeat(64))).toBeNull();
    expect(validateKeyName(`  ${"a".repeat(64)}  `)).toBeNull();
    expect(validateKeyName("Laptop key")).toBeNull();
  });
});

describe("PUT /api/keys/[id] rename", () => {
  it("renames with trimmed name and keeps other fields", async () => {
    const created = await db.createApiKey("Old", "machine-1");
    const res = await put(created.id, { name: "  New name  " });
    expect(res.status).toBe(200);
    const { key } = await res.json();
    expect(key.name).toBe("New name");
    expect(key.key).toBe(created.key);
    expect(key.isActive).toBe(true);
    expect((await db.getApiKeyById(created.id)).name).toBe("New name");
  });

  it.each([
    ["", "Name is required"],
    [null, "Name is required"],
    ["a".repeat(65), "Name must be 64 characters or fewer"],
    ["x\u0007y", "Name can't include control characters"],
  ])("rejects %j with 400 and no write", async (name, error) => {
    const created = await db.createApiKey("Keep", "machine-1");
    const res = await put(created.id, { name, isActive: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    const stored = await db.getApiKeyById(created.id);
    expect(stored.name).toBe("Keep");
    expect(stored.isActive).toBe(true);
  });

  it("toggle without name leaves name untouched", async () => {
    const created = await db.createApiKey("Toggle", "machine-1");
    const res = await put(created.id, { isActive: false });
    expect(res.status).toBe(200);
    const stored = await db.getApiKeyById(created.id);
    expect(stored).toMatchObject({ name: "Toggle", isActive: false });
  });

  it("returns 404 for unknown id before validating", async () => {
    const res = await put("missing", { name: "" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/keys create", () => {
  const count = async () => (await db.getApiKeys()).length;

  it("creates with trimmed name", async () => {
    const before = await count();
    const res = await post({ name: "  New  " });
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe("New");
    expect(await count()).toBe(before + 1);
  });

  it.each([
    ["", "Name is required"],
    ["   ", "Name is required"],
    ["a".repeat(65), "Name must be 64 characters or fewer"],
    ["xy", "Name can't include control characters"],
  ])("rejects %j with 400 and no write", async (name, error) => {
    const before = await count();
    const res = await post({ name });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(await count()).toBe(before);
  });
});
