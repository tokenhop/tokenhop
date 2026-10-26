/**
 * Cursor AgentService built-in exec → declared client tool call.
 *
 * Some models (e.g. Grok 4.7) prefer Cursor's native IDE tools over the
 * declared MCP tools and give up when those are rejected. When a native exec
 * (read/grep/ls/shell) can be translated onto a declared tool's schema, the
 * executor emits it as the client's own tool_call instead of rejecting it.
 *
 * Field numbers come from agent.proto (can1357/oh-my-pi, mirrored by
 * enderzcx/cursor-agent2api, 2026-09).
 */
import { decodeMessage, decodeStringField } from "./cursorProtobuf.js";
import { execVariant } from "./cursorAgentExec.js";

// ExecServerMessage oneof fields that carry a translatable built-in.
const NATIVE_VARIANTS = {
  2: "shell",
  5: "grep",
  7: "read",
  8: "ls",
  14: "shell", // shell_stream_args carries the same ShellArgs message
};

// read: ReadArgs { path=1, tool_call_id=2, offset=4 (int32), limit=5 (uint32) }
const READ = { PATH: 1, CALL_ID: 2, OFFSET: 4, LIMIT: 5 };
// grep: GrepArgs { pattern=1, path=2, glob=3, output_mode=4, context_before=5,
//   context_after=6, context=7, case_insensitive=8, type=9, head_limit=10,
//   multiline=11, tool_call_id=14 }
const GREP = {
  PATTERN: 1,
  PATH: 2,
  GLOB: 3,
  OUTPUT_MODE: 4,
  CONTEXT_BEFORE: 5,
  CONTEXT_AFTER: 6,
  CONTEXT: 7,
  CASE_INSENSITIVE: 8,
  TYPE: 9,
  HEAD_LIMIT: 10,
  MULTILINE: 11,
  CALL_ID: 14,
};
// ls: LsArgs { path=1, ignore=2 (repeated), tool_call_id=3 }
const LS = { PATH: 1, IGNORE: 2, CALL_ID: 3 };
// shell: ShellArgs { command=1, working_directory=2, timeout=3 (ms),
//   tool_call_id=4, is_background=11, description=15 }
const SHELL = {
  COMMAND: 1,
  WORKING_DIRECTORY: 2,
  TIMEOUT: 3,
  CALL_ID: 4,
  IS_BACKGROUND: 11,
  DESCRIPTION: 15,
};
const SHELL_TIMEOUT_CAP_MS = 600000;

// Candidate client-tool names per native tool, in priority order; the first
// one declared with a fillable schema wins.
const TARGETS = {
  read: ["read", "read_file", "view_file"],
  grep: ["grep", "grep_search"],
  ls: ["ls", "list", "list_dir", "list_directory"],
  shell: ["bash", "shell", "run_shell_command", "run_terminal_cmd", "execute_command"],
};

// The one value every translation needs: the candidate is skipped when its
// schema has no matching property or the property cannot be filled.
const PRIMARY_KEYS = {
  read: ["filePath", "file_path", "path", "target_file", "file"],
  grep: ["pattern", "query", "regex"],
  ls: ["path", "dir_path", "directory", "target_directory"],
  shell: ["command", "cmd"],
};

// Secondary path-like value → property names a client tool may use instead.
const PATH_KEYS = {
  read: ["filePath", "file_path", "path", "target_file", "file"],
  grep: ["path", "dir_path", "directory", "target_directory"],
  ls: ["path", "dir_path", "directory", "target_directory"],
  // shell takes no path; its working directory maps onto workdir/cwd keys.
  shell: [],
};

const nameOf = (tool) => {
  const name = tool?.function?.name ?? tool?.name;
  return typeof name === "string" ? name : "";
};
const schemaOf = (tool) =>
  tool?.function?.parameters || tool?.parameters || tool?.input_schema || null;

/** All non-empty entries of a repeated string field; [] when absent. */
function decodeStringList(message, field) {
  return (message?.get(field) || [])
    .map((entry) => Buffer.from(entry.value).toString("utf8"))
    .filter((value) => value !== "");
}

const MAX_INT32 = 0x7fffffff;

