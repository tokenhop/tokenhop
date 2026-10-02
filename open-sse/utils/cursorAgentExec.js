/**
 * Cursor AgentService exec protocol: agent.v1.ExecServerMessage → ExecClientMessage.
 *
 * AgentService is trained for the Cursor IDE and asks the client to run built-in
 * tools (shell, read, grep, …) even when the request declares MCP tools. tokenhop
 * has no IDE, so every built-in gets a typed rejection and the model falls back
 * to the declared MCP tools or a text answer. Unknown variants get an empty
 * result instead of aborting the turn.
 *
 * Field numbers come from agent.proto (can1357/oh-my-pi, mirrored by
 * enderzcx/cursor-agent2api, 2026-09).
 */
import {
  encodeField,
  decodeMessage,
  decodeStringField,
  wrapConnectRPCFrame,
  concatArrays,
  encodeMcpToolDefinition,
  encodeMcpResultError,
  CURSOR_MCP_PROVIDER,
} from "./cursorProtobuf.js";

const VARINT = 0;
const LEN = 2;

// ExecServerMessage fields outside the tool oneof: id, exec_id, span_context and
// accept_hook_additional_contexts. ExecClientMessage echoes only id and exec_id.
const EXEC_ID = 1;
const EXEC_EXEC_ID = 15;
const EXEC_ENVELOPE_FIELDS = new Set([EXEC_ID, EXEC_EXEC_ID, 19, 55]);

// AgentClientMessage.exec_client_message
const AGENT_CLIENT_EXEC = 2;

export const EXEC_VARIANT = { REQUEST_CONTEXT: 10, MCP: 11, MCP_STATE: 36 };

export const EXEC_REJECT_REASON =
  "Tool not available in this environment. Use the MCP tools provided instead.";

// There is no proto flag that stops AgentService from reaching for built-ins,
// so say it in the prompt and in the MCP server instructions.
export const AGENT_ENVIRONMENT_NOTE =
  "Environment: this session is not running inside an IDE. Built-in IDE tools " +
  "(shell, file read/write/edit/delete, grep, ls, fetch) are unavailable and will be " +
  "rejected. Use only the tools provided in this request; if none are provided, answer directly.";

/**
 * Built-in variant (ExecServerMessage oneof field) → where its rejection goes:
 * ExecClientMessage result field, the result's oneof case, and the reason field
 * inside that case. Results without a `rejected` case use `error`/`failure`.
 * Entries without a case send an empty result (allowlist prechecks → false).
 */
const rejectAs = (result, caseField, reasonField) => ({ result, caseField, reasonField });
const EXEC_REJECTIONS = {
  2: rejectAs(2, 4, 3), // shell → ShellResult.rejected
  3: rejectAs(3, 6, 2), // write → WriteResult.rejected
  4: rejectAs(4, 6, 2), // delete → DeleteResult.rejected
  5: rejectAs(5, 2, 1), // grep → GrepResult.error (no rejected case)
  7: rejectAs(7, 3, 2), // read → ReadResult.rejected
  8: rejectAs(8, 3, 2), // ls → LsResult.rejected
  9: rejectAs(9, 3, 2), // diagnostics → DiagnosticsResult.rejected
  14: rejectAs(14, 5, 3), // shell_stream → ShellStream.rejected
  16: rejectAs(16, 3, 3), // background_shell_spawn → rejected (ShellRejected)
  17: rejectAs(17, 3, 1), // list_mcp_resources → rejected
  18: rejectAs(18, 3, 2), // read_mcp_resource → rejected
  20: rejectAs(20, 2, 2), // fetch → FetchResult.error
  21: rejectAs(21, 4, 1), // record_screen → failure
  22: rejectAs(22, 2, 1), // computer_use → error
  23: rejectAs(23, 2, 1), // write_shell_stdin → error
  27: { result: 27 }, // execute_hook (no error case)
  28: rejectAs(28, 2, 2), // subagent → error
  29: rejectAs(29, 3, 2), // redacted_read → ReadResult.rejected
  30: { result: 30 }, // force_background_shell (no error case)
  31: { result: 31 }, // force_background_subagent (no error case)
  37: rejectAs(37, 4, 2), // subagent_await → error
  38: rejectAs(38, 2, 1), // smart_mode_classifier → error
  40: rejectAs(40, 2, 2), // canvas_diagnostics → error
  41: { result: 41 }, // shell_allowlist_precheck
  42: { result: 42 }, // mcp_allowlist_precheck
  43: { result: 43 }, // web_fetch_allowlist_precheck
  44: { result: 44 }, // git_diff (no error case)
  // pi_* result fields are shifted by one from their args fields.
  45: rejectAs(46, 2, 1), // pi_read → error
  46: rejectAs(47, 2, 1), // pi_bash → error
  47: rejectAs(48, 3, 1), // pi_edit → rejected
  48: rejectAs(49, 3, 1), // pi_write → rejected
  49: rejectAs(50, 2, 1), // pi_grep → error
  50: rejectAs(51, 2, 1), // pi_find → error
  51: rejectAs(52, 2, 1), // pi_ls → error
  52: rejectAs(55, 4, 3), // mini_swe_agent_bash → ShellResult.rejected
  53: rejectAs(53, 2, 1), // conversation_search → error
  54: rejectAs(54, 2, 1), // agent_store_conflict → error
};

