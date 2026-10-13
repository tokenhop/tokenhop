// Console capture buffer must not become a persistence path for credentials
// interpolated into server console output (YAN-378). Lines are redacted at the
// storage boundary; ordinary operational text is unchanged.
import { describe, expect, it } from "vitest";
import { clearConsoleLogs, getConsoleLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer.js";
import { makeSentinels } from "../helpers/secretScan.js";

const SENT = makeSentinels();

describe("console log buffer redaction", () => {
  initConsoleLogCapture();

  it("redacts sk- and JWT values from warn lines", () => {
    clearConsoleLogs();
    console.warn(`upstream failed with ${SENT.connectionApiKey} and ${SENT.bearerJwt}`);
    const logs = getConsoleLogs();
    expect(logs.join("\n")).not.toContain(SENT.connectionApiKey);
    expect(logs.join("\n")).not.toContain(SENT.bearerJwt);
    expect(logs.join("\n")).toContain("[REDACTED]");
  });

  it("keeps ordinary operational output", () => {
    clearConsoleLogs();
    console.info("POST /v1/chat/completions model=coder max_tokens=4096");
    expect(getConsoleLogs().join("\n")).toContain(
      "POST /v1/chat/completions model=coder max_tokens=4096",
    );
    clearConsoleLogs();
  });
});
