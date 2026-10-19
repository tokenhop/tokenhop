import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FORCE_HEADER,
  instanceStreamImportCap,
  parseByteSize,
  readHeaderImportAuth,
  snapshotDownloadResponse,
  UPLOAD_MODE_HEADER,
} from "@/lib/users/snapshotUpload.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const req = (headers) => new Request("http://localhost/api/settings/database", { headers });

describe("parseByteSize", () => {
  it("accepts the Next/bytes grammar", () => {
    expect(parseByteSize("128mb")).toBe(128 * MIB);
    expect(parseByteSize("64MB")).toBe(64 * MIB);
    expect(parseByteSize("1.5gb")).toBe(1.5 * GIB);
    expect(parseByteSize("1048576")).toBe(1048576);
    expect(parseByteSize("512 kb")).toBe(512 * 1024);
    expect(parseByteSize("10b")).toBe(10);
    expect(parseByteSize(2048)).toBe(2048);
  });

  it("returns null for bad input", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "mb",
      "-5mb",
      "1.mb",
      "1e3mb",
      "12 xb",
      "0",
      "0mb",
      "NaN",
      "Infinity",
      "1mb2",
      null,
      undefined,
      {},
      [],
      -1,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(parseByteSize(bad), String(bad)).toBeNull();
    }
  });
});

describe("instanceStreamImportCap", () => {
  it("defaults to the 128mb proxy limit", () => {
    expect(instanceStreamImportCap({})).toBe(128 * MIB);
  });

  it("follows TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE", () => {
    expect(instanceStreamImportCap({ TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE: "256mb" })).toBe(
      256 * MIB,
    );
  });

  it("lowers the cap with the instance override", () => {
    expect(instanceStreamImportCap({ TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE: "64mb" })).toBe(
      64 * MIB,
    );
  });

  it("clamps an override above the proxy limit down to it", () => {
    expect(instanceStreamImportCap({ TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE: "1gb" })).toBe(
      128 * MIB,
    );
    expect(
      instanceStreamImportCap({
        TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE: "32mb",
        TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE: "64mb",
      }),
    ).toBe(32 * MIB);
  });

  it("falls back to the proxy limit for an unparseable override, and to the default for a bad proxy value", () => {
    expect(instanceStreamImportCap({ TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE: "lots" })).toBe(
      128 * MIB,
    );
    expect(instanceStreamImportCap({ TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE: "bogus" })).toBe(
      128 * MIB,
    );
  });
});

describe("readHeaderImportAuth", () => {
  it("reads password, proof and passphrase headers; absent ones are null", () => {
    expect(
      readHeaderImportAuth(
        req({ "x-9r-password": "pw", "x-tokenhop-backup-passphrase": "pass phrase" }),
      ),
    ).toEqual({ password: "pw", ssoProof: null, passphrase: "pass phrase", force: false });
    expect(readHeaderImportAuth(req({ "x-tokenhop-sso-proof": "proof" }))).toEqual({
      password: null,
      ssoProof: "proof",
      passphrase: null,
      force: false,
    });
  });

  it("force is true only for the exact value 'true'", () => {
    expect(readHeaderImportAuth(req({ [FORCE_HEADER]: "true" })).force).toBe(true);
    expect(readHeaderImportAuth(req({})).force).toBe(false);
  });

  it("any other present force value is invalid", () => {
    for (const v of ["True", "TRUE", "1", "false", "yes", "", "true,true"]) {
      expect(readHeaderImportAuth(req({ [FORCE_HEADER]: v })), JSON.stringify(v)).toEqual({
        invalid: true,
      });
    }
  });

  it("exposes the upload mode header name", () => {
    expect(UPLOAD_MODE_HEADER).toBe("x-tokenhop-snapshot-upload");
    expect(FORCE_HEADER).toBe("x-tokenhop-import-force");
  });
});

describe("snapshotDownloadResponse", () => {
  it("streams the handle bytes with download headers", async () => {
    const body = Buffer.from('{"schemaVersion":9}');
    let opened = 0;
    const res = snapshotDownloadResponse({
      size: body.length,
      openStream: () => {
        opened += 1;
        return Readable.from([body.subarray(0, 5), body.subarray(5)]);
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(opened).toBe(1);
  });

  it("merges extra headers but never overrides the download headers", async () => {
    const res = snapshotDownloadResponse(
      { size: 2, openStream: () => Readable.from([Buffer.from("{}")]) },
      { "Content-Disposition": 'attachment; filename="b.json"', "Cache-Control": "public" },
    );
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="b.json"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("{}");
  });
});