/**
 * Non-negative varint value of a field (0 included), else null. Wrong wire
 * type, negatives and values that overflow int32 (wrapped varints) are
 * invalid, not zero.
 */
function decodeIntField(message, field) {
  const entry = message?.get(field)?.[0];
  if (entry?.wireType !== 0) return null;
  const value = Number(entry.value);
  if (!Number.isInteger(value) || value < 0 || value > MAX_INT32) return null;
  return value;
}

/** Boolean varint field; false when absent or zero. */
const decodeBoolField = (message, field) => {
  const value = decodeIntField(message, field);
  return value !== null && value !== 0;
};

/** First property from `names` present in the schema's properties, else null. */
function pickProperty(properties, names) {
  return names.find((name) => Object.hasOwn(properties, name)) || null;
}

/** JSON-schema types a JS value can satisfy. */
const kindsOf = (value) =>
  typeof value === "string"
    ? ["string"]
    : typeof value === "boolean"
      ? ["boolean"]
      : Array.isArray(value)
        ? ["array"]
        : ["integer", "number"];

/** Whether a declared property type (string, array of strings, or absent) accepts the value. */
const accepts = (declared, value) => {
  const kinds = kindsOf(value);
  const listed = Array.isArray(declared) ? declared : [declared];
  return !declared || listed.some((type) => kinds.includes(type));
};

/** True only when the schema names "array", as a string or inside a type union. */
const declaresArray = (declared) =>
  declared === "array" || (Array.isArray(declared) && declared.includes("array"));

const GREP_CASE_KEYS = ["-i", "case_insensitive", "ignore_case"];
const GREP_GLOB_KEYS = ["include", "glob"];

/**
 * Map the native request onto a declared tool. Returns null when no candidate
 * is declared with a usable schema; a candidate only wins when its primary
 * property is present and filled, every filled value matches the property's
 * declared type, and every required property is filled.
 */
function buildToolCall(native, values, tools) {
  for (const candidate of TARGETS[native]) {
    const tool = tools.find((entry) => nameOf(entry).toLowerCase() === candidate);
    const schema = tool ? schemaOf(tool) : null;
    const properties = schema?.properties;
    if (!properties || typeof properties !== "object") continue; // nothing to translate onto

    const args = {};
    const filled = new Set();
    const fill = (names, value) => {
      const property = pickProperty(properties, names);
      const usable =
        property !== null &&
        accepts(properties[property]?.type, value) &&
        value !== null &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0);
      if (!usable) return false;
      args[property] = value;
      filled.add(property);
      return true;
    };

    fill(PATH_KEYS[native], values.path);
    if (native === "read") {
      if (values.offset !== null) fill(["offset"], values.offset);
      if (values.limit !== null) fill(["limit"], values.limit);
    }
    if (native === "grep") {
      // Flags the schema cannot express must not be silently dropped.
      if (values.multiline && !fill(["multiline"], true)) continue;
      fill(PRIMARY_KEYS.grep, values.pattern);
      if (values.glob && !fill(GREP_GLOB_KEYS, values.glob)) continue;
      if (values.caseInsensitive && !fill(GREP_CASE_KEYS, true)) continue;
      fill(["output_mode"], values.outputMode);
      fill(["type"], values.type);
      fill(["-C", "context"], values.context);
      fill(["-B"], values.contextBefore);
      fill(["-A"], values.contextAfter);
      if (values.headLimit !== null) fill(["head_limit"], values.headLimit);
    }
    if (native === "ls") fill(["ignore"], values.ignore);
    if (native === "shell") {
      // Only an explicit array schema (Codex-style) gets ["bash","-lc",command].
      // An untyped command stays a string.
      const commandProperty = pickProperty(properties, PRIMARY_KEYS.shell);
      const commandType = commandProperty ? properties[commandProperty]?.type : undefined;
      fill(
        PRIMARY_KEYS.shell,
        declaresArray(commandType) ? ["bash", "-lc", values.command] : values.command,
      );
      if (values.timeout !== null) fill(["timeout"], values.timeout);
      fill(["workdir", "cwd", "working_directory", "directory"], values.workingDirectory);
      fill(["description"], values.description || values.command.slice(0, 120));
    }

    // The primary value must land somewhere (e.g. read({}) / bash({}) is not
    // a translation): present in the schema and actually filled.
    if (!PRIMARY_KEYS[native].some((name) => filled.has(name))) continue;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.every((name) => filled.has(name))) {
      return { toolName: nameOf(tool), args };
    }
  }
  return null;
}

