// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
import { FORMATS } from "../formats.js";

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Filter an array of content blocks; drop unsupported, inject one placeholder per kind.
// isLast = block belongs to the current user turn (picks the explanatory placeholder).
function filterBlocks(blocks, capOf, caps, removed, isLast) {
  const out = [];
  for (const block of blocks) {
    const cap = capOf(block);
    if (cap && caps[cap] === false) {
      removed.add(cap);
      continue;
    }
    out.push(block);
  }
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast) });
  return out;
}

const isImageAttachment = (a) =>
  a?.contentType?.startsWith("image/") ||
  (typeof a?.url === "string" && a.url.startsWith("data:image/"));

// Map a list to new items without touching the caller's objects: stripFn returns
// a replacement item, or the same reference when nothing changed.
// Combo/account fallback attempts share nested messages via a shallow body copy,
// so mutating them would strip media from later (vision-capable) attempts too.
const mapItems = (list, stripFn) => {
  const last = list.length - 1;
  return list.map((item, i) => stripFn(item, i === last));
};

// OpenAI / OpenAI-compatible chat messages[].content[].
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  body.messages = mapItems(body.messages, (msg, isLast) => {
    if (!msg || typeof msg !== "object") return msg;
    const next = { ...msg };
    if (caps.vision === false) {
      if (Array.isArray(next.images)) delete next.images;
      if (Array.isArray(next.experimental_attachments)) {
        next.experimental_attachments = next.experimental_attachments.filter(
          (a) => !isImageAttachment(a),
        );
      }
      if (Array.isArray(next.attachments)) {
        next.attachments = next.attachments.filter((a) => !isImageAttachment(a));
      }
    }
    if (Array.isArray(next.content)) {
      next.content = filterBlocks(next.content, capForOpenAIBlock, caps, new Set(), isLast);
    }
    return next;
  });
}

// Claude messages[].content[]. Images returned by a tool sit inside
// tool_result.content[] and are filtered the same way (YAN-664).
function stripClaudeBlocks(blocks, caps, isLast) {
  const nested = blocks.map((block) =>
    block?.type === "tool_result" && Array.isArray(block.content)
      ? {
          ...block,
          content: filterBlocks(block.content, capForClaudeBlock, caps, new Set(), isLast),
        }
      : block,
  );
  return filterBlocks(nested, capForClaudeBlock, caps, new Set(), isLast);
}

function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  body.messages = mapItems(body.messages, (msg, isLast) =>
    Array.isArray(msg?.content)
      ? { ...msg, content: stripClaudeBlocks(msg.content, caps, isLast) }
      : msg,
  );
}

// OpenAI Responses input[].content[] (input_image / input_file).
function stripResponsesParts(parts, caps, isLast) {
  const removed = new Set();
  const out = parts.filter((b) => {
    const cap = b?.type === "input_image" ? "vision" : b?.type === "input_file" ? "pdf" : null;
    if (cap && caps[cap] === false) {
      removed.add(cap);
      return false;
    }
    return true;
  });
  for (const cap of removed) out.push({ type: "input_text", text: ph(cap, isLast) });
  return out;
}

function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  body.input = mapItems(body.input, (item, isLast) => {
    // Tool-returned media lives in function_call_output.output[] (YAN-664).
    if (item?.type === "function_call_output" && Array.isArray(item.output)) {
      return { ...item, output: stripResponsesParts(item.output, caps, isLast) };
    }
    if (!Array.isArray(item?.content)) return item;
    return { ...item, content: stripResponsesParts(item.content, caps, isLast) };
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
// Returns a new contents array (or the input when it isn't an array).
function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return contents;
  return mapItems(contents, (c, isLast) => {
    if (!Array.isArray(c?.parts)) return c;
    const removed = new Set();
    const parts = c.parts.filter((p) => {
      const mime = p?.inlineData?.mimeType || p?.fileData?.mimeType;
      const cap = capForMime(mime);
      if (cap && caps[cap] === false) {
        removed.add(cap);
        return false;
      }
      return true;
    });
    for (const cap of removed) parts.push({ text: ph(cap, isLast) });
    return { ...c, parts };
  });
}

/**
 * Remove media blocks the model can't read from the source-format body.
 * Reassigns top-level fields (messages/input/contents/request) on `body` with
 * new arrays/objects; nested objects shared with the caller are never mutated.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Fast exit: model supports everything we'd strip.
  if (caps.vision !== false && caps.audioInput !== false && caps.pdf !== false) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      if (Array.isArray(body.contents)) body.contents = stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      if (Array.isArray(body.request?.contents)) {
        body.request = { ...body.request, contents: stripGeminiParts(body.request.contents, caps) };
      }
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
