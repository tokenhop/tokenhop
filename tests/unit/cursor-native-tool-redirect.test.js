import { describe, expect, it, vi } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { redirectNativeExec } from "../../open-sse/utils/cursorNativeToolRedirect.js";
import {
  decodeMessage,
  encodeField,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";

const VARINT = 0;
const LEN = 2;

// --- arg encoders matching agent.proto field numbers ----------------------

// ReadArgs { path=1, tool_call_id=2, offset=4 (int32), limit=5 (uint32) }
function readArgs({ path = "/tmp/a.ts", callId = "native-call-1", offset, limit } = {}) {
  const parts = [encodeField(1, LEN, path), encodeField(2, LEN, callId)];
  if (offset !== undefined) parts.push(encodeField(4, VARINT, offset));
  if (limit !== undefined) parts.push(encodeField(5, VARINT, limit));
  return Buffer.concat(parts.map(Buffer.from));
}

// GrepArgs { pattern=1, path=2, glob=3, output_mode=4, context_before=5,
//   context_after=6, context=7, case_insensitive=8, type=9, head_limit=10,
//   multiline=11, tool_call_id=14 }
function grepArgs({
  pattern = "TODO",
  path = "src",
  glob,
  outputMode,
  context,
  contextBefore,
  contextAfter,
  caseInsensitive,
  type,
  headLimit,
  multiline,
  callId = "native-grep-1",
} = {}) {
  const parts = [encodeField(1, LEN, pattern), encodeField(14, LEN, callId)];
  if (path !== undefined) parts.push(encodeField(2, LEN, path));
  if (glob !== undefined) parts.push(encodeField(3, LEN, glob));
  if (outputMode !== undefined) parts.push(encodeField(4, LEN, outputMode));
  if (context !== undefined) parts.push(encodeField(7, VARINT, context));
  if (contextBefore !== undefined) parts.push(encodeField(5, VARINT, contextBefore));
  if (contextAfter !== undefined) parts.push(encodeField(6, VARINT, contextAfter));
  if (caseInsensitive !== undefined) parts.push(encodeField(8, VARINT, caseInsensitive ? 1 : 0));
  if (type !== undefined) parts.push(encodeField(9, LEN, type));
  if (headLimit !== undefined) parts.push(encodeField(10, VARINT, headLimit));
  if (multiline !== undefined) parts.push(encodeField(11, VARINT, multiline ? 1 : 0));
  return Buffer.concat(parts.map(Buffer.from));
}

// LsArgs { path=1, ignore=2 (repeated), tool_call_id=3 }
function lsArgs({ path = "/repo", ignore = [], callId = "native-ls-1" } = {}) {
  const parts = [encodeField(1, LEN, path)];
  for (const entry of ignore) parts.push(encodeField(2, LEN, entry));
  parts.push(encodeField(3, LEN, callId));
  return Buffer.concat(parts.map(Buffer.from));
}

// ShellArgs { command=1, working_directory=2, timeout=3, tool_call_id=4,
//   is_background=11, description=15 }
function shellArgs({
  command = "ls -la",
  workingDirectory,
  timeout,
  callId = "native-shell-1",
  isBackground = false,
  description,
} = {}) {
  const parts = [
    encodeField(1, LEN, command),
    encodeField(4, LEN, callId),
    encodeField(11, VARINT, isBackground ? 1 : 0),
  ];
  if (workingDirectory !== undefined) parts.push(encodeField(2, LEN, workingDirectory));
  if (timeout !== undefined) parts.push(encodeField(3, VARINT, timeout));
  if (description !== undefined) parts.push(encodeField(15, LEN, description));
  return Buffer.concat(parts.map(Buffer.from));
}

// agent.v1.AgentServerMessage.exec_request (field 2) wrapping an
// ExecServerMessage whose variant args sit at `variant`.
function execRequestMap(variant, args) {
  const execServerMessage = Buffer.concat([
    Buffer.from(encodeField(1, VARINT, 7)), // id
    Buffer.from(encodeField(variant, LEN, args)),
    Buffer.from(encodeField(15, LEN, "exec-1")), // exec_id
  ]);
  const frame = wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage));
  const serverMessage = decodeMessage(frame.subarray(5));
  return decodeMessage(serverMessage.get(2)[0].value);
}