const isKnownVariant = (field) =>
  field in EXEC_REJECTIONS || Object.values(EXEC_VARIANT).includes(field);

/**
 * The tool variant of an ExecServerMessage: a message field outside the
 * envelope, preferring a known variant over a field this table doesn't know.
 */
export function execVariant(execRequest) {
  const candidates = [...(execRequest || [])]
    .filter(([field, entries]) => !EXEC_ENVELOPE_FIELDS.has(field) && entries[0]?.wireType === LEN)
    .map(([field]) => field);
  return candidates.find(isKnownVariant) ?? candidates[0] ?? null;
}

function wrapExecClientMessage(execRequest, resultField, resultPayload) {
  const id = Number(execRequest?.get(EXEC_ID)?.[0]?.value || 0);
  const execId = decodeStringField(execRequest, EXEC_EXEC_ID);
  const parts = [];
  if (id) parts.push(encodeField(EXEC_ID, VARINT, id));
  parts.push(encodeField(EXEC_EXEC_ID, LEN, execId));
  parts.push(encodeField(resultField, LEN, resultPayload));
  return wrapConnectRPCFrame(encodeField(AGENT_CLIENT_EXEC, LEN, concatArrays(...parts)));
}

// RequestContextResult.success with an empty RequestContext. Tools already go
// out on AgentRunRequest.mcp_tools; echoing them here stalls the stream.
function requestContextResult() {
  return encodeField(1, LEN, encodeField(1, LEN, new Uint8Array()));
}

// McpStateExecResult.success → McpStateServer for the declared client tools.
function mcpStateResult(tools) {
  const server = concatArrays(
    encodeField(1, LEN, CURSOR_MCP_PROVIDER), // server_name
    encodeField(2, LEN, CURSOR_MCP_PROVIDER), // server_identifier
    ...tools.map((tool) => encodeField(5, LEN, encodeMcpToolDefinition(tool))),
    encodeField(
      6, // instructions → McpInstructions
      LEN,
      concatArrays(
        encodeField(1, LEN, CURSOR_MCP_PROVIDER),
        encodeField(2, LEN, AGENT_ENVIRONMENT_NOTE),
        encodeField(3, LEN, CURSOR_MCP_PROVIDER),
      ),
    ),
  );
  return encodeField(1, LEN, encodeField(1, LEN, server));
}

function rejectionResult(caseField, reasonField) {
  if (!caseField) return new Uint8Array();
  return encodeField(caseField, LEN, encodeField(reasonField, LEN, EXEC_REJECT_REASON));
}

function requestedMcpServers(execRequest) {
  const args = execRequest.get(EXEC_VARIANT.MCP_STATE)[0].value;
  return (decodeMessage(args).get(1) || [])
    .map((entry) => Buffer.from(entry.value).toString("utf8"))
    .join(",");
}

/**
 * Build the reply to a non-tool-call exec request. MCP calls that carry a tool
 * name are client tool calls and must be handled by the caller first.
 *
 * @returns {{frame: Uint8Array, variant: number, level: "info"|"warn", message: string}|null}
 *   null when the request has no tool variant at all (nothing to reply to).
 */
export function buildExecReply(execRequest, { tools = [] } = {}) {
  const variant = execVariant(execRequest);
  if (variant === null) return null;
  const fields = [...execRequest.keys()].join(",");
  const reply = (resultField, payload, level, message) => ({
    frame: wrapExecClientMessage(execRequest, resultField, payload),
    variant,
    level,
    message: `AgentService ${message}`,
  });

  if (variant === EXEC_VARIANT.REQUEST_CONTEXT) {
    return reply(variant, requestContextResult(), "info", "request_context ack");
  }
  if (variant === EXEC_VARIANT.MCP_STATE) {
    return reply(
      variant,
      mcpStateResult(tools),
      "info",
      `mcp_state reply tools=${tools.length} requested=${requestedMcpServers(execRequest)}`,
    );
  }
  if (variant === EXEC_VARIANT.MCP) {
    return reply(
      variant,
      encodeMcpResultError("MCP tool call is missing a tool name"),
      "warn",
      `rejected MCP exec without a tool name variant=${variant} fields=${fields}`,
    );
  }
  const known = EXEC_REJECTIONS[variant];
  if (known) {
    return reply(
      known.result,
      rejectionResult(known.caseField, known.reasonField),
      "info",
      `rejected IDE exec variant=${variant} fields=${fields}`,
    );
  }
  // Unknown result shape: an empty result always parses and unblocks the turn.
  return reply(
    variant,
    new Uint8Array(),
    "warn",
    `rejected unrecognized IDE exec variant=${variant} fields=${fields}`,
  );
}