/** Value when positive, else null (zero/negative counts are noise, not data). */
const positiveOrNull = (value) => (value !== null && value > 0 ? value : null);

/** Native args message → canonical values, or null when the request is unusable. */
function decodeNativeValues(native, message) {
  if (native === "read") {
    const path = decodeStringField(message, READ.PATH);
    if (!path) return null;
    return {
      path,
      offset: decodeIntField(message, READ.OFFSET), // >= 0; explicit 0 included
      limit: positiveOrNull(decodeIntField(message, READ.LIMIT)),
      callId: decodeStringField(message, READ.CALL_ID),
    };
  }
  if (native === "grep") {
    const pattern = decodeStringField(message, GREP.PATTERN);
    if (!pattern) return null;
    return {
      pattern,
      path: decodeStringField(message, GREP.PATH),
      glob: decodeStringField(message, GREP.GLOB),
      outputMode: decodeStringField(message, GREP.OUTPUT_MODE),
      context: positiveOrNull(decodeIntField(message, GREP.CONTEXT)),
      contextBefore: positiveOrNull(decodeIntField(message, GREP.CONTEXT_BEFORE)),
      contextAfter: positiveOrNull(decodeIntField(message, GREP.CONTEXT_AFTER)),
      caseInsensitive: decodeBoolField(message, GREP.CASE_INSENSITIVE),
      type: decodeStringField(message, GREP.TYPE),
      headLimit: positiveOrNull(decodeIntField(message, GREP.HEAD_LIMIT)),
      multiline: decodeBoolField(message, GREP.MULTILINE),
      callId: decodeStringField(message, GREP.CALL_ID),
    };
  }
  if (native === "ls") {
    const path = decodeStringField(message, LS.PATH);
    if (!path) return null;
    return {
      path,
      ignore: decodeStringList(message, LS.IGNORE),
      callId: decodeStringField(message, LS.CALL_ID),
    };
  }
  // shell / shell_stream share ShellArgs.
  const command = decodeStringField(message, SHELL.COMMAND);
  if (!command) return null;
  if (decodeBoolField(message, SHELL.IS_BACKGROUND)) return null;
  return {
    command,
    workingDirectory: decodeStringField(message, SHELL.WORKING_DIRECTORY),
    timeout: positiveOrNull(decodeIntField(message, SHELL.TIMEOUT)), // cap applied below
    description: decodeStringField(message, SHELL.DESCRIPTION),
    callId: decodeStringField(message, SHELL.CALL_ID),
  };
}

/**
 * Translate a Cursor built-in exec request into the client's own tool call.
 *
 * @param {Map} execRequest decoded agent.v1.ExecServerMessage
 * @param {Array} tools client-declared tools (OpenAI shape; bare
 *   {name, parameters|input_schema} tolerated)
 * @returns {{variant: number, toolCall: {id: string, name: string, arguments:
 *   string}, message: string}|null} null keeps the typed rejection.
 */
export function redirectNativeExec(execRequest, tools = []) {
  const variant = execVariant(execRequest);
  if (variant === null || !(variant in NATIVE_VARIANTS)) return null;
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const native = NATIVE_VARIANTS[variant];
  const values = decodeNativeValues(native, decodeMessage(execRequest.get(variant)[0].value));
  if (!values) return null;
  if (values.timeout !== null) values.timeout = Math.min(values.timeout, SHELL_TIMEOUT_CAP_MS);

  const mapped = buildToolCall(native, values, tools);
  if (!mapped) return null;

  return {
    variant,
    toolCall: {
      id: values.callId || `call_${crypto.randomUUID()}`,
      name: mapped.toolName,
      arguments: JSON.stringify(mapped.args),
    },
    // Argument values stay out of the log: they can carry commands or secrets.
    message: `AgentService redirected native exec variant=${variant} (${native}) -> ${mapped.toolName}`,
  };
}