// OpenAI-shaped tool; `properties` map property name → JSON schema fragment.
const fn = (name, properties, required = []) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties, required } },
});

describe("redirectNativeExec", () => {
  it("redirects a native read onto an OpenCode-style read {filePath, offset, limit}", () => {
    const result = redirectNativeExec(
      execRequestMap(7, readArgs({ path: "/tmp/a.ts", offset: 40, limit: 80 })),
      [
        fn("read", {
          filePath: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        }),
      ],
    );

    expect(result.toolCall).toEqual({
      id: "native-call-1",
      name: "read",
      arguments: JSON.stringify({ filePath: "/tmp/a.ts", offset: 40, limit: 80 }),
    });
    expect(result.message).toBe("AgentService redirected native exec variant=7 (read) -> read");
  });

  it("keeps the client's declared casing when redirecting onto Claude-style Read", () => {
    const result = redirectNativeExec(execRequestMap(7, readArgs({ path: "/tmp/b.ts" })), [
      fn("Read", { file_path: { type: "string" } }),
    ]);

    expect(result.toolCall.name).toBe("Read");
    expect(JSON.parse(result.toolCall.arguments)).toEqual({ file_path: "/tmp/b.ts" });
  });

  it("keeps an explicit offset of 0 and drops a limit of 0", () => {
    const result = redirectNativeExec(
      execRequestMap(7, readArgs({ path: "/tmp/a.ts", offset: 0, limit: 0 })),
      [
        fn("read", {
          filePath: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        }),
      ],
    );

    expect(JSON.parse(result.toolCall.arguments)).toEqual({ filePath: "/tmp/a.ts", offset: 0 });
  });

  it("redirects a native grep with pattern/path/include and context flags", () => {
    const result = redirectNativeExec(
      execRequestMap(
        5,
        grepArgs({
          pattern: "TODO",
          path: "src",
          glob: "*.js",
          context: 3,
          caseInsensitive: true,
          headLimit: 50,
          outputMode: "content",
        }),
      ),
      [
        fn("grep", {
          pattern: { type: "string" },
          path: { type: "string" },
          include: { type: "string" },
          "-C": { type: "integer" },
          case_insensitive: { type: "boolean" },
          head_limit: { type: "integer" },
          output_mode: { type: "string" },
        }),
      ],
    );

    expect(JSON.parse(result.toolCall.arguments)).toEqual({
      pattern: "TODO",
      path: "src",
      include: "*.js",
      "-C": 3,
      case_insensitive: true,
      head_limit: 50,
      output_mode: "content",
    });
  });

  it("returns null for a multiline grep when the target cannot express it", () => {
    const result = redirectNativeExec(
      execRequestMap(5, grepArgs({ pattern: "a\nb", multiline: true })),
      [fn("grep", { pattern: { type: "string" }, path: { type: "string" } })],
    );
    expect(result).toBeNull();
  });

  it("redirects a native shell_stream onto bash and fills a required description from the command", () => {
    const longCommand =
      `git log --oneline -n 500 --no-decorate --all --pretty=format:%h%x09%ad%x09%s ${"--pad ".repeat(30)}`.trim();
    const result = redirectNativeExec(
      execRequestMap(
        14,
        shellArgs({ command: longCommand, workingDirectory: "/repo", timeout: 30000 }),
      ),
      [
        fn(
          "bash",
          {
            command: { type: "string" },
            description: { type: "string" },
            workdir: { type: "string" },
            timeout: { type: "integer" },
          },
          ["command", "description"],
        ),
      ],
    );

    expect(result.toolCall.name).toBe("bash");
    const args = JSON.parse(result.toolCall.arguments);
    expect(args.command).toBe(longCommand);
    expect(args.workdir).toBe("/repo");
    expect(args.timeout).toBe(30000);
    // No native description on the wire → fall back to the truncated command.
    expect(args.description).toBe(longCommand.slice(0, 120));
    expect(longCommand.length).toBeGreaterThan(120); // truncation actually exercised
  });

  it("wraps the command for a shell tool whose command property is an array", () => {
    const result = redirectNativeExec(execRequestMap(2, shellArgs({ command: "cargo test" })), [
      fn("shell", { command: { type: "array", items: { type: "string" } } }, ["command"]),
    ]);

    expect(JSON.parse(result.toolCall.arguments)).toEqual({
      command: ["bash", "-lc", "cargo test"],
    });
  });

  it("caps the redirected shell timeout at 600000ms", () => {
    const result = redirectNativeExec(
      execRequestMap(2, shellArgs({ command: "make build", timeout: 9_000_000 })),
      [fn("bash", { command: { type: "string" }, timeout: { type: "integer" } })],
    );

    expect(JSON.parse(result.toolCall.arguments)).toEqual({
      command: "make build",
      timeout: 600000,
    });
  });

  it("returns null when no declared tool can take the native call", () => {
    const result = redirectNativeExec(execRequestMap(7, readArgs()), [
      fn("search_web", { query: { type: "string" } }, ["query"]),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when no candidate matches for an ls with only a glob tool", () => {
    // glob lists file patterns, not directory contents — no honest translation.
    const result = redirectNativeExec(execRequestMap(8, lsArgs()), [
      fn("glob", { pattern: { type: "string" } }, ["pattern"]),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when a required property cannot be filled", () => {
    // list declares a required `depth` the native ls args cannot supply.
    const result = redirectNativeExec(execRequestMap(8, lsArgs()), [
      fn("list", { path: { type: "string" }, depth: { type: "integer" } }, ["path", "depth"]),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when the schema has no property for the primary value", () => {
    // Read with no required fields and no path-like property: an empty
    // read({}) call would be worse than the typed rejection.
    const result = redirectNativeExec(execRequestMap(7, readArgs()), [
      fn("Read", { offset: { type: "integer" }, limit: { type: "integer" } }),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for a background shell", () => {
    const result = redirectNativeExec(
      execRequestMap(2, shellArgs({ command: "npm run watch", isBackground: true })),
      [fn("bash", { command: { type: "string" } })],
    );
    expect(result).toBeNull();
  });

  it("returns null for a read with an empty path", () => {
    const result = redirectNativeExec(execRequestMap(7, readArgs({ path: "" })), [
      fn("read", { filePath: { type: "string" } }, ["filePath"]),
    ]);
    expect(result).toBeNull();
  });

  it("keeps an untyped shell command as a string", () => {
    const result = redirectNativeExec(execRequestMap(2, shellArgs({ command: "ls -la" })), [
      fn("bash", { command: { description: "x" } }),
    ]);
    expect(JSON.parse(result.toolCall.arguments)).toEqual({ command: "ls -la" });
  });

  it("returns null for a case-insensitive grep the schema cannot express", () => {
    const result = redirectNativeExec(
      execRequestMap(5, grepArgs({ pattern: "TODO", caseInsensitive: true })),
      [fn("grep", { pattern: { type: "string" }, path: { type: "string" } })],
    );
    expect(result).toBeNull();
  });

  it("returns null when a grep glob has no include or glob property", () => {
    const result = redirectNativeExec(
      execRequestMap(5, grepArgs({ pattern: "TODO", glob: "*.js" })),
      [fn("grep", { pattern: { type: "string" }, path: { type: "string" } })],
    );
    expect(result).toBeNull();
  });

  it("returns null when the grep glob property cannot hold a string", () => {
    const result = redirectNativeExec(
      execRequestMap(5, grepArgs({ pattern: "TODO", glob: "*.js" })),
      [fn("grep", { pattern: { type: "string" }, include: { type: "array" } })],
    );
    expect(result).toBeNull();
  });

  it("skips tools whose name is not a string", () => {
    const result = redirectNativeExec(execRequestMap(7, readArgs({ path: "/tmp/a.ts" })), [
      { type: "function", function: { name: 42, parameters: { properties: {} } } },
      fn("read", { filePath: { type: "string" } }),
    ]);
    expect(result.toolCall.name).toBe("read");
  });

  it("redirects ls onto list_dir including the ignore list", () => {
    const result = redirectNativeExec(
      execRequestMap(8, lsArgs({ path: "/repo", ignore: ["node_modules", ".git"] })),
      [
        fn("list_dir", {
          path: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
        }),
      ],
    );
    expect(result.toolCall.name).toBe("list_dir");
    expect(JSON.parse(result.toolCall.arguments)).toEqual({
      path: "/repo",
      ignore: ["node_modules", ".git"],
    });
  });

  it("drops an offset whose schema type is not a number", () => {
    const result = redirectNativeExec(
      execRequestMap(7, readArgs({ path: "/tmp/a.ts", offset: 40 })),
      [fn("read", { filePath: { type: "string" }, offset: { type: "string" } })],
    );
    expect(JSON.parse(result.toolCall.arguments)).toEqual({ filePath: "/tmp/a.ts" });
  });

  it("returns null when the shell command property cannot hold a string", () => {
    const result = redirectNativeExec(execRequestMap(2, shellArgs({ command: "ls" })), [
      fn("bash", { command: { type: "integer" } }),
    ]);
    expect(result).toBeNull();
  });

  it("drops a negative read offset", () => {
    const args = Buffer.concat([
      readArgs({ path: "/tmp/a.ts" }),
      Buffer.from(encodeField(4, VARINT, 0x80000000)),
    ]);
    const result = redirectNativeExec(execRequestMap(7, args), [
      fn("read", { filePath: { type: "string" }, offset: { type: "integer" } }),
    ]);
    expect(JSON.parse(result.toolCall.arguments)).toEqual({ filePath: "/tmp/a.ts" });
  });

  it("returns null for an empty grep pattern", () => {
    const result = redirectNativeExec(execRequestMap(5, grepArgs({ pattern: "" })), [
      fn("grep", { pattern: { type: "string" } }, ["pattern"]),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for an empty shell command", () => {
    const result = redirectNativeExec(execRequestMap(2, shellArgs({ command: "" })), [
      fn("bash", { command: { type: "string" } }),
    ]);
    expect(result).toBeNull();
  });

  it("maps a grep glob onto the glob property and a shell command onto cmd", () => {
    const grep = redirectNativeExec(
      execRequestMap(5, grepArgs({ pattern: "TODO", glob: "*.ts" })),
      [fn("grep", { pattern: { type: "string" }, glob: { type: "string" } })],
    );
    expect(JSON.parse(grep.toolCall.arguments)).toEqual({ pattern: "TODO", glob: "*.ts" });

    const shell = redirectNativeExec(execRequestMap(2, shellArgs({ command: "pwd" })), [
      fn("bash", { cmd: { type: "string" } }),
    ]);
    expect(JSON.parse(shell.toolCall.arguments)).toEqual({ cmd: "pwd" });
  });

  it("keeps multiline when the grep schema declares it", () => {
    const result = redirectNativeExec(
      execRequestMap(5, grepArgs({ pattern: "TODO", multiline: true })),
      [fn("grep", { pattern: { type: "string" }, multiline: { type: "boolean" } })],
    );
    expect(JSON.parse(result.toolCall.arguments)).toEqual({
      pattern: "TODO",
      multiline: true,
    });
  });
});

// --- executor-level end to end ---------------------------------------------

// agent.v1.AgentServerMessage.interaction_update (field 1) → text delta.
function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

// exec_request frame carrying native variant args, mirroring the wire order.
function execFrame(variant, args) {
  const execServerMessage = Buffer.concat([
    Buffer.from(encodeField(1, VARINT, 7)),
    Buffer.from(encodeField(variant, LEN, args)),
    Buffer.from(encodeField(15, LEN, "exec-1")),
  ]);
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

// Written AgentClientMessage frame → decoded ExecClientMessage (field 2).
function decodeReply(frame) {
  const clientMessage = decodeMessage(frame.subarray(5));
  return decodeMessage(clientMessage.get(2)[0].value);
}

const sub = (fields, field) => decodeMessage(fields.get(field)[0].value);
const str = (fields, field) => Buffer.from(fields.get(field)[0].value).toString("utf8");

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function runAgent({ frames, tools, model = "grok-4.7" }) {
  const executor = new CursorExecutor();
  const written = [];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {},
    async read() {
      if (!frames.length) return { value: undefined, done: true };
      return { value: frames.shift(), done: false };
    },
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const result = await executor.executeAgent({
    model,
    body: { messages: [{ role: "user", content: "hi" }], tools },
    stream: true,
    credentials,
    log,
  });
  return { result, written, log };
}

describe("CursorExecutor native exec redirect", () => {
  it("emits a tool_call chunk with finish_reason tool_calls for a native read", async () => {
    const { result, log } = await runAgent({
      frames: [execFrame(7, readArgs({ path: "/tmp/a.ts", callId: "native-42" }))],
      tools: [fn("read", { filePath: { type: "string" } }, ["filePath"])],
    });

    const events = parseSSE(await result.response.text());
    const toolCall = events.find((e) => e.choices?.[0]?.delta?.tool_calls?.[0]);
    expect(toolCall.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "native-42",
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ filePath: "/tmp/a.ts" }) },
    });
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(events.some((e) => e.error)).toBe(false);
    // The redirect log line carries names and variants, never argument values.
    const logged = log.info.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("variant=7 (read) -> read");
    expect(logged).not.toContain("/tmp/a.ts");
  });

  it("still writes a FetchResult error frame for an unmapped variant", async () => {
    // fetch (20) is a built-in with no redirect mapping → typed rejection.
    const { result, written } = await runAgent({
      frames: [execFrame(20, encodeField(1, LEN, "https://example.com")), textFrame("ok")],
      tools: [fn("read", { filePath: { type: "string" } }, ["filePath"])],
    });

    const events = parseSSE(await result.response.text());
    expect(events.some((e) => e.error)).toBe(false);
    expect(events.map((e) => e.choices?.[0]?.delta?.content || "").join("")).toContain("ok");
    expect(written.length).toBe(2); // run frame + rejection reply
    // ExecClientMessage.fetch_result (20) → FetchResult.error (2) → error (2).
    const reply = decodeReply(written[1]);
    expect(reply.has(20)).toBe(true);
    expect(str(sub(reply, 20), 2).length).toBeGreaterThan(0);
  });

  it("lets a named MCP call win over a native read in the same exec", async () => {
    const mcpArgs = Buffer.concat([
      Buffer.from(encodeField(3, LEN, "mcp-9")),
      Buffer.from(encodeField(5, LEN, "client_search")),
    ]);
    const execServerMessage = Buffer.concat([
      Buffer.from(encodeField(1, VARINT, 7)),
      Buffer.from(encodeField(7, LEN, readArgs({ path: "/tmp/secret.ts", callId: "native-42" }))),
      Buffer.from(encodeField(11, LEN, mcpArgs)),
      Buffer.from(encodeField(15, LEN, "exec-1")),
    ]);
    const frame = Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
    const { result, written } = await runAgent({
      frames: [frame],
      tools: [fn("read", { filePath: { type: "string" } }, ["filePath"])],
    });

    const events = parseSSE(await result.response.text());
    const toolCall = events.find((e) => e.choices?.[0]?.delta?.tool_calls?.[0]);
    expect(toolCall.choices[0].delta.tool_calls[0].function.name).toBe("client_search");
    expect(toolCall.choices[0].delta.tool_calls[0].id).toBe("mcp-9");
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(written.length).toBe(1);
  });

  it("does not redirect when the request declares no tools", async () => {
    const { result, written } = await runAgent({
      frames: [execFrame(7, readArgs()), textFrame("answer")],
      tools: undefined,
    });

    const events = parseSSE(await result.response.text());
    expect(events.some((e) => e.choices?.[0]?.delta?.tool_calls)).toBe(false);
    expect(written.length).toBe(2); // run frame + read rejection
  });
});
